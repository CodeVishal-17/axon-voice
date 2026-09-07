/**
 * The authoritative state machine, and the orchestrator that owns it.
 *
 * The property under test is authority: the machine refuses illegal moves, and
 * a request from outside the main process is a proposal that can be refused —
 * not a setter.
 */

import { describe, expect, it, vi } from 'vitest';
import { IllegalTransitionError, type AxonEvent } from '@axon/core';
import { AxonStateMachine, type StateChange } from '../src/main/orchestrator/state-machine';
import { Orchestrator } from '../src/main/orchestrator/orchestrator';
import { EventBus } from '../src/main/bus/event-bus';
import { ToolRegistry } from '../src/main/tools/registry';

describe('AxonStateMachine', () => {
  it('starts IDLE', () => {
    expect(new AxonStateMachine(() => {}).state).toBe('IDLE');
  });

  it('reports the change to its listener', () => {
    const changes: StateChange[] = [];
    const machine = new AxonStateMachine((change) => changes.push(change));

    machine.transition('LISTENING', 'hotkey pressed');

    expect(machine.state).toBe('LISTENING');
    expect(changes).toEqual([{ from: 'IDLE', to: 'LISTENING', reason: 'hotkey pressed' }]);
  });

  it('throws on an illegal transition and does not move', () => {
    const onChange = vi.fn();
    const machine = new AxonStateMachine(onChange);

    expect(() => machine.transition('EXECUTING', 'skip ahead')).toThrow(IllegalTransitionError);
    expect(machine.state).toBe('IDLE');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports rather than throws for a proposed transition', () => {
    const machine = new AxonStateMachine(() => {});

    const refused = machine.tryTransition('EXECUTING', 'skip ahead');
    expect(refused.accepted).toBe(false);
    expect(refused.state).toBe('IDLE');
    expect(refused.error).toContain('IDLE -> EXECUTING');

    const accepted = machine.tryTransition('THINKING', 'understood');
    expect(accepted).toEqual({ accepted: true, state: 'THINKING', error: null });
  });

  it('refuses a self-transition, so no event can claim a change that did not happen', () => {
    const machine = new AxonStateMachine(() => {});
    expect(machine.tryTransition('IDLE', 'again').accepted).toBe(false);
  });

  it('walks a full task lifecycle', () => {
    const machine = new AxonStateMachine(() => {});
    for (const step of ['LISTENING', 'THINKING', 'WAITING_FOR_APPROVAL', 'EXECUTING', 'SPEAKING', 'IDLE'] as const) {
      expect(machine.tryTransition(step, 'step').accepted).toBe(true);
    }
    expect(machine.state).toBe('IDLE');
  });
});

describe('Orchestrator', () => {
  function build(): { orchestrator: Orchestrator; events: AxonEvent[] } {
    const bus = new EventBus();
    const events: AxonEvent[] = [];
    bus.subscribe((event) => events.push(event));

    const orchestrator = new Orchestrator({
      bus,
      registry: new ToolRegistry(),
      approvalTimeoutMs: 1_000,
      devConsoleEnabled: true,
    });

    return { orchestrator, events };
  }

  it('emits STATE_CHANGED for every accepted move', () => {
    const { orchestrator, events } = build();
    orchestrator.requestState('LISTENING', 'test');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'STATE_CHANGED', from: 'IDLE', to: 'LISTENING', reason: 'test' });
  });

  it('emits nothing when a proposal is refused', () => {
    const { orchestrator, events } = build();
    const outcome = orchestrator.requestState('EXECUTING', 'test');

    expect(outcome.accepted).toBe(false);
    expect(events).toHaveLength(0);
    expect(orchestrator.state).toBe('IDLE');
  });

  it('routes IDLE -> EXECUTING through THINKING rather than forcing an illegal hop', () => {
    // Acting without having understood is exactly what the table forbids, so
    // the orchestrator passes through THINKING and the timeline says so.
    const { orchestrator, events } = build();
    orchestrator.enterExecuting('running a tool');

    expect(orchestrator.state).toBe('EXECUTING');
    expect(events.map((e) => (e.type === 'STATE_CHANGED' ? e.to : e.type))).toEqual(['THINKING', 'EXECUTING']);
  });

  it('routes IDLE -> WAITING_FOR_APPROVAL through THINKING', () => {
    const { orchestrator } = build();
    orchestrator.enterAwaitingApproval('needs a decision');
    expect(orchestrator.state).toBe('WAITING_FOR_APPROVAL');
  });

  it('treats settle as a no-op when already at rest', () => {
    const { orchestrator, events } = build();
    orchestrator.settle('nothing to do');
    expect(orchestrator.state).toBe('IDLE');
    expect(events).toHaveLength(0);
  });

  it('settles from every working state', () => {
    for (const entry of ['EXECUTING', 'WAITING_FOR_APPROVAL'] as const) {
      const { orchestrator } = build();
      if (entry === 'EXECUTING') orchestrator.enterExecuting('x');
      else orchestrator.enterAwaitingApproval('x');

      orchestrator.settle('finished');
      expect(orchestrator.state).toBe('IDLE');
    }
  });

  it('exposes a snapshot the renderer can render from cold', () => {
    const { orchestrator } = build();
    orchestrator.requestState('THINKING', 'test');

    const snapshot = orchestrator.snapshot();
    expect(snapshot.state).toBe('THINKING');
    expect(snapshot.sessionId).toBeTruthy();
    expect(snapshot.devConsoleEnabled).toBe(true);
    expect(snapshot.pendingApprovals).toEqual([]);
    expect(snapshot.events.at(-1)).toMatchObject({ type: 'STATE_CHANGED', to: 'THINKING' });
  });
});
