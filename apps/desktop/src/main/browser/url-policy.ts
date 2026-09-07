/**
 * URL classification.
 *
 * This is the whole of the browser's navigation judgement, kept pure and
 * separate from anything that can navigate, so it can be tested exhaustively
 * without opening a window. `paths.ts` does the same job for the filesystem,
 * and the shape is deliberately parallel:
 *
 *   ordinary public http(s)   -> SAFE
 *   an unusual port           -> REQUIRES_APPROVAL
 *   loopback / private / link-local -> FORBIDDEN
 *   any other scheme          -> FORBIDDEN
 *   unrepresentable           -> INVALID (the caller escalates)
 *
 * WHY PRIVATE ADDRESSES ARE FORBIDDEN RATHER THAN APPROVABLE.
 *
 * A browser that will fetch any URL a model produces is a network scanner and
 * an SSRF primitive: `http://192.168.1.1/`, `http://localhost:8080/admin`, and
 * `http://169.254.169.254/` (the cloud metadata address, which on many hosts
 * returns credentials to anything that asks) are all one generated string
 * away. None of them is a page a person asked Axon to read, and an approval
 * dialog is the wrong defence — the user cannot be expected to know that a
 * link-local address is a credential endpoint. So they are refused outright,
 * and a future feature that genuinely needs a local service adds an explicit
 * allowlist here rather than relaxing this rule.
 *
 * WHAT THIS CANNOT DO, STATED PLAINLY.
 *
 * It classifies the URL as written. It does not resolve DNS, so a hostname
 * that resolves to a private address — deliberately, as in a DNS-rebinding
 * attack — is not caught here. That is why the browser window ALSO applies
 * this policy to every navigation and redirect it is asked to perform, at the
 * moment it performs it, and why the window has no Node access to escalate
 * with even if it reached somewhere unexpected.
 */

import type { RiskAssessment } from '@axon/core';
import { BROWSING_LIMITS } from '@axon/core';

export type UrlClass = 'PUBLIC' | 'UNUSUAL_PORT' | 'PRIVATE' | 'FORBIDDEN_SCHEME' | 'INVALID';

export interface UrlClassification {
  readonly class: UrlClass;
  /** Normalized absolute URL. Null when the input could not be parsed. */
  readonly normalized: string | null;
  /** Hostname, lowercased. Null when unparseable. */
  readonly host: string | null;
  readonly reason: string;
}

/** The only two schemes Axon will ever navigate to. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Control characters, refused anywhere in a URL.
 *
 * Built with `new RegExp` from an escape string rather than written as a
 * literal: a regex literal containing real control characters is a source file
 * that tools report as binary and that no reviewer can read.
 */
// The point of this pattern is to FIND control characters in a URL, which
// is where request smuggling starts. The rule guards against putting them
// in by accident; here they are the subject.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = new RegExp('[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E]');

/** Ports that need no explanation. Anything else is a question worth asking. */
const ORDINARY_PORTS = new Set(['', '80', '443']);

/**
 * Hostnames that always mean "this machine", whatever DNS says.
 *
 * `.localhost` is reserved for loopback by RFC 6761; `.local` is mDNS, which
 * is by definition the local network.
 */
function isLocalHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  );
}

/**
 * True for an IPv4 literal in a range that is not the public internet.
 *
 * Covers loopback (127/8), the three RFC 1918 private ranges, link-local
 * (169.254/16 — including the cloud metadata address), carrier-grade NAT
 * (100.64/10), "this network" (0/8), and multicast/reserved space above 224.
 */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => {
    // Reject anything that is not plain decimal: `0x7f.0.0.1` and `0177.0.0.1`
    // are both loopback to a resolver, and both would slip past a naive parse.
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number.parseInt(part, 10);
  });

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

  const [a = 0, b = 0] = octets;

  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast and reserved

  return false;
}

/** True for an IPv6 literal that is loopback, link-local, or unique-local. */
function isPrivateIPv6(host: string): boolean {
  // URL parsing gives IPv6 hosts in brackets.
  const inner = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const lower = inner.toLowerCase();

  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique-local fc00::/7

  // IPv4-mapped addresses reach the same host by another spelling, and the URL
  // parser rewrites the readable form into hex before we ever see it:
  // `[::ffff:127.0.0.1]` arrives as `[::ffff:7f00:1]`. Both forms are decoded
  // here, because a check that only recognised the dotted one would pass
  // loopback straight through.
  if (lower.startsWith('::ffff:')) {
    const suffix = lower.slice('::ffff:'.length);

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(suffix)) return isPrivateIPv4(suffix);

    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(suffix);
    if (hex?.[1] && hex[2]) {
      const high = Number.parseInt(hex[1], 16);
      const low = Number.parseInt(hex[2], 16);
      const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
      return isPrivateIPv4(dotted);
    }

    // An `::ffff:` address we cannot decode is not one we are confident is
    // public, and this function's answer feeds a refusal rather than a grant.
    return true;
  }

  return false;
}

/**
 * Classify a URL the model, or a page, produced.
 *
 * Never throws: an unparseable URL is a classification, not an exception, so
 * every caller gets an answer it can act on.
 */
export function classifyUrl(raw: unknown): UrlClassification {
  if (typeof raw !== 'string') {
    return { class: 'INVALID', normalized: null, host: null, reason: 'The URL was not a string.' };
  }

  const trimmed = raw.trim();

  if (trimmed === '') {
    return { class: 'INVALID', normalized: null, host: null, reason: 'The URL was empty.' };
  }
  if (trimmed.length > BROWSING_LIMITS.maxUrlCharacters) {
    return {
      class: 'INVALID',
      normalized: null,
      host: null,
      reason: `The URL is longer than ${BROWSING_LIMITS.maxUrlCharacters} characters.`,
    };
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    // A newline or a NUL in a URL is how header- and protocol-smuggling
    // starts, and neither can appear in an address a person meant to visit.
    return { class: 'INVALID', normalized: null, host: null, reason: 'The URL contains control characters.' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      class: 'INVALID',
      normalized: null,
      host: null,
      reason: 'The URL could not be parsed. Give a full address including https://.',
    };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    // javascript:, data:, file:, blob:, about:, chrome:, ms-settings: and
    // every custom protocol land here. Refused as a class rather than
    // enumerated as a blocklist — a blocklist of schemes is a list you will
    // one day forget to add to.
    return {
      class: 'FORBIDDEN_SCHEME',
      normalized: null,
      host: url.hostname.toLowerCase() || null,
      reason: `Axon only opens http and https addresses, and this one is "${url.protocol.replace(':', '')}".`,
    };
  }

  const host = url.hostname.toLowerCase();

  if (host === '') {
    return { class: 'INVALID', normalized: null, host: null, reason: 'The URL has no host.' };
  }

  // Credentials in the URL (https://user:pass@host) are a way to smuggle a
  // secret into a place it will be logged. Refuse the shape entirely.
  if (url.username !== '' || url.password !== '') {
    return {
      class: 'INVALID',
      normalized: null,
      host,
      reason: 'URLs carrying a username or password are not permitted.',
    };
  }

  if (isLocalHostname(host) || isPrivateIPv4(host) || isPrivateIPv6(host)) {
    return {
      class: 'PRIVATE',
      normalized: null,
      host,
      reason: `${host} is on this machine or this private network, which Axon does not browse.`,
    };
  }

  // Normalized: the parsed form, not the string the caller wrote. Whatever
  // encoding tricks were in the original, what is navigated to is this.
  const normalized = url.toString();

  if (!ORDINARY_PORTS.has(url.port)) {
    return {
      class: 'UNUSUAL_PORT',
      normalized,
      host,
      reason: `${host} on port ${url.port} is not a normal web address, so Axon will ask first.`,
    };
  }

  return { class: 'PUBLIC', normalized, host, reason: `${url.origin} is an ordinary public web address.` };
}

/** The risk verdict for navigating to a URL. */
export function navigationRisk(raw: unknown): RiskAssessment {
  const verdict = classifyUrl(raw);

  switch (verdict.class) {
    case 'PUBLIC':
      return { level: 'SAFE', reason: `Opening ${verdict.normalized} only reads a public web page.` };
    case 'UNUSUAL_PORT':
      return { level: 'REQUIRES_APPROVAL', reason: verdict.reason };
    case 'PRIVATE':
    case 'FORBIDDEN_SCHEME':
      return { level: 'FORBIDDEN', reason: verdict.reason };
    case 'INVALID':
      // Cannot be classified, so cannot be called safe.
      return { level: 'REQUIRES_APPROVAL', reason: `Risk could not be determined: ${verdict.reason}` };
    default: {
      const exhaustive: never = verdict.class;
      return { level: 'REQUIRES_APPROVAL', reason: `Unhandled URL classification: ${String(exhaustive)}` };
    }
  }
}

/**
 * Whether a navigation may proceed at all.
 *
 * Used by the browser window itself, on every navigation and redirect it is
 * asked to perform — including ones a page started, which never went near a
 * tool. It is the reason a redirect to `file:///` or to `169.254.169.254`
 * fails even though no tool call mentioned either.
 */
export function isNavigable(raw: unknown): boolean {
  const verdict = classifyUrl(raw);
  return verdict.class === 'PUBLIC' || verdict.class === 'UNUSUAL_PORT';
}
