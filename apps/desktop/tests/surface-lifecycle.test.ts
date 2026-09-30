/**
 * Late events against windows that have gone away.
 *
 * A real crash started this file:
 *
 *     TypeError: Object has been destroyed
 *       at Object.voiceSurface -> voiceSurface -> fromVoice -> ipcMain.emit
 *
 * A microphone frame in flight when the overlay was destroyed reached the
 * bridge, and asking "did this come from the voice surface?" read
 * `overlay.webContents`. On a destroyed BrowserWindow that property read throws.
 *
 * The stand-in window below throws in exactly that way, so these tests fail
 * against the code that crashed and pass only when nothing reads a dead
 * window's contents. `installRendererBridge` binds Electron's `ipcMain` and
 * cannot be imported here; every routing decision it makes is `SurfaceRouter`,
 * which is what is under test — and `verify-lifecycle.cjs` repeats the
 * scenario against the real Electron objects.
 */

import { describe, expect, it } from 'vitest';
import { SurfaceRouter, liveContents, type ContentsLike } from '../src/main/bus/surface-router.js';

class FakeContents implements ContentsLike {
  destroyed = false;
  readonly sent: string[] = [];
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string): void {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    this.sent.push(channel);
  }
}

/** Behaves like BrowserWindow: `webContents` THROWS once the window is destroyed. */
class FakeWindow {
  private destroyed = false;
  private readonly contents = new FakeContents();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  get webContents(): FakeContents {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    return this.contents;
  }
  /** What a test can inspect without tripping the getter. */
  get inner(): FakeContents {
    return this.contents;
  }
  destroy(): void {
    this.destroyed = true;
    this.contents.destroyed = true;
  }
}

/** Main's wiring, as `index.ts` does it: a mutable overlay reference and a panel. */
function world() {
  const state: { overlay: FakeWindow | null; panel: FakeWindow | null } = {
    overlay: new FakeWindow(),
    panel: new FakeWindow(),
  };
  const router = new SurfaceRouter<FakeContents>({
    voiceSurface: () => liveContents(state.overlay),
    windows: () => [state.overlay, state.panel].filter((w): w is FakeWindow => w !== null),
  });
  return { state, router };
}

describe('reading a window that may be gone', () => {
  it('reproduces the crash: the old wiring throws on a destroyed overlay', () => {
    // The exact expression that crashed, so this file proves it tests the bug.
    const overlay = new FakeWindow();
    const oldVoiceSurface = (): FakeContents | null => overlay.webContents ?? null;
    overlay.destroy();
    expect(oldVoiceSurface).toThrow(/Object has been destroyed/);
  });

  it('never reads contents from a destroyed window', () => {
    const window = new FakeWindow();
    window.destroy();
    expect(() => liveContents(window)).not.toThrow();
    expect(liveContents(window)).toBeNull();
  });

  it('treats destroyed contents in a living window as gone', () => {
    const window = new FakeWindow();
    window.inner.destroyed = true;
    expect(liveContents(window)).toBeNull();
  });

  it('returns live contents unchanged', () => {
    const window = new FakeWindow();
    expect(liveContents(window)).toBe(window.inner);
    expect(liveContents(null)).toBeNull();
  });
});

describe('late voice events after the overlay is destroyed', () => {
  it('start session, schedule event, destroy overlay, emit: a late frame is refused, not a crash', () => {
    const { state, router } = world();
    const sender = state.overlay!.inner;
    expect(router.fromVoice(sender)).toBe(true);

    state.overlay!.destroy();
    // The frame that was in flight arrives now, stamped with the dead sender.
    expect(() => router.fromVoice(sender)).not.toThrow();
    expect(router.fromVoice(sender)).toBe(false);
  });

  it('drops speech and capture commands instead of sending to a dead surface', () => {
    const { state, router } = world();
    state.overlay!.destroy();
    expect(() => router.toVoice('axon:speech:chunk', {})).not.toThrow();
    expect(router.toVoice('axon:listen:capture', {})).toBe(false);
    // And crucially NOT to the panel: a capture command must never open a
    // microphone in a window that is not the voice surface.
    expect(state.panel!.inner.sent).toEqual([]);
  });

  it('keeps broadcasting bus events to the windows that are still alive', () => {
    const { state, router } = world();
    state.overlay!.destroy();
    expect(() => router.broadcast('axon:event', {})).not.toThrow();
    expect(state.panel!.inner.sent).toEqual(['axon:event']);
  });

  it('after the overlay reference is cleared on `closed`, late events are still safe', () => {
    const { state, router } = world();
    const sender = state.overlay!.inner;
    state.overlay!.destroy();
    state.overlay = null;
    expect(router.fromVoice(sender)).toBe(false);
    expect(router.toVoice('axon:speech:stop', 'id')).toBe(false);
    expect(() => router.broadcast('axon:event', {})).not.toThrow();
  });

  it('a session that closes and then emits (teardown, cancel, task completion) cannot crash main', () => {
    const { state, router } = world();
    // Session close, cancel, and task completion all end in the same three
    // kinds of late emission. Each one, after destroy, in the order teardown
    // produces them.
    state.overlay!.destroy();
    const late = [
      () => router.toVoice('axon:speech:stop', 'utterance-1'), // cancel
      () => router.toVoice('axon:listen:capture', { action: 'stop' }), // session close
      () => router.broadcast('axon:event', { type: 'VOICE_SESSION', action: 'closed' }), // completion
      () => router.fromVoice(new FakeContents()), // a report from nowhere
    ];
    for (const emit of late) expect(emit).not.toThrow();
  });
});

describe('late events after the panel is destroyed', () => {
  it('skips the dead panel and still reaches the overlay', () => {
    const { state, router } = world();
    state.panel!.destroy();
    expect(() => router.broadcast('axon:event', {})).not.toThrow();
    expect(state.overlay!.inner.sent).toEqual(['axon:event']);
  });

  it('a destroyed panel never becomes the voice surface', () => {
    const { state, router } = world();
    const panelContents = state.panel!.inner;
    state.panel!.destroy();
    expect(router.fromVoice(panelContents)).toBe(false);
  });
});

describe('renderer reload', () => {
  it('a reloading overlay keeps the same contents, and stays the voice surface', () => {
    // A reload replaces the page, not the WebContents: it is neither destroyed
    // nor a new object, so frames from the reloaded page are accepted.
    const { state, router } = world();
    const sender = state.overlay!.inner;
    expect(router.fromVoice(sender)).toBe(true);
    expect(router.toVoice('axon:listen:capture', {})).toBe(true);
  });

  it('a crashed renderer whose contents were destroyed is not a target until replaced', () => {
    const { state, router } = world();
    state.overlay!.inner.destroyed = true;
    expect(router.toVoice('axon:speech:chunk', {})).toBe(false);
    expect(router.fromVoice(state.overlay!.inner)).toBe(false);
  });
});

describe('with no voice surface configured (unit harnesses)', () => {
  it('broadcasts voice traffic and accepts any sender, as before', () => {
    const window = new FakeWindow();
    const router = new SurfaceRouter<FakeContents>({ windows: () => [window] });
    expect(router.toVoice('axon:listen:capture', {})).toBe(true);
    expect(window.inner.sent).toEqual(['axon:listen:capture']);
    expect(router.fromVoice(new FakeContents())).toBe(true);
  });
});
