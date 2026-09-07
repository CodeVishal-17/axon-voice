import type { JsonObject } from '@axon/core';

/**
 * The complete set of programs Axon runs inside a web page.
 *
 * SECURITY — read before editing.
 *
 * These are MODULE CONSTANTS. Nothing is interpolated into any of them: not a
 * selector, not a URL, not a label, and above all not anything the model
 * produced. Reading this file tells you the entire body of JavaScript Axon
 * will ever execute in a page, for any request, forever.
 *
 * That is the property that makes browser automation tractable to secure. The
 * obvious design — let the model send a selector, or a snippet, and evaluate
 * it — turns the model into an author of code running against the user's
 * logged-in sessions. There is no amount of validation that makes that safe,
 * so it is not offered: the model's entire vocabulary for touching a page is a
 * reference number Axon minted for an element Axon already found.
 *
 * Arguments do reach these programs, and it is worth being exact about how.
 * `buildProgram` at the foot of this file is the ONE place a program and its
 * arguments are combined, and it does not concatenate them into code: the
 * body is placed inside a function and the arguments are passed to it as a
 * single JSON literal in argument position. A hostile value can therefore
 * become a strange string, but it cannot become a statement. `literal` handles
 * the two characters that would otherwise escape a JavaScript string literal
 * even after `JSON.stringify`.
 *
 * On top of that, every argument has already passed a Zod schema in the
 * dispatcher and been bounded: a ref matches `^e[0-9]{1,4}$`, and text is
 * length-capped and stripped of control characters.
 *
 * HOW ELEMENT REFERENCES WORK.
 *
 * `OBSERVE` walks the visible, interactive elements and stamps each with a
 * `data-axon-ref` attribute. `CLICK` and `TYPE` look an element up by that
 * attribute. A reference is therefore only ever valid for the page Axon last
 * read, and a navigation invalidates every one of them — which is correct:
 * acting on a stale reference is exactly the bug where an agent clicks the
 * wrong thing because the page changed underneath it.
 */

/**
 * Read the page.
 *
 * Returns visible text and a bounded list of interactive elements. Deliberate
 * omissions: no HTML, no markup, no scripts, no styles, no attributes beyond
 * the few named below. The model is given a description of a page, not a page.
 */
export const OBSERVE = `
(() => {
  const LIMITS = ARGS;

  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const clean = (value) =>
    String(value == null ? '' : value)
      .replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();

  // The accessible name, in the order a screen reader would resolve it. This
  // is what a person would say they were clicking, which is what the risk
  // policy needs in order to classify the click.
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const target = document.getElementById(labelled);
      if (target) return clean(target.innerText || target.textContent);
    }
    // Form fields are named the way a person reads them: an associated
    // <label>, then an enclosing one, then the button's own value, then the
    // placeholder. A field with only a placeholder is extremely common — a
    // comment box usually has nothing else — and one that goes unnamed here is
    // one Axon cannot see at all, because unnamed elements are skipped.
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (label) return clean(label.innerText || label.textContent);
      }
      const closest = el.closest('label');
      if (closest) return clean(closest.innerText || closest.textContent);
      const value = el.getAttribute('value');
      if (value && (el.type === 'submit' || el.type === 'button')) return clean(value);
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return clean(placeholder);
      const name = el.getAttribute('name');
      if (name) return clean(name);
    }
    const title = el.getAttribute('title');
    const text = clean(el.innerText || el.textContent);
    return text || clean(title) || '';
  };

  const roleOf = (el) => {
    const tag = el.tagName;
    const explicit = (el.getAttribute('role') || '').toLowerCase();
    if (explicit === 'button' || explicit === 'link' || explicit === 'checkbox' || explicit === 'radio') {
      return explicit;
    }
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'other';
  };

  // Fields Axon must never type into, recognised from the page's own
  // declarations rather than from guesswork about the label.
  const isSensitive = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/password|cc-|credit|one-time-code|otp/.test(autocomplete)) return true;
    const name = ((el.getAttribute('name') || '') + ' ' + (el.getAttribute('id') || '')).toLowerCase();
    if (/password|passwd|otp|mfa|2fa|totp|cvv|cvc|cardnum|card-number|ssn/.test(name)) return true;
    return false;
  };

  const submits = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'BUTTON' && (type === '' || type === 'submit')) return Boolean(el.closest('form'));
    if (el.tagName === 'INPUT' && (type === 'submit' || type === 'image')) return true;
    return false;
  };

  const SELECTOR = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]';

  // Clear stamps from a previous observation so references cannot survive a
  // page change and address a different element than the one described.
  for (const stale of document.querySelectorAll('[data-axon-ref]')) {
    stale.removeAttribute('data-axon-ref');
  }

  const elements = [];
  let index = 0;
  let elementsTruncated = false;

  for (const el of document.querySelectorAll(SELECTOR)) {
    if (elements.length >= LIMITS.maxElements) { elementsTruncated = true; break; }
    if (el.disabled) continue;
    if (!isVisible(el)) continue;

    const role = roleOf(el);
    const label = nameOf(el).slice(0, LIMITS.maxLabelCharacters);
    const href = el.tagName === 'A' ? (el.href || null) : null;

    // An element with no name and no destination cannot be described to a
    // person, so it cannot be approved by one either. Skip it.
    if (label === '' && !href) continue;

    index += 1;
    const ref = 'e' + index;
    el.setAttribute('data-axon-ref', ref);

    const isTextField = role === 'textbox';
    elements.push({
      ref,
      role,
      label,
      href: href ? String(href).slice(0, LIMITS.maxUrlCharacters) : null,
      sensitive: isSensitive(el),
      submits: submits(el),
      value: isTextField ? clean(el.value != null ? el.value : el.innerText).slice(0, LIMITS.maxLabelCharacters) : null,
    });
  }

  const bodyText = clean(document.body ? document.body.innerText : '');
  const textTruncated = bodyText.length > LIMITS.maxTextCharacters;

  return {
    url: String(document.location.href).slice(0, LIMITS.maxUrlCharacters),
    title: clean(document.title).slice(0, LIMITS.maxLabelCharacters),
    text: bodyText.slice(0, LIMITS.maxTextCharacters),
    textTruncated,
    elements,
    elementsTruncated,
    loading: document.readyState !== 'complete',
  };
})()
`;

/**
 * Click an element Axon previously described.
 *
 * Takes a reference, never a selector. Returns a structured outcome rather
 * than throwing, so "that element is gone" reaches the model as something it
 * can act on — by reading the page again — rather than as an exception.
 */
export const CLICK = `
(() => {
  const el = document.querySelector('[data-axon-ref="' + CSS.escape(ARGS.ref) + '"]');
  if (!el) return { ok: false, reason: 'not-found' };

  // Refuse from inside the page as well as from the policy outside it. Two
  // independent checks, because this one still holds if a future caller
  // forgets the other.
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return { ok: false, reason: 'sensitive' };

  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { ok: true, reason: null };
})()
`;

/**
 * Type into a text field Axon previously described.
 *
 * Sets the value and dispatches the input and change events a page listens
 * for, so frameworks see the text the way they would see a person's typing.
 * Refuses password and payment fields outright — Axon does not handle
 * credentials, and this is the second of the two places that is enforced.
 */
export const TYPE = `
(() => {
  const el = document.querySelector('[data-axon-ref="' + CSS.escape(ARGS.ref) + '"]');
  if (!el) return { ok: false, reason: 'not-found' };

  const type = (el.getAttribute('type') || '').toLowerCase();
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (type === 'password' || /password|cc-|one-time-code|otp/.test(autocomplete)) {
    return { ok: false, reason: 'sensitive' };
  }

  const editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  if (!editable && !el.isContentEditable) return { ok: false, reason: 'not-editable' };

  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();

  if (editable) {
    // Through the native setter so React and similar frameworks, which track
    // the value they last rendered, observe the change.
    const prototype = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (setter && setter.set) setter.set.call(el, ARGS.text);
    else el.value = ARGS.text;
  } else {
    el.textContent = ARGS.text;
  }

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  return { ok: true, reason: null };
})()
`;

/** Scroll the page by whole viewports. No element reference, no coordinates. */
export const SCROLL = `
(() => {
  const before = window.scrollY;
  window.scrollBy({ top: window.innerHeight * ARGS.pages, behavior: 'instant' });
  return { ok: true, from: before, to: window.scrollY, height: document.body ? document.body.scrollHeight : 0 };
})()
`;

/**
 * Combine a program with its arguments.
 *
 * The one place in Axon where a page program and a value meet, and the reason
 * the programs above can be called constants. The body goes inside a function;
 * the arguments arrive as that function's parameter. Nothing from a caller is
 * ever placed where the parser expects a statement.
 */
export function buildProgram(body: string, args: JsonObject): string {
  // The parentheses around the body are load-bearing. Each program above
  // begins on a new line, and a `return` followed by a line break triggers
  // automatic semicolon insertion: the function then returns undefined,
  // silently, and every observation comes back empty with no error anywhere.
  // Wrapping the body keeps the expression attached to its `return`.
  return `(function (ARGS) { return (${body}); })(${literal(args)})`;
}

/**
 * A JSON value as a JavaScript literal.
 *
 * `JSON.stringify` is not quite enough on its own: U+2028 and U+2029 are legal
 * inside a JSON string but are line terminators in JavaScript source, so a
 * value containing one would end the literal early. Page text can absolutely
 * contain them.
 */
export function literal(value: JsonObject): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
