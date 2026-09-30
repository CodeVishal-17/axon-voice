/**
 * What the window shows a person.
 *
 * The renderer is presentation only; everything here is PURE, so it is tested
 * without a DOM. The rules under test are the ones the redesign must not
 * break:
 *
 *   - the line under the orb follows Axon's real state, in plain words;
 *   - it never shows a tool name, an internal id, a policy term or a stack trace;
 *   - the current exchange is the one in front, with history collapsed behind it;
 *   - the approval card leads with the act and where it lands, shows what will
 *     be sent in full, and hides anything shaped like a secret;
 *   - the theme survives a restart, and a page without storage still renders.
 */

import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, AxonEvent, AxonState, ListeningStatus, VoiceAgentStatus } from '@axon/core';
import { currentExchange, hostOf, isPresentable, presenceFor } from '../src/renderer/state/presence.js';
import { DEFAULT_THEME, otherTheme, parseTheme, readStoredTheme, storeTheme, THEME_STORAGE_KEY } from '../src/renderer/state/theme.js';
import { describeApprovalCard, looksSecret } from '../src/renderer/components/approval/approval-card.js';

let seq = 0;
function event(body: Record<string, unknown>): AxonEvent {
  seq += 1;
  return { id: `e${seq}`, seq, at: new Date().toISOString(), sessionId: 's', ...body } as unknown as AxonEvent;
}

const wakeHealthy = {
  engine: 'keyword-spotter',
  detail: 'local keyword spotter',
  available: true,
  unavailableReason: null,
  restarts: 0,
  starvedOfAudio: false,
} as const;
const voiceArmed: VoiceAgentStatus = { available: true, name: 'assemblyai', reason: null, active: false, phase: 'IDLE', armed: true, wake: wakeHealthy };
const voiceOff: VoiceAgentStatus = { ...voiceArmed, armed: false };
const listening: ListeningStatus = { available: true, name: 'windows-speech', reason: null, active: false, hotkey: null };

function presence(state: AxonState, events: AxonEvent[] = [], voice: VoiceAgentStatus = voiceArmed) {
  return presenceFor({ state, events, voiceAgent: voice, listening });
}

describe('the line under the orb', () => {
  it('invites the wake phrase when Axon is listening for it', () => {
    expect(presence('IDLE').headline).toBe('Say “Hey Axon”');
    expect(presence('IDLE').detail).toMatch(/on this device/);
  });

  it('offers the orb when the wake word is off', () => {
    expect(presence('IDLE', [], voiceOff).detail).toBe('Click the orb to talk');
  });

  it('says what each working state is, briefly', () => {
    expect(presence('LISTENING').headline).toBe('Listening…');
    expect(presence('THINKING').headline).toBe('Thinking…');
    expect(presence('SPEAKING').headline).toBe('Speaking…');
    expect(presence('WAITING_FOR_APPROVAL').headline).toBe('Axon needs your approval');
    expect(presence('WAITING_FOR_APPROVAL').tone).toBe('attention');
  });

  it('shows the action in progress in Axon’s own words', () => {
    const events = [event({ type: 'STATE_CHANGED', from: 'THINKING', to: 'EXECUTING', reason: 'Opening YouTube' })];
    expect(presence('EXECUTING', events).headline).toBe('Opening YouTube…');
  });

  it('never shows a tool name, even if one arrives', () => {
    for (const reason of ['Running browser.open', 'app.open finished', 'system.screenshot']) {
      const events = [event({ type: 'STATE_CHANGED', from: 'THINKING', to: 'EXECUTING', reason })];
      expect(presence('EXECUTING', events).headline, reason).toBe('Working on it…');
    }
  });

  it('shows an error as a sentence, and hides one that is a diagnostic', () => {
    const plain = [event({ type: 'ERROR', scope: 'voice', message: 'Axon could not reach the voice provider.', detail: null })];
    expect(presence('ERROR', plain).detail).toBe('Axon could not reach the voice provider.');

    const stack = [event({ type: 'ERROR', scope: 'x', message: "TypeError: Cannot read properties of undefined at run (C:\\dev\\x.ts:4:2)", detail: null })];
    expect(presence('ERROR', stack).detail).toBe('Try again when you are ready.');
  });

  it('keeps hosts, which are not internal, and refuses what is', () => {
    expect(isPresentable('Browsing youtube.com')).toBe(true);
    for (const internal of ['browser.click', 'task-1a2b step-3', 'REQUIRES_APPROVAL', 'the dispatcher refused', 'at x (C:\\a.ts:1:2)']) {
      expect(isPresentable(internal), internal).toBe(false);
    }
  });

  it('names only a host, never a path or query', () => {
    expect(hostOf('https://www.youtube.com/results?search_query=secret')).toBe('www.youtube.com');
    expect(hostOf('not a url')).toBeNull();
  });
});

describe('the current exchange', () => {
  it('puts the latest request and its reply in front', () => {
    const events = [
      event({ type: 'USER_MESSAGE', text: 'Open Calculator' }),
      event({ type: 'ASSISTANT_MESSAGE', text: 'Calculator is open.' }),
      event({ type: 'USER_MESSAGE', text: 'Open YouTube' }),
      event({ type: 'ASSISTANT_MESSAGE', text: 'Opening YouTube.' }),
      event({ type: 'ASSISTANT_MESSAGE', text: 'YouTube is open.' }),
    ];
    const exchange = currentExchange(events);
    expect(exchange.user?.text).toBe('Open YouTube');
    expect(exchange.axon?.text).toBe('YouTube is open.');
    expect(exchange.earlier.map((turn) => turn.text)).toEqual(['Open Calculator', 'Calculator is open.']);
  });

  it('has no reply yet while Axon is still working', () => {
    const exchange = currentExchange([event({ type: 'USER_MESSAGE', text: 'Open YouTube' })]);
    expect(exchange.user?.text).toBe('Open YouTube');
    expect(exchange.axon).toBeNull();
  });

  it('is empty before anything has been said', () => {
    expect(currentExchange([])).toEqual({ user: null, axon: null, earlier: [] });
  });
});

describe('the approval card', () => {
  function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
      callId: 'c1',
      tool: 'browser.click',
      risk: 'REQUIRES_APPROVAL',
      title: 'Axon wants to click "Submit application" on careers.example.com',
      detail: 'Submitting sends data to another site.',
      parameters: [
        { label: 'Page', value: 'Apply — Summer Internship' },
        { label: 'Address', value: 'https://careers.example.com/internship/apply' },
      ],
      binding: { tool: 'browser.click', action: 'click', target: 'https://careers.example.com/internship/apply', effect: 'EXTERNAL', fingerprint: 'f' },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    };
  }

  it('leads with the act and where it lands', () => {
    const card = describeApprovalCard(request());
    expect(card.act).toBe('Click "Submit application"');
    expect(card.where).toBe('careers.example.com');
    expect(card.outward).toBe(true);
  });

  it('never says a local act leaves the computer', () => {
    // The dispatcher marks anything a human was asked about as EXTERNAL, so
    // the class alone would put "may send something" on a local file write.
    const card = describeApprovalCard(
      request({
        tool: 'fs.write',
        title: 'Axon wants to write a file',
        parameters: [{ label: 'Path', value: 'notes.txt' }],
        binding: { tool: 'fs.write', action: 'write a file', target: 'notes.txt', effect: 'EXTERNAL', fingerprint: 'f' },
      }),
    );
    expect(card.outward).toBe(false);
  });

  it('falls back to the target’s host when the title names no place', () => {
    const card = describeApprovalCard(request({ title: 'Axon wants to open a web page' }));
    expect(card.act).toBe('Open a web page');
    expect(card.where).toBe('careers.example.com');
  });

  it('shows what will be sent in full', () => {
    const text = 'Hello — I would love to be considered for the internship. '.repeat(4).trim();
    const card = describeApprovalCard(request({ parameters: [{ label: 'Text', value: text }] }));
    expect(card.contents).toEqual([{ label: 'Text', value: text, hidden: false }]);
  });

  it('hides anything shaped like a secret', () => {
    for (const secret of ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '4111 1111 1111 1111']) {
      expect(looksSecret(secret), secret).toBe(true);
      const card = describeApprovalCard(request({ parameters: [{ label: 'Text', value: secret }] }));
      expect(card.contents[0]?.value).toBe('Hidden');
      expect(JSON.stringify(card)).not.toContain(secret);
    }
    expect(looksSecret('careers.example.com')).toBe(false);
  });

  it('marks a high-risk act', () => {
    expect(describeApprovalCard(request({ risk: 'HIGH_RISK' })).highRisk).toBe(true);
  });
});

describe('the theme', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      values,
    };
  }

  it('survives a restart', () => {
    const storage = memoryStorage();
    storeTheme(storage, 'light');
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe('light');
    expect(readStoredTheme(storage)).toBe('light');
  });

  it('ignores anything that is not a theme', () => {
    expect(readStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: 'neon' }))).toBe(DEFAULT_THEME);
    expect(parseTheme('<script>')).toBeNull();
  });

  it('renders with no storage at all, and storage that throws', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    expect(readStoredTheme(null)).toBe(DEFAULT_THEME);
    expect(readStoredTheme(throwing)).toBe(DEFAULT_THEME);
    expect(() => storeTheme(throwing, 'light')).not.toThrow();
  });

  it('toggles between exactly two', () => {
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
  });
});
