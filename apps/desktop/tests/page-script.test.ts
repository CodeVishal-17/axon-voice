/**
 * How a page program and its arguments are combined.
 *
 * `buildProgram` is the single place in Axon where a value meets code that
 * will run inside a web page, which makes it the file to be paranoid about.
 * Two properties matter, and both have already failed once:
 *
 * 1. It must produce a program that RETURNS. The first version wrote
 *    `return\n(() => {...})()`, which automatic semicolon insertion turns into
 *    `return;` — so every observation came back empty, silently, with no error
 *    anywhere. Nothing surfaced it except reading a real page and getting
 *    nothing back.
 *
 * 2. A hostile value must not be able to become a statement. Arguments arrive
 *    as a JSON literal in argument position, and the two characters that are
 *    legal in JSON but terminate a line in JavaScript are escaped.
 */

import { describe, expect, it } from 'vitest';
import { buildProgram, CLICK, literal, OBSERVE, SCROLL, TYPE } from '../src/main/browser/page-script.js';

/**
 * Run a built program the way the page would.
 *
 * `new Function` here is the test standing in for the page's evaluator; it is
 * how the property "this program returns a value" gets checked at all. The
 * product never does this — see `architecture.test.ts`, which asserts that
 * `executeJavaScript` appears in exactly one module.
 */
function evaluate(program: string): unknown {
  return new Function(`return (${program});`)();
}

describe('building a program', () => {
  it('returns the value of its body', () => {
    // The regression. A program that parses but returns undefined is the
    // worst kind of failure: everything downstream reports success.
    const program = buildProgram('\n(() => 42)()\n', {});
    expect(evaluate(program)).toBe(42);
  });

  it('passes arguments in argument position', () => {
    const program = buildProgram('\n(() => ARGS.value)()\n', { value: 'hello' });
    expect(evaluate(program)).toBe('hello');
  });

  it('gives every real program something to return', () => {
    // Each of the four is wrapped the same way, so the ASI trap either affects
    // all of them or none. Asserting the shape catches a body that gets
    // reformatted later.
    for (const body of [OBSERVE, CLICK, TYPE, SCROLL]) {
      const program = buildProgram(body, { ref: 'e1', text: '', pages: 1 });
      expect(program).toContain('return (');
      expect(program).not.toMatch(/return\s*\n/);
    }
  });
});

describe('a hostile argument cannot become code', () => {
  const escapes = [
    ['a quote', '"'],
    ['a backslash', '\\'],
    ['a closing brace', '}'],
    ['a script tag', '</script><script>alert(1)</script>'],
    ['an IIFE', '"); alert(1); ("'],
    ['a template literal', '${process.exit(1)}'],
    ['a newline', 'a\nb'],
    ['a null byte', 'a\u0000b'],
    ['a line separator', 'a\u2028b'],
    ['a paragraph separator', 'a\u2029b'],
  ] as const;

  it.each(escapes)('survives %s as a string, unchanged', (_label, value) => {
    const program = buildProgram('\n(() => ARGS.text)()\n', { text: value });
    // It parses, it runs, and what comes back is the string that went in.
    expect(evaluate(program)).toBe(value);
  });

  it('escapes the two characters JSON allows but JavaScript treats as newlines', () => {
    // U+2028 and U+2029 are legal inside a JSON string and are line
    // terminators in JavaScript source, so a value containing one would end
    // the literal early. Page text absolutely contains them.
    const encoded = literal({ text: 'before\u2028after' });
    // The raw character is gone; the six-character escape is in its place, so
    // what reaches the page is a string rather than a broken literal.
    expect(encoded).not.toContain('\u2028');
    expect(encoded).toContain('\\u2028');
  });

  it('cannot be made to run a statement', () => {
    const attempts = [
      '"} ); process.exit(1); ({"',
      '\\"); require("child_process").execSync("calc"); ("',
      '`+process.env.ANTHROPIC_API_KEY+`',
    ];
    for (const attempt of attempts) {
      const program = buildProgram('\n(() => ARGS.text)()\n', { text: attempt });
      // The value comes back as itself. If any of it had been parsed as code,
      // this would either throw or return something else.
      expect(evaluate(program)).toBe(attempt);
    }
  });
});

describe('the programs themselves are constants', () => {
  it('contain no interpolation', () => {
    for (const body of [OBSERVE, CLICK, TYPE, SCROLL]) {
      // A `${` inside a program body would mean something was interpolated
      // into code that then runs in a page.
      expect(body).not.toContain('${');
    }
  });

  it('refuse a password field from inside the page as well', () => {
    // The second of the three independent refusals. The risk policy is the
    // first; the executor is the third.
    expect(TYPE).toContain("type === 'password'");
    expect(CLICK).toContain("type === 'password'");
  });

  it('escape any reference before putting it in a selector', () => {
    for (const body of [CLICK, TYPE]) {
      expect(body).toContain('CSS.escape(ARGS.ref)');
    }
  });
});
