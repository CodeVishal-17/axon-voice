/**
 * Settings: validation, defaults, and the rollback that keeps a shortcut
 * honest.
 *
 * A persisted setting is an input that arrives BEFORE the user can intervene —
 * it is read during startup, on a machine whose database may have been damaged
 * or edited. So the properties that matter are: nothing crashes, nothing
 * invalid is used, and the value in force is the value the settings screen
 * shows.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  checkHotkey,
  checkWorkspacePath,
  loadSettings,
  settingsPatchSchema,
  toRows,
} from '../src/main/persistence/settings-schema.js';
import { SettingsService, type SettingsEffects } from '../src/main/settings/settings-service.js';

describe('hotkey validation', () => {
  it.each([
    ['Control+Shift+Space', 'Control+Shift+Space'],
    ['ctrl+alt+K', 'ctrl+alt+K'],
    ['  Control+Shift+F9  ', 'Control+Shift+F9'],
    ['CommandOrControl+Shift+A', 'CommandOrControl+Shift+A'],
  ])('accepts %s', (input, expected) => {
    const check = checkHotkey(input);
    expect(check.ok).toBe(true);
    expect(check.value).toBe(expected);
  });

  it('treats empty as "let Axon choose"', () => {
    for (const value of ['', null, undefined]) {
      const check = checkHotkey(value);
      expect(check.ok).toBe(true);
      expect(check.value).toBeNull();
    }
  });

  it.each([
    ['a bare key', 'Space'],
    ['a bare letter', 'K'],
    ['a bare function key', 'F1'],
    ['only modifiers', 'Control+Shift'],
    ['two keys', 'Control+A+B'],
    ['punctuation', 'Control+Shift+;'],
    ['a script', 'Control+<script>'],
    ['nonsense', 'not a shortcut at all!'],
  ])('refuses %s', (_label, input) => {
    // A bare key would swallow that key for every application on the machine.
    expect(checkHotkey(input).ok).toBe(false);
  });

  it('refuses shortcuts that belong to Windows', () => {
    // Taking these hijacks a system affordance the user needs more than they
    // need push-to-talk.
    for (const input of ['Alt+Space', 'alt+space', 'Ctrl+Alt+Delete', 'Alt+F4', 'Ctrl+Shift+Esc']) {
      expect(checkHotkey(input).ok, input).toBe(false);
    }
  });

  it('refuses a non-string and an absurd length', () => {
    expect(checkHotkey(42).ok).toBe(false);
    expect(checkHotkey('Control+'.repeat(20)).ok).toBe(false);
  });

  it('explains every refusal', () => {
    for (const input of ['Space', 'Alt+Space', 'Control+A+B']) {
      expect(checkHotkey(input).reason?.length ?? 0, input).toBeGreaterThan(10);
    }
  });
});

describe('workspace validation', () => {
  it('accepts and normalizes an absolute path', () => {
    const check = checkWorkspacePath('C:\\Users\\someone\\Documents\\..\\Axon');
    expect(check.ok).toBe(true);
    expect(check.value).toMatch(/Axon$/);
    expect(check.value).not.toContain('..');
  });

  it('treats empty as "use the default"', () => {
    for (const value of ['', '   ', null, undefined]) {
      const check = checkWorkspacePath(value);
      expect(check.ok).toBe(true);
      expect(check.value).toBeNull();
    }
  });

  it.each([
    ['a relative path', 'workspace'],
    ['a traversal', '..\\..\\Windows'],
    ['a UNC share', '\\\\server\\share'],
    ['a device path', '\\\\?\\C:\\Windows'],
    ['an alternate data stream', 'C:\\Users\\me\\notes.txt:hidden'],
    ['a null byte', 'C:\\Users\\me\\a\u0000b'],
    ['a non-string', 42],
  ])('refuses %s', (_label, input) => {
    expect(checkWorkspacePath(input).ok).toBe(false);
  });

  it('refuses an absurdly long path', () => {
    expect(checkWorkspacePath(`C:\\${'a'.repeat(500)}`).ok).toBe(false);
  });
});

describe('loading settings from stored rows', () => {
  it('uses defaults when nothing is stored', () => {
    const loaded = loadSettings({});
    expect(loaded.settings).toEqual(DEFAULT_SETTINGS);
    expect(loaded.repaired).toEqual([]);
  });

  it('round-trips through rows unchanged', () => {
    const settings = {
      voiceHotkey: 'Control+Shift+K',
      workspacePath: 'C:\\Axon\\work',
      speechEnabled: false,
      restoreLastSession: false,
      memoryEnabled: false,
    };
    expect(loadSettings(toRows(settings)).settings).toEqual(settings);
  });

  it('falls back rather than crashing on a corrupt row', () => {
    // The property that decides whether a damaged database makes Axon
    // unopenable by the one person who might want to rescue it.
    const loaded = loadSettings({
      voiceHotkey: 'Alt+Space',
      workspacePath: '\\\\evil\\share',
      speechEnabled: 'maybe',
      memoryEnabled: '1',
    });

    expect(loaded.settings.voiceHotkey).toBeNull();
    expect(loaded.settings.workspacePath).toBeNull();
    expect(loaded.settings.speechEnabled).toBe(DEFAULT_SETTINGS.speechEnabled);
    expect(loaded.settings.memoryEnabled).toBe(DEFAULT_SETTINGS.memoryEnabled);
    // And says which ones, so the user learns their setting is not in force.
    expect([...loaded.repaired].sort()).toEqual(['memoryEnabled', 'speechEnabled', 'voiceHotkey', 'workspacePath']);
  });

  it('never executes or interpolates a stored value', () => {
    // A persisted value is data. These are stored strings, and every one of
    // them simply fails validation.
    const loaded = loadSettings({
      voiceHotkey: "'; DROP TABLE settings; --",
      workspacePath: '$(calc.exe)',
    });
    expect(loaded.settings.voiceHotkey).toBeNull();
    expect(loaded.settings.workspacePath).toBeNull();
  });
});

describe('the settings patch schema', () => {
  it('accepts a partial update', () => {
    expect(settingsPatchSchema.safeParse({ speechEnabled: false }).success).toBe(true);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // A typo becomes an error the user sees, not a setting that silently does
    // nothing.
    expect(settingsPatchSchema.safeParse({ speechEnabled: false, databasePath: 'C:/evil.db' }).success).toBe(false);
  });

  it('rejects a wrong type', () => {
    expect(settingsPatchSchema.safeParse({ speechEnabled: 'yes' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ voiceHotkey: 42 }).success).toBe(false);
  });

  it('has no field through which a database path could be set', () => {
    const shape = Object.keys(settingsPatchSchema.shape);
    expect(shape.sort()).toEqual(
      ['memoryEnabled', 'restoreLastSession', 'speechEnabled', 'voiceHotkey', 'workspacePath'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------

interface Harness {
  readonly service: SettingsService;
  readonly registered: (string | null)[];
  readonly committed: { keys: readonly string[] }[];
}

function harness(options: { hotkeyTakes?: boolean; directories?: string[] } = {}): Harness {
  const registered: (string | null)[] = [];
  const committed: { keys: readonly string[] }[] = [];

  const effects: SettingsEffects = {
    applyHotkey: (accelerator) => {
      registered.push(accelerator);
      if (options.hotkeyTakes === false) return null;
      // Real registration may fall back to a different candidate, exactly as
      // `GlobalHotkeyWakeSource` does.
      return accelerator ?? 'Control+Shift+Space';
    },
    directoryExists: (path) => (options.directories ?? []).includes(path),
  };

  const service = new SettingsService(DEFAULT_SETTINGS, {
    effects,
    commit: (_settings, keys) => committed.push({ keys }),
  });

  return { service, registered, committed };
}

describe('applying a settings change', () => {
  it('does nothing when nothing changed', () => {
    const h = harness();
    const result = h.service.update({ speechEnabled: true });

    expect(result.accepted).toBe(true);
    expect(h.committed).toEqual([]);
  });

  it('commits only the keys that changed', () => {
    const h = harness();
    h.service.update({ speechEnabled: false, restoreLastSession: true });

    expect(h.committed).toHaveLength(1);
    expect(h.committed[0]?.keys).toEqual(['speechEnabled']);
  });

  it('registers a new hotkey and stores what actually took', () => {
    const h = harness();
    const result = h.service.update({ voiceHotkey: 'Control+Alt+K' });

    expect(result.accepted).toBe(true);
    expect(h.registered).toEqual(['Control+Alt+K']);
    expect(result.settings.voiceHotkey).toBe('Control+Alt+K');
  });

  it('rolls back when the shortcut cannot be registered', () => {
    // The property this whole service exists for. Without it a user is left
    // with a settings screen saying Ctrl+Alt+K and a key that does nothing.
    const h = harness({ hotkeyTakes: false });
    const result = h.service.update({ voiceHotkey: 'Control+Alt+K' });

    expect(result.accepted).toBe(false);
    expect(result.error).toMatch(/another application|previous shortcut/i);
    // The old value was restored, and nothing was written.
    expect(h.registered).toEqual(['Control+Alt+K', null]);
    expect(h.committed).toEqual([]);
    expect(h.service.current().voiceHotkey).toBeNull();
  });

  it('refuses an invalid hotkey without touching the registration', () => {
    const h = harness();
    const result = h.service.update({ voiceHotkey: 'Space' });

    expect(result.accepted).toBe(false);
    expect(h.registered).toEqual([]);
    expect(h.committed).toEqual([]);
  });

  it('refuses a workspace that does not exist', () => {
    const h = harness({ directories: ['C:\\Axon\\real'] });
    const result = h.service.update({ workspacePath: 'C:\\Axon\\missing' });

    expect(result.accepted).toBe(false);
    expect(result.error).toMatch(/does not exist/i);
    expect(h.committed).toEqual([]);
  });

  it('accepts a workspace that does exist', () => {
    const h = harness({ directories: ['C:\\Axon\\real'] });
    const result = h.service.update({ workspacePath: 'C:\\Axon\\real' });

    expect(result.accepted).toBe(true);
    expect(result.settings.workspacePath).toBe('C:\\Axon\\real');
  });

  it('applies all of a patch or none of it', () => {
    // A half-accepted update is a state the user cannot reason about: they
    // pressed Save once and would have to work out which halves took.
    const h = harness({ directories: [] });
    const result = h.service.update({ speechEnabled: false, workspacePath: 'C:\\nope' });

    expect(result.accepted).toBe(false);
    expect(h.service.current().speechEnabled).toBe(true);
    expect(h.committed).toEqual([]);
  });

  it('resets through the same path as any other update', () => {
    const h = harness();
    h.service.update({ speechEnabled: false, memoryEnabled: false });
    const result = h.service.reset();

    expect(result.accepted).toBe(true);
    expect(h.service.current()).toEqual(DEFAULT_SETTINGS);
  });
});
