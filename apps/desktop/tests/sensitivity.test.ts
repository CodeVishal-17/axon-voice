/**
 * Four classes, not one boolean.
 *
 * THE BUG THIS FILE IS ABOUT. A live voice test asked Axon about an email
 * address, and Axon described it as forbidden sensitive data it could not
 * touch. That is wrong twice over: it is not true, and it teaches the user
 * that Axon's refusals are noise — so the next refusal, the one about an API
 * key, gets read the same way.
 *
 * The fix is not "allow more". It is to stop having one undifferentiated
 * notion of "sensitive", and these tests pin both ends of that:
 *
 *   PERSONAL must NOT behave like SECRET. An email address is storable,
 *   speakable, typeable, and marked.
 *   SECRET must not have loosened by a single case. Every credential shape
 *   that was refused before is still refused, everywhere it was refused.
 */

import { describe, expect, it } from 'vitest';
import {
  DESTRUCTIVE_PHRASES,
  OUTWARD_PHRASES,
  SENSITIVITY_CLASSES,
  classifyActionLabel,
  classifyText,
  escalateSensitivity,
  isSecretText,
  riskFloorFor,
} from '@axon/core';
import { containsSecret, redactSecrets, scanForSecrets } from '../src/main/persistence/redaction.js';
import { evaluateMemory } from '../src/main/persistence/memory-policy.js';
import { buildAgentSystemPrompt } from '../src/main/agent/agent-tool-surface.js';

const CREDENTIALS = [
  'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBB',
  'github_pat_CCCCCCCCCCCCCCCCCCCCCCCC',
  'xoxb-1234567890-abcdefghij',
  'AIzaSyDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  'AKIAIOSFODNN7EXAMPLE',
  'sk_live_EEEEEEEEEEEEEEEEEEEE',
  'password: hunter2istheone',
  'api_key=abcd1234efgh5678',
  'Authorization: Bearer FFFFFFFFFFFFFFFFFFFF',
  '4111 1111 1111 1111',
  'verification code: 483920',
  '-----BEGIN RSA PRIVATE KEY-----',
];

const PERSONAL = [
  'ada@example.com',
  'reach me at ada.lovelace+work@sub.example.co.uk',
  'my phone number is 555 010 9876',
  'she lives at 42 Wallaby Way',
  'date of birth is next week',
];

const ORDINARY = [
  'open notepad',
  'remind me to review the parser refactor tomorrow',
  'the meeting moved to Thursday',
  'I prefer dark mode',
];

// ---------------------------------------------------------------------------

describe('the four classes are distinct and ordered', () => {
  it('names exactly the four the policy talks about', () => {
    expect([...SENSITIVITY_CLASSES]).toEqual(['NORMAL', 'PERSONAL', 'SECRET', 'CONSEQUENTIAL']);
  });

  it('escalates only upward, and puts SECRET at the top', () => {
    expect(escalateSensitivity('NORMAL', 'PERSONAL')).toBe('PERSONAL');
    expect(escalateSensitivity('PERSONAL', 'CONSEQUENTIAL')).toBe('CONSEQUENTIAL');
    // A consequential act can be authorised by a person. A secret cannot be
    // authorised by anyone, so it outranks.
    expect(escalateSensitivity('CONSEQUENTIAL', 'SECRET')).toBe('SECRET');
    expect(escalateSensitivity()).toBe('NORMAL');
  });

  it('maps each class to a floor, and PERSONAL’s floor is SAFE', () => {
    expect(riskFloorFor('NORMAL')).toBe('SAFE');
    // The correction, stated as a value: reading somebody their own email
    // address is not an act that needs a dialog.
    expect(riskFloorFor('PERSONAL')).toBe('SAFE');
    expect(riskFloorFor('CONSEQUENTIAL')).toBe('REQUIRES_APPROVAL');
    expect(riskFloorFor('SECRET')).toBe('FORBIDDEN');
  });
});

describe('an email address is PERSONAL, and PERSONAL is not SECRET', () => {
  it('classifies personal information as personal', () => {
    for (const text of PERSONAL) {
      expect(classifyText(text).sensitivity, text).toBe('PERSONAL');
    }
  });

  it('does not treat any of it as a credential', () => {
    for (const text of PERSONAL) {
      expect(isSecretText(text), text).toBe(false);
      expect(containsSecret(text), text).toBe(false);
      expect(scanForSecrets(text).verdict, text).toBe('clean');
    }
  });

  it('stores a memory containing one, and marks it', () => {
    const decision = evaluateMemory({
      category: 'person',
      key: 'Ada',
      value: 'Her email is ada@example.com',
      source: 'user',
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.sensitivity).toBe('personal');
    // Stored verbatim. A memory that was quietly hollowed out would be worse
    // than no memory, because the user would not know.
    expect(decision.value).toContain('ada@example.com');
  });

  it('leaves an email address alone in a stored message', () => {
    const { text, redacted } = redactSecrets('mail me at ada@example.com about Thursday');
    expect(redacted).toBe(false);
    expect(text).toContain('ada@example.com');
  });

  it('does not report a phone number as a matched pattern name that says "secret"', () => {
    expect(classifyText('call 555 010 9876').matched).toContain('phone-number');
  });

  it('carries no matched TEXT, only pattern names', () => {
    // A classifier that echoed what it found would put the very thing it was
    // protecting into whatever consumed its answer.
    const verdict = classifyText('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(verdict.matched.join(' ')).not.toContain('ghp_');
  });
});

describe('SECRET has not loosened by one case', () => {
  it('still recognises every credential shape', () => {
    for (const text of CREDENTIALS) {
      expect(classifyText(text).sensitivity, text).toBe('SECRET');
      expect(containsSecret(text), text).toBe(true);
    }
  });

  it('still refuses to remember any of them', () => {
    for (const text of CREDENTIALS) {
      const decision = evaluateMemory({ category: 'fact', key: 'a note', value: text, source: 'user' });
      expect(decision.ok, text).toBe(false);
      if (!decision.ok) expect(decision.rejection).toBe('looks-like-a-secret');
    }
  });

  it('still redacts them out of a stored message, visibly', () => {
    const { text, redacted } = redactSecrets('my token is ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ok?');
    expect(redacted).toBe(true);
    expect(text).not.toContain('ghp_');
    expect(text).toContain('[redacted]');
  });

  it('wins over PERSONAL when a string is both', () => {
    // Asymmetric consequences: a credential treated as an email address ends
    // up in a database; an email address treated as a credential costs a
    // refusal.
    expect(classifyText('ada@example.com password: hunter2istheone').sensitivity).toBe('SECRET');
  });

  it('leaves ordinary text alone', () => {
    for (const text of ORDINARY) {
      expect(classifyText(text).sensitivity, text).toBe('NORMAL');
    }
  });

  it('does not fire on prose that merely mentions passwords', () => {
    // The pattern requires an assignment, so talking about credentials is not
    // the same as carrying one.
    expect(classifyText('remind me to change my password sometime').sensitivity).not.toBe('SECRET');
  });
});

describe('CONSEQUENTIAL is a property of an act, not of a string', () => {
  it('is never returned for text', () => {
    for (const text of [...CREDENTIALS, ...PERSONAL, ...ORDINARY, 'delete everything']) {
      expect(classifyText(text).sensitivity).not.toBe('CONSEQUENTIAL');
    }
  });

  it('classifies a destructive control name', () => {
    const verdict = classifyActionLabel('Delete repository');
    expect(verdict.sensitivity).toBe('CONSEQUENTIAL');
    expect(verdict.matched[0]).toMatch(/^destructive:/);
  });

  it('classifies an outward control name', () => {
    const verdict = classifyActionLabel('Send message');
    expect(verdict.sensitivity).toBe('CONSEQUENTIAL');
    expect(verdict.matched[0]).toMatch(/^outward:/);
  });

  it('leaves an ordinary control alone', () => {
    expect(classifyActionLabel('Zoom in').sensitivity).toBe('NORMAL');
    expect(classifyActionLabel('7').sensitivity).toBe('NORMAL');
  });

  it('covers money, accounts, credentials and destruction between its two lists', () => {
    // The four kinds Phase 2 named. Each has to be findable, or the
    // classification is a vocabulary exercise.
    const all = [...DESTRUCTIVE_PHRASES, ...OUTWARD_PHRASES];
    for (const needed of ['pay', 'delete', 'change password', 'create account', 'send']) {
      expect(all, needed).toContain(needed);
    }
  });
});

describe('the model is told the difference rather than left to guess', () => {
  const prompt = buildAgentSystemPrompt({
    tools: [{ name: 'system.time', title: 'Check the time', description: 'Reads the clock.', inputSchema: {} }],
    platform: 'win32',
    workspaceRoot: 'C:/Axon/workspace',
  });

  it('says an email address is ordinary information it may use', () => {
    expect(prompt).toMatch(/email address/i);
    expect(prompt).toMatch(/not forbidden/i);
  });

  it('still says credentials are never handled', () => {
    expect(prompt).toMatch(/passwords, api keys, tokens/i);
    expect(prompt).toMatch(/type it themselves/i);
  });

  it('says consequential acts are the user’s to authorise, not the model’s to skip', () => {
    expect(prompt).toMatch(/for the user to\s+authorise/i);
    expect(prompt).toMatch(/not your decision to make or skip/i);
  });
});
