/**
 * What the user asks Axon to remember reaches the voice conversation.
 *
 * FOUND IN A REAL CONVERSATION. The voice path was never given a single
 * memory: the typed brain received recalled facts in its prompt, the voice
 * agent received none, and its prompt did not mention the memory tools. In
 * the same session the model said "I will remember that you want me to play
 * songs without asking" — and the one `memory.save` in the whole log failed.
 *
 * What these cover, and where the rest is covered:
 *
 *   here                the wiring. A remembered fact reaches a NEW voice
 *                       session's prompt; saving happens only through an
 *                       explicit, approved `memory.save`; a failed save is
 *                       reported as a failure and recalls nothing; ordinary
 *                       conversation saves nothing.
 *   verify:persistence  the database itself — real SQLite, written, the
 *                       process closed and reopened, memories verbatim. It
 *                       needs `node:sqlite`, which exists inside Electron and
 *                       not in the Node that runs this suite, so the store
 *                       here is an in-memory stand-in with the same methods.
 *
 * What neither can prove: that the model obeys "do not say saved until it
 * is". That is an instruction, asserted to be present; a live conversation is
 * what shows it being followed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AxonEvent, MemoryEntry } from '@axon/core';
import { renderMemoryLines } from '@axon/core';
import type { PersistenceService } from '../src/main/persistence/persistence-service.js';
import { createMemoryForgetTool, createMemorySaveTool, createMemorySearchTool } from '../src/main/tools/executors/memory.js';
import { createSystemTimeTool } from '../src/main/tools/executors/system-time.js';
import { buildSystemPrompt } from '../src/main/brain/system-prompt.js';
import { toAgentResult } from '../src/main/agent/tool-bridge.js';
import { until, voiceRig, type VoiceRig } from './support/voice-rig.js';

/**
 * The database, minus the database. Same methods the memory tools and the
 * orchestrator call, same shapes back; persistent for as long as the test
 * holds it, which is what "across sessions" means here.
 */
class InMemoryMemories {
  readonly entries: MemoryEntry[] = [];
  saveCalls = 0;
  failSaves = false;
  memoryEnabled = true;
  private ids = 0;

  contextForTurn(): ReturnType<PersistenceService['contextForTurn']> {
    return {
      context: {
        sessionId: 'session-1',
        summary: null,
        memories: this.memoryEnabled
          ? this.entries.filter((entry) => entry.enabled).map(({ category, key, value }) => ({ category, key, value }))
          : [],
        truncated: false,
        now: new Date().toISOString(),
        recent: [],
      },
      history: [],
    };
  }

  saveMemory(input: Pick<MemoryEntry, 'category' | 'key' | 'value' | 'source' | 'sensitivity'>): MemoryEntry | null {
    this.saveCalls += 1;
    if (this.failSaves) return null;
    const at = new Date().toISOString();
    const existing = this.entries.findIndex((entry) => entry.category === input.category && entry.key === input.key);
    this.ids += 1;
    const entry: MemoryEntry = { id: `m${this.ids}`, enabled: true, createdAt: at, updatedAt: at, ...input };
    if (existing >= 0) this.entries.splice(existing, 1, entry);
    else this.entries.push(entry);
    return entry;
  }

  searchMemories(query: string): readonly MemoryEntry[] {
    const q = query.trim().toLowerCase();
    return this.entries.filter((entry) => q === '' || `${entry.key} ${entry.value}`.toLowerCase().includes(q));
  }

  listMemories(): readonly MemoryEntry[] {
    return this.entries;
  }

  deleteMemory(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }
}

const rigs: VoiceRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.dispose();
});

async function conversation(store: InMemoryMemories): Promise<VoiceRig> {
  const persistence = store as unknown as PersistenceService;
  const r = await voiceRig({
    tools: [
      createMemorySaveTool(persistence),
      createMemorySearchTool(persistence),
      createMemoryForgetTool(persistence),
      createSystemTimeTool(),
    ],
    orchestrator: { persistence },
  });
  rigs.push(r);
  // The user answers every approval with yes, on a later tick.
  r.orchestrator.bus.subscribe((event) => {
    if (event.type !== 'APPROVAL_REQUIRED') return;
    setTimeout(() => r.orchestrator.resolveApproval(event.request.callId, 'ALLOW', event.request.binding.fingerprint), 0);
  });
  await r.start();
  return r;
}

/** The prompt of the MOST RECENT session Axon opened on this provider. */
function latestPrompt(r: VoiceRig): string {
  const updates = r.provider.received.filter((message) => message.type === 'session.update');
  const session = updates.at(-1)?.session as { system_prompt?: unknown } | undefined;
  return typeof session?.system_prompt === 'string' ? session.system_prompt : '';
}

const toolResults = (r: VoiceRig, tool: string): Extract<AxonEvent, { type: 'TOOL_RESULT' }>[] =>
  r.events.filter(
    (event): event is Extract<AxonEvent, { type: 'TOOL_RESULT' }> => event.type === 'TOOL_RESULT' && event.tool === tool,
  );

async function remember(r: VoiceRig, value: string): Promise<Record<string, unknown>> {
  await r.say(`Remember that my name is ${value}.`);
  return r.call('memory.save', { category: 'person', key: 'name', value });
}

describe('a new voice conversation is told what Axon remembers', () => {
  it('puts an approved memory in the session prompt', async () => {
    const store = new InMemoryMemories();
    store.saveMemory({ category: 'person', key: 'name', value: 'Vishal', source: 'user', sensitivity: 'personal' });

    const r = await conversation(store);
    expect(await until(() => latestPrompt(r) !== '')).toBe(true);
    expect(latestPrompt(r)).toContain('- person: name — Vishal');
  });

  it('says "nothing yet" rather than leaving the model to guess', async () => {
    const r = await conversation(new InMemoryMemories());
    expect(await until(() => latestPrompt(r) !== '')).toBe(true);
    expect(latestPrompt(r)).toMatch(/WHAT YOU REMEMBER[\s\S]*- \(nothing yet\)/);
  });

  it('respects memory being switched off', async () => {
    const store = new InMemoryMemories();
    store.saveMemory({ category: 'person', key: 'name', value: 'Vishal', source: 'user', sensitivity: 'personal' });
    store.memoryEnabled = false;

    const r = await conversation(store);
    expect(await until(() => latestPrompt(r) !== '')).toBe(true);
    expect(latestPrompt(r)).not.toContain('- person: name — Vishal');
  });

  it('renders memories exactly as the typed brain does', () => {
    const memories = [{ category: 'person', key: 'name', value: 'Vishal' }];
    const line = renderMemoryLines(memories)[0]!;
    const brain = buildSystemPrompt({
      tools: [],
      platform: 'Windows',
      workspaceRoot: '/w',
      context: { sessionId: 's', summary: null, memories, truncated: false, now: new Date().toISOString(), recent: [] },
    });
    expect(brain).toContain(line);
  });
});

describe('saving is explicit, approved, and reported only when it is true', () => {
  it('saves through memory.save, and is only "saved" after approval and a real write', async () => {
    const store = new InMemoryMemories();
    const r = await conversation(store);

    const first = await remember(r, 'Vishal');
    // The provider's first answer is the approval being pending — NOT a
    // save. There is nothing yet for the model to call remembered.
    expect(JSON.stringify(first)).not.toMatch(/"saved":true/);

    expect(await until(() => toolResults(r, 'memory.save').length > 0)).toBe(true);
    expect(toolResults(r, 'memory.save')[0]).toMatchObject({ ok: true, output: { saved: true, key: 'name' } });
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({ category: 'person', key: 'name', value: 'Vishal' });
  });

  it('a failed save is a failure, with nothing that sounds like success, and nothing is recalled', async () => {
    const store = new InMemoryMemories();
    store.failSaves = true;
    const r = await conversation(store);

    await remember(r, 'Vishal');
    expect(await until(() => toolResults(r, 'memory.save').length > 0)).toBe(true);
    const result = toolResults(r, 'memory.save')[0]!;
    expect(result.ok).toBe(false);
    expect(result.failure?.message).toMatch(/could not save/);

    // What the voice model is handed about it.
    const spoken = JSON.parse(
      toAgentResult({ callId: 'c', tool: 'memory.save', ok: false, failure: result.failure!, durationMs: 1 }),
    ) as { ok: boolean; error: string; guidance: string };
    expect(spoken.ok).toBe(false);
    expect(spoken.error).toMatch(/could not save/);

    // And the next conversation has nothing to recall.
    r.provider.endSession();
    expect(await until(() => r.orchestrator.state === 'IDLE')).toBe(true);
    await r.start();
    expect(await until(() => r.provider.received.filter((m) => m.type === 'session.update').length === 2)).toBe(true);
    expect(latestPrompt(r)).not.toContain('- person: name — Vishal');
  });

  it('memory.search finds what was saved', async () => {
    const store = new InMemoryMemories();
    store.saveMemory({ category: 'person', key: 'name', value: 'Vishal', source: 'user', sensitivity: 'personal' });
    const r = await conversation(store);

    await r.say("What's my name?");
    const found = await r.call('memory.search', { query: 'name' });
    expect(found).toMatchObject({ ok: true, output: { count: 1, memories: [{ key: 'name', value: 'Vishal' }] } });
  });
});

describe('across a session boundary', () => {
  it('saved in one conversation, recalled at the start of the next', async () => {
    // "Remember that my name is Vishal." ... later, a new conversation:
    // "What's my name?" -> the fact is already in front of the model.
    const store = new InMemoryMemories();
    const r = await conversation(store);
    expect(await until(() => latestPrompt(r) !== '')).toBe(true);
    expect(latestPrompt(r)).not.toContain('- person: name — Vishal');

    await remember(r, 'Vishal');
    expect(await until(() => store.entries.length === 1)).toBe(true);

    r.provider.endSession();
    expect(await until(() => r.orchestrator.state === 'IDLE')).toBe(true);

    await r.start();
    expect(await until(() => r.provider.received.filter((m) => m.type === 'session.update').length === 2)).toBe(true);
    expect(latestPrompt(r)).toContain('- person: name — Vishal');
  });
});

describe('nothing is saved just because it was said', () => {
  it('an ordinary conversation writes no memory', async () => {
    const store = new InMemoryMemories();
    const r = await conversation(store);

    await r.say('My name is Vishal.');
    await r.say('What time is it?');
    await r.call('system.time', {});
    await r.say('I like dark mode.');
    await r.endReply();

    expect(store.saveCalls).toBe(0);
    expect(store.entries).toEqual([]);
  });

  it('the model is told to save only when asked, and not to claim it early', async () => {
    const r = await conversation(new InMemoryMemories());
    expect(await until(() => latestPrompt(r) !== '')).toBe(true);
    const prompt = latestPrompt(r);
    expect(prompt).toMatch(/Save something only when the user explicitly asks you to/);
    expect(prompt).toMatch(/Never save a fact just because it came up/);
    expect(prompt).toMatch(/until memory\.save has come back with saved: true/);
    expect(prompt).toMatch(/If it fails or is not approved, say plainly that it was not saved/);
  });
});
