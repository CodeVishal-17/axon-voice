/**
 * Runtime configuration.
 *
 * Kept as a pure function of (home directory, environment, dev flag) so the
 * whole configuration — including the security-relevant path allowlists — can
 * be constructed in a test without Electron.
 */

import path from 'node:path';

export interface RuntimeConfig {
  /** Root of everything Axon owns on disk. Visible to the user by design. */
  readonly axonHome: string;
  /** The one directory the agent may write to without asking. */
  readonly workspaceRoot: string;
  readonly screenshotDir: string;
  readonly logDir: string;
  readonly eventLogPath: string;
  /**
   * The SQLite database.
   *
   * Derived from `axonHome` and nothing else. The model cannot influence it —
   * there is no tool that takes a database path — and neither can the
   * renderer: the settings surface exposes a workspace, which is a different
   * value used for a different purpose and can never become this one.
   * `persistence-security.test.ts` asserts both.
   */
  readonly databasePath: string;
  /**
   * Where Chromium actually keeps the browser profile.
   *
   * NOT a directory Axon invents: a `persist:` partition is stored by Chromium
   * under the session-data directory, and this is the same location computed
   * the same way. Getting it wrong would be worse than not having it, because
   * it appears on `forbiddenRoots` — a made-up path there protects nothing
   * while reading as though it does.
   */
  readonly browserProfileDir: string;
  /** Directories the agent may never write to, at any risk level. */
  readonly forbiddenRoots: readonly string[];
  readonly approvalTimeoutMs: number;
  readonly devConsoleEnabled: boolean;
  /**
   * Where a demo recording is written, and whether one is made at all.
   *
   * Two conditions, not one: a development build AND `AXON_DEMO_RECORDING=1`.
   * A packaged Axon cannot be made to record by setting an environment
   * variable, and a developer cannot start recording by accident. The file
   * sits beside the event log because it is the same kind of artifact — a
   * record of what happened, written for the person debugging it afterwards.
   */
  readonly demoRecordingEnabled: boolean;
  readonly demoRecordingPath: string;
  /**
   * Wake-word diagnostics: what the local recognizer heard, and why it did or
   * did not wake. Development builds only, and only with AXON_WAKE_DEBUG=1.
   * Printed to the developer console — never written to the event log, never
   * sent anywhere, and it never includes audio.
   */
  readonly wakeDebugEnabled: boolean;
  /**
   * Voice-path diagnostics: capture format and cadence, frames reaching main,
   * audio sent to AssemblyAI, socket queueing, and the provider's partial and
   * final transcripts. Development builds only, with AXON_VOICE_DEBUG=1. To the
   * developer console; never the event log, never IPC, never audio.
   */
  readonly voiceDebugEnabled: boolean;
  /**
   * Which local wake-word engine to arm: 'keyword' (the default dedicated
   * keyword spotter), 'windows' (the original speech recognizer, kept as the
   * control arm), or 'none'.
   *
   * Carried raw rather than parsed here because `create-wake-detector.ts` is
   * where an unknown value has to become a sentence a person can read, and a
   * config file that silently corrected it would hide a typo that leaves Axon
   * not listening.
   */
  readonly wakeEngine: string | undefined;
  /**
   * `AXON_WAKE_THRESHOLD`: the keyword spotter's detection threshold.
   *
   * Exists for `npm run wake:calibrate`, which sweeps it. Unset — the normal
   * case — means the measured default in `wake-keywords.ts`.
   */
  readonly wakeThreshold: string | undefined;
  /**
   * `AXON_WAKE_CALIBRATE`: a comma-separated list of extra thresholds to
   * measure alongside the real one, for `npm run wake:calibrate`.
   *
   * Development builds only. Each entry is a whole speech model in a process
   * of its own, so a packaged Axon must not be persuadable to run five of them
   * by setting an environment variable.
   */
  readonly wakeCalibrate: string | undefined;
  /** `AXON_WAKE_FOCUS`: keyword id for the focus diagnostic. Development builds only. */
  readonly wakeFocus: string | undefined;
  /**
   * `AXON_CAPTURE_PROCESSING`: a controlled A/B of the browser's microphone
   * processing, e.g. `ec=off`. Development builds only; a packaged Axon always
   * captures with the defaults. Main decides it; the renderer is only told.
   */
  readonly captureProcessing: string | undefined;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

function parseTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_APPROVAL_TIMEOUT_MS;
  const value = Number.parseInt(raw, 10);
  // A zero or negative timeout would mean "deny instantly"; a NaN would mean
  // "never time out". Both are worse than the default, so fall back.
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_APPROVAL_TIMEOUT_MS;
}

/**
 * The session Axon's browser runs in.
 *
 * Declared here rather than in the browser module because the profile's
 * on-disk location is derived from it, and that location has to be protected
 * by the path policy. One constant, so the two can never drift apart.
 */
export const BROWSER_PARTITION = 'persist:axon-browser';

export interface ConfigInputs {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly isDev: boolean;
  /**
   * Electron's `sessionData` path. Chromium stores every named partition
   * beneath it, so it is where the browser profile really lives.
   */
  readonly sessionData: string;
}

export function resolveRuntimeConfig({ home, env, isDev, sessionData }: ConfigInputs): RuntimeConfig {
  const axonHome = env.AXON_HOME && env.AXON_HOME.trim() !== '' ? path.resolve(env.AXON_HOME) : path.join(home, 'Axon');

  const logDir = path.join(axonHome, 'logs');
  // Chromium's own layout for a named partition: <sessionData>/Partitions/<name>.
  const browserProfileDir = path.join(
    path.resolve(sessionData),
    'Partitions',
    BROWSER_PARTITION.replace(/^persist:/, ''),
  );
  // Application state, kept apart from the workspace the agent writes into.
  // A user browsing their workspace should not find Axon's database in it, and
  // `fs.write` — which may be approved for the workspace — must never be
  // pointed at the file holding their conversation history.
  const dataDir = path.join(axonHome, 'data');

  // System locations plus Axon's own log and data directories. The audit trail
  // must not be rewritable by the agent it is about, and neither must the
  // database or the browser profile.
  const forbiddenRoots = [
    env.SystemRoot,
    env.windir,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramData,
    logDir,
    // Axon's own state joins the audit log on the forbidden list. The agent
    // must not be able to write over the database that records what it did,
    // nor into the browser profile that holds the user's sessions — not even
    // with approval, because no user can meaningfully consent to a write whose
    // target they cannot inspect.
    //
    // The browser profile matters more since the workspace became a setting:
    // a workspace pointed at the profile directory would otherwise put a
    // cookie store inside the one place `fs.write` may write. `resolvePath`
    // checks the forbidden roots BEFORE the workspace, so this wins.
    dataDir,
    browserProfileDir,
  ]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => path.resolve(entry));

  return {
    axonHome,
    workspaceRoot: path.join(axonHome, 'workspace'),
    screenshotDir: path.join(axonHome, 'screenshots'),
    logDir,
    eventLogPath: path.join(logDir, 'events.jsonl'),
    databasePath: path.join(dataDir, 'axon.db'),
    browserProfileDir,
    forbiddenRoots: Array.from(new Set(forbiddenRoots)),
    approvalTimeoutMs: parseTimeout(env.AXON_APPROVAL_TIMEOUT_MS),
    devConsoleEnabled: isDev,
    demoRecordingEnabled: isDev && env.AXON_DEMO_RECORDING === '1',
    demoRecordingPath: path.join(logDir, 'demo-recording.jsonl'),
    wakeDebugEnabled: isDev && env.AXON_WAKE_DEBUG === '1',
    voiceDebugEnabled: isDev && env.AXON_VOICE_DEBUG === '1',
    wakeEngine: env.AXON_WAKE_ENGINE,
    wakeThreshold: env.AXON_WAKE_THRESHOLD,
    wakeCalibrate: isDev ? env.AXON_WAKE_CALIBRATE : undefined,
    wakeFocus: isDev ? env.AXON_WAKE_FOCUS : undefined,
    captureProcessing: isDev ? env.AXON_CAPTURE_PROCESSING : undefined,
  };
}
