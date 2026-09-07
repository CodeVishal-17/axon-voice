/**
 * Developer Tool Console.
 *
 * A harness, not a demo. Each button dispatches a real `ToolCall` through the
 * same `Dispatcher` the brain will use in Step 2 — the same schema validation,
 * the same dynamic risk resolution, the same approval gate, the same
 * executors, the same events. Nothing here has a shortcut.
 *
 * The buttons are chosen to exercise every branch of the safety layer, so the
 * policy engine is demonstrable rather than merely asserted:
 *
 *   workspace write   SAFE               runs immediately
 *   outside write     REQUIRES_APPROVAL  opens the approval dialog
 *   System32 write    FORBIDDEN          refused, no prompt offered
 *   unknown tool      deny-by-default    refused before anything is resolved
 *   bad argument      INVALID_INPUT      rejected by the schema
 *
 * The state buttons propose transitions to the main-process machine. Requesting
 * an illegal one is worth trying: the machine refuses and says why, which is
 * what "the renderer does not own the state" looks like from the outside.
 *
 * The whole panel is refused by the main process outside development; this
 * component only decides whether to draw it.
 */

import { useState } from 'react';
import { AXON_STATES, type AxonState, type JsonValue, type ToolResult } from '@axon/core';

export interface ToolConsoleProps {
  readonly state: AxonState;
  readonly invokeTool: (tool: string, input: JsonValue) => Promise<ToolResult>;
  readonly requestState: (to: AxonState, reason: string) => Promise<unknown>;
}

interface ToolAction {
  readonly label: string;
  readonly hint: string;
  readonly tool: string;
  readonly input: JsonValue;
}

const ACTIONS: readonly ToolAction[] = [
  {
    label: 'Open Notepad',
    hint: 'app.open · SAFE',
    tool: 'app.open',
    input: { app: 'notepad' },
  },
  {
    label: 'Take Screenshot',
    hint: 'system.screenshot · SAFE',
    tool: 'system.screenshot',
    input: { label: 'console' },
  },
  {
    label: 'Write in workspace',
    hint: 'fs.write · SAFE',
    tool: 'fs.write',
    input: {
      path: 'tool-console-test.txt',
      content: 'Written by the Axon developer Tool Console through the real dispatcher.\n',
      overwrite: true,
    },
  },
  {
    label: 'Write outside workspace',
    hint: 'fs.write · needs approval',
    // Relative, so it resolves just outside the workspace root on any machine
    // without the renderer needing to know the user's home directory.
    tool: 'fs.write',
    input: {
      path: '../approval-demo.txt',
      content: 'This write happened outside the Axon workspace, with approval.\n',
      overwrite: true,
    },
  },
  {
    label: 'Write to System32',
    hint: 'fs.write · FORBIDDEN',
    tool: 'fs.write',
    input: { path: 'C:\\Windows\\System32\\axon-should-never-write.txt', content: 'no', overwrite: true },
  },
  {
    label: 'Unknown tool',
    hint: 'deny-by-default',
    tool: 'shell.execute',
    input: { command: 'whoami' },
  },
  {
    label: 'Invalid argument',
    hint: 'schema rejection',
    tool: 'app.open',
    input: { app: 'chrome' },
  },
];

function describe(result: ToolResult): string {
  if (result.ok) return `OK · ${JSON.stringify(result.output)}`;
  return `${result.failure.kind} · ${result.failure.message}`;
}

export function ToolConsole({ state, invokeTool, requestState }: ToolConsoleProps): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const run = async (action: ToolAction): Promise<void> => {
    setBusy(action.label);
    setLastResult(null);
    try {
      const result = await invokeTool(action.tool, action.input);
      setLastResult(describe(result));
    } catch (error) {
      setLastResult(`bridge error · ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const propose = async (target: AxonState): Promise<void> => {
    try {
      const outcome = (await requestState(target, 'Requested from the developer console')) as {
        accepted: boolean;
        state: AxonState;
        error: string | null;
      };
      setLastResult(
        outcome.accepted
          ? `state → ${outcome.state}`
          : `refused · ${outcome.error ?? 'illegal transition'}`,
      );
    } catch (error) {
      setLastResult(`bridge error · ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <section className="console" aria-label="Developer tool console">
      <header className="panel-header">
        <h2>Tool Console</h2>
        <span className="panel-tag">dev</span>
      </header>

      <div className="console-group">
        {ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            className="chip"
            disabled={busy !== null}
            onClick={() => {
              void run(action);
            }}
          >
            <span className="chip-label">{busy === action.label ? 'Running…' : action.label}</span>
            <span className="chip-hint">{action.hint}</span>
          </button>
        ))}
      </div>

      <div className="console-group console-states">
        <span className="console-group-label">Propose state</span>
        {AXON_STATES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={`pill${candidate === state ? ' pill-current' : ''}`}
            onClick={() => {
              void propose(candidate);
            }}
          >
            {candidate.replace(/_/g, ' ').toLowerCase()}
          </button>
        ))}
      </div>

      <p className={`console-result${lastResult ? '' : ' console-result-empty'}`}>
        {lastResult ?? 'Results from the dispatcher appear here.'}
      </p>
    </section>
  );
}
