/**
 * Windows offline speech-to-text.
 *
 * ARCHITECTURAL NOTE — read before editing.
 *
 * The counterpart to `sapi-tts.ts`, and built the same way for the same
 * reasons. It is the only module in Axon that turns audio into text, and
 * everything above it depends on the `SpeechToText` interface in `@axon/core`,
 * so replacing this with Whisper or a cloud recognizer is a change to
 * `create-stt.ts` and a new file beside this one.
 *
 * WHY THIS ENGINE. `System.Speech.Recognition` ships with Windows. It needs no
 * API key, no account, no model download, no native compilation and no
 * network, and it is the only one of those options that is true of. The audio
 * never leaves the machine, so there is no transport to secure, no endpoint to
 * pin and no third party to trust. See `create-stt.ts` for the full comparison.
 *
 * SECURITY — what crosses the boundary.
 *
 *   - The PowerShell program is a MODULE CONSTANT. Nothing is interpolated
 *     into it — not a path, not a device name, not a grammar. Reading `SCRIPT`
 *     below tells you the entire program that will ever run.
 *   - Audio arrives on the child's STDIN as raw 16-bit PCM and is read through
 *     `[Console]::OpenStandardInput()`. It never becomes a file, never becomes
 *     an argument, and never becomes part of the program.
 *   - The recognised text comes back base64-encoded on stdout, one line per
 *     phrase. Base64 removes an entire class of pipe-encoding corruption, and
 *     it also means a transcript can never contain a newline that would let it
 *     forge a second line of protocol.
 *   - The child gets no shell: `spawn` is called with an argv array and
 *     `shell: false`.
 *   - The child gets no secrets. It is spawned with a fixed allowlist of six
 *     environment variables (see `recognizerEnvironment`), so the AssemblyAI
 *     key Axon's main process holds is not even present in the recognizer's
 *     environment — least of all in the one that listens while Axon is idle.
 *
 * NOTHING TOUCHES DISK. The audio lives in a `MemoryStream` inside the child
 * and in the pipe between the two processes. There is no temporary WAV file at
 * any point, which is what makes "Axon never records you to disk" a property
 * of the design rather than a promise about cleanup.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  LISTENING_LIMITS,
  type SpeechToText,
  type SpeechToTextOptions,
  type SpeechToTextSession,
  type TranscriptChunk,
} from '@axon/core';

/**
 * The complete program run in the child process.
 *
 * A module constant, never a template. See the security note above.
 *
 * The engine and its grammar are loaded BEFORE the first byte of audio is
 * read, and `READY` is printed the moment they are. That ordering is what
 * makes the interaction feel immediate: the process is started when the user
 * presses the hotkey, so .NET, the recognizer and the dictation grammar all
 * load while the user is still drawing breath, and by the time they stop
 * speaking the only work left is the recognition itself.
 */
const HEADER = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Speech',
  '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(' +
    '16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, ' +
    '[System.Speech.AudioFormat.AudioChannel]::Mono)',
  '$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
];

/**
 * Free-form dictation, for push-to-talk: Axon's premise is that the model
 * interprets what was said, so constraining the recognizer to a phrase list
 * would constrain the product.
 */
const DICTATION_GRAMMAR = [
  '$dictation = New-Object System.Speech.Recognition.DictationGrammar',
  "$dictation.Name = 'dictation'",
  '$engine.LoadGrammar($dictation)',
];

/**
 * The wake grammars: the phrase, and the things that merely sound like it.
 *
 * WHY THERE IS NO DICTATION HERE ANY MORE. The first wake grammar ran beside
 * free dictation, so that ordinary speech would be recognised as ordinary
 * speech. On synthesised voices that worked. On a real person's microphone it
 * did not: dictation's language model out-competed the wake grammar every
 * time, and "Hey Axon", "Hello Axon" and "Hi Axon" came back as "But who",
 * "And who" and "New song". A wake phrase that loses to the most likely
 * English sentence can never win.
 *
 * WHY A GRAMMAR ON ITS OWN IS STILL NOT ENOUGH. With nothing to compete
 * against, a grammar forces whatever it hears onto the nearest thing it
 * knows. Measured on the Windows recognizer: "Axon", "Taxon", "action",
 * "Hey Jackson" and "I was talking about Axon yesterday" all came back as a
 * wake phrase — ten false wakes in fifty-two.
 *
 * SO THE COMPETITOR IS A LIST OF NEAR MISSES. Each half of the phrase on its
 * own ("hey", "axon"), the words it is most often confused with ("action",
 * "exon", "taxon", "oxen"), the greeting with other names ("hey jackson",
 * "hey siri"), and short everyday words. Speech that is not a wake phrase has
 * somewhere closer to land. Measured on the same engine: 22 of 24 wake phrases
 * matched, and none of 52 non-wake utterances did.
 *
 * What the list deliberately does NOT contain is what the human microphone
 * test produced ("but who", "and who", "new song"). Putting a real mishearing
 * of the wake phrase into the competitor would teach the recognizer to reject
 * the person it is supposed to hear. Those phrases are tested as negatives
 * instead, and they must not wake Axon on their own merits.
 *
 * Every string here is a constant; nothing is interpolated.
 */
const WAKE_GRAMMAR = [
  '$wakeBuilder = New-Object System.Speech.Recognition.GrammarBuilder',
  "$wakeBuilder.Append((New-Object System.Speech.Recognition.Choices([string[]]@('hey', 'hello', 'hi'))))",
  "$wakeBuilder.Append('axon')",
  '$wake = New-Object System.Speech.Recognition.Grammar($wakeBuilder)',
  "$wake.Name = 'wake'",
  '$engine.LoadGrammar($wake)',
  "[Console]::Out.WriteLine('GRAMMAR wake')",
  '$nearBuilder = New-Object System.Speech.Recognition.GrammarBuilder',
  "$nearBuilder.Append((New-Object System.Speech.Recognition.Choices([string[]]@(" +
    "'hey', 'hello', 'hi', 'axon', 'axons', 'taxon', 'action', 'actions', 'exon', 'accent', 'access', 'axel', " +
    "'oxen', 'jackson', 'saxon', 'hey alex', 'hey jackson', 'hey siri', 'hi there', 'hello there', 'hey you', " +
    "'hi everyone', 'hello everyone', 'eight', 'song', 'who', 'own', 'okay', 'yes', 'no', 'thanks', 'thank you', " +
    "'what', 'open'))))",
  '$near = New-Object System.Speech.Recognition.Grammar($nearBuilder)',
  "$near.Name = 'near-miss'",
  '$engine.LoadGrammar($near)',
  "[Console]::Out.WriteLine('GRAMMAR near-miss')",
];

/**
 * The wake session's body: the same batch shape as dictation's, plus the
 * recognizer's own account of itself for developer diagnostics.
 *
 * Before READY it names the engine, its culture and the audio format. While
 * recognising it reports SPEECH when the engine detects speech and REJECTED
 * with the engine's best guess when a candidate falls below its rejection
 * threshold, so "not heard", "heard and rejected" and "heard as something
 * else" are three different lines rather than one silence. A result from the
 * wake grammar is WAKE; one from the near-miss grammar is NEAR. Both carry
 * the matched audio's position and duration in milliseconds, so the detector
 * can tell a phrase said on its own from one found inside a sentence.
 */
const WAKE_BODY = [
  "[Console]::Out.WriteLine('RECOGNIZER ' + $engine.RecognizerInfo.Culture.Name + ' ' + " +
    '[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($engine.RecognizerInfo.Name)))',
  "[Console]::Out.WriteLine('FORMAT 16000 16 mono')",
  "$null = Register-ObjectEvent -InputObject $engine -EventName SpeechDetected -SourceIdentifier 'detected'",
  "$null = Register-ObjectEvent -InputObject $engine -EventName SpeechRecognitionRejected -SourceIdentifier 'rejected'",
  "[Console]::Out.WriteLine('READY')",
  '[Console]::Out.Flush()',
  // Audio is DATA arriving on stdin. It is never part of this program.
  '$audio = New-Object System.IO.MemoryStream',
  '[Console]::OpenStandardInput().CopyTo($audio)',
  '$audio.Position = 0',
  "[Console]::Out.WriteLine('AUDIO ' + $audio.Length)",
  '[Console]::Out.Flush()',
  '$engine.SetInputToAudioStream($audio, $fmt)',
  '$inv = [System.Globalization.CultureInfo]::InvariantCulture',
  // Bounded: a short utterance holds at most a few phrases.
  'for ($attempt = 0; $attempt -lt 6; $attempt++) {',
  '  $r = $null',
  '  try { $r = $engine.Recognize() } catch { break }',
  '  $rejected = $null',
  '  foreach ($ev in @(Get-Event -ErrorAction SilentlyContinue)) {',
  "    if ($ev.SourceIdentifier -eq 'detected') { [Console]::Out.WriteLine('SPEECH') }",
  "    if ($ev.SourceIdentifier -eq 'rejected') { $rejected = $ev.SourceEventArgs.Result }",
  '    Remove-Event -EventIdentifier $ev.EventIdentifier',
  '  }',
  '  if ($null -eq $r) {',
  '    if ($null -eq $rejected) { break }',
  '    $rb = [System.Text.Encoding]::UTF8.GetBytes([string]$rejected.Text)',
  "    [Console]::Out.WriteLine('REJECTED ' + $rejected.Confidence.ToString('0.000', $inv) + ' ' + [Convert]::ToBase64String($rb))",
  '    [Console]::Out.Flush()',
  '    continue',
  '  }',
  '  $b = [System.Text.Encoding]::UTF8.GetBytes($r.Text)',
  "  $start = '-1'",
  "  $duration = '-1'",
  '  if ($null -ne $r.Audio) {',
  '    $start = [string][int]$r.Audio.AudioPosition.TotalMilliseconds',
  '    $duration = [string][int]$r.Audio.Duration.TotalMilliseconds',
  '  }',
  "  $verb = 'NEAR '",
  "  if ($r.Grammar.Name -eq 'wake') { $verb = 'WAKE ' }",
  "  [Console]::Out.WriteLine($verb + $r.Confidence.ToString('0.000', $inv) + ' ' + [Convert]::ToBase64String($b) + ' ' + $start + ' ' + $duration)",
  '  [Console]::Out.Flush()',
  '}',
  "[Console]::Out.WriteLine('END')",
  '[Console]::Out.Flush()',
  '$engine.Dispose()',
  '$audio.Dispose()',
];

/**
 * Everything after the grammars: announce READY, read the audio, recognise.
 *
 * The engine and its grammars are loaded BEFORE the first byte of audio is
 * read, and READY is printed the moment they are, so by the time somebody
 * stops speaking the only work left is the recognition itself.
 *
 * A result from the wake grammar is reported as WAKE, anything else as
 * PHRASE, so the process on the other side of the pipe can tell "the wake
 * grammar matched" from "some words were recognised" without trusting the
 * text to say so.
 */
const BODY = [
  "[Console]::Out.WriteLine('READY')",
  '[Console]::Out.Flush()',
  // Audio is DATA arriving on stdin. It is never part of this program.
  '$audio = New-Object System.IO.MemoryStream',
  '[Console]::OpenStandardInput().CopyTo($audio)',
  '$audio.Position = 0',
  "[Console]::Out.WriteLine('AUDIO ' + $audio.Length)",
  '[Console]::Out.Flush()',
  '$engine.SetInputToAudioStream($audio, $fmt)',
  'while ($true) {',
  // Recognize() returns one phrase at a time and throws rather than returning
  // null once the stream is exhausted, so both endings are handled.
  '  try { $r = $engine.Recognize() } catch { break }',
  '  if ($null -eq $r) { break }',
  '  $b = [System.Text.Encoding]::UTF8.GetBytes($r.Text)',
  "  $verb = 'PHRASE '",
  "  if ($r.Grammar.Name -eq 'wake') { $verb = 'WAKE ' }",
  "  [Console]::Out.WriteLine($verb + $r.Confidence.ToString('0.000', " +
    '[System.Globalization.CultureInfo]::InvariantCulture) + ' +
    "' ' + [Convert]::ToBase64String($b))",
  '  [Console]::Out.Flush()',
  '}',
  "[Console]::Out.WriteLine('END')",
  '[Console]::Out.Flush()',
  '$engine.Dispose()',
  '$audio.Dispose()',
];

/** The dictation program. A module constant, never a template. */
const SCRIPT = [...HEADER, ...DICTATION_GRAMMAR, ...BODY].join('\n');

/** The wake-word program. Also a module constant, never a template. */
const WAKE_SCRIPT = [...HEADER, ...WAKE_GRAMMAR, ...WAKE_BODY].join('\n');

const POWERSHELL = 'powershell.exe';

/**
 * The complete argv Axon spawns. Every element is a constant.
 *
 * `-NoProfile` stops a user profile script from running first;
 * `-NonInteractive` stops any prompt from blocking forever.
 */
const DEFAULT_ARGS: readonly string[] = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT];

/** The argv for a wake session: the same shape, the other constant program. */
const WAKE_ARGS: readonly string[] = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WAKE_SCRIPT];

/**
 * Longest line accepted on the child's stdout.
 *
 * Twenty seconds of speech is a few hundred characters. This is three orders
 * of magnitude above that, so it bounds memory without ever being reached by
 * anything a person said.
 */
const MAX_LINE_BYTES = 64 * 1024;

/**
 * The only environment variables a recognizer process is given.
 *
 * Enough for Windows PowerShell and .NET to start, and nothing else. Axon's
 * main process holds the AssemblyAI key in its environment; a child spawned
 * with the default environment would inherit it. The wake recognizer runs for
 * hours while nobody is talking to Axon, so it is exactly the process that
 * should hold nothing worth taking.
 */
const RECOGNIZER_ENV_NAMES: readonly string[] = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'Path'];

/** Build a recognizer's environment from the allowlist. Names match case-insensitively, as Windows does. */
export function recognizerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys = Object.keys(source);
  for (const name of RECOGNIZER_ENV_NAMES) {
    const key = keys.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const value = key === undefined ? undefined : source[key];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  return env;
}

/** How long the recognizer has to load before Axon gives up on it. */
const WARMUP_TIMEOUT_MS = 12_000;

export interface WindowsSttOptions {
  /** Injected in tests. Defaults to the real Windows PowerShell. */
  readonly executable?: string;
  /**
   * Argv override. TESTS ONLY — see the note below.
   *
   * Together with `executable` this is what lets the protocol handling below
   * be exercised against a stand-in child on any platform. It is a real seam
   * and worth being explicit about: anything that could set it could choose
   * the program that runs.
   *
   * That is why nothing outside a test does. `create-stt.ts` is the single
   * place this class is constructed in the product, it passes only `platform`,
   * and `listening-security.test.ts` asserts that — so the constant argv below
   * is the only one Axon ever spawns.
   */
  readonly args?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly warmupTimeoutMs?: number;
  readonly transcriptionTimeoutMs?: number;
  readonly maxAudioBytes?: number;
}

export class SpeechRecognitionError extends Error {
  readonly kind: 'UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED' | 'PROVIDER' | 'TOO_LARGE';

  constructor(kind: SpeechRecognitionError['kind'], message: string) {
    super(message);
    this.name = 'SpeechRecognitionError';
    this.kind = kind;
  }
}

export class WindowsSpeechToText implements SpeechToText {
  readonly name = 'windows-speech';
  readonly sampleRate = LISTENING_LIMITS.sampleRate;

  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly wakeArgs: readonly string[];
  private readonly platform: NodeJS.Platform;
  private readonly warmupTimeoutMs: number;
  private readonly transcriptionTimeoutMs: number;
  private readonly maxAudioBytes: number;

  /**
   * Set when the engine proves to be missing rather than merely slow.
   *
   * Once this is set the provider reports itself unavailable and the UI stops
   * offering to listen, which is what prevents an activation loop against a
   * machine that has no recognizer installed.
   */
  private unavailable: string | null = null;

  constructor(options: WindowsSttOptions = {}) {
    this.executable = options.executable ?? POWERSHELL;
    this.args = options.args ?? DEFAULT_ARGS;
    // A test that overrides the program overrides it for both modes: the
    // stand-in child decides its behaviour from its own arguments.
    this.wakeArgs = options.args ?? WAKE_ARGS;
    this.platform = options.platform ?? process.platform;
    this.warmupTimeoutMs = options.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS;
    this.transcriptionTimeoutMs = options.transcriptionTimeoutMs ?? LISTENING_LIMITS.transcriptionTimeoutMs;
    this.maxAudioBytes = options.maxAudioBytes ?? LISTENING_LIMITS.maxAudioBytes;
  }

  /** The Windows recognizer is a Windows facility. Nothing here pretends
   *  otherwise, and a proven-missing engine disables itself. */
  isAvailable(): boolean {
    return this.platform === 'win32' && this.unavailable === null;
  }

  /** Why the provider is unusable, or null. Never a path or a credential. */
  unavailableReason(): string | null {
    if (this.platform !== 'win32') return 'Windows speech recognition is only available on Windows.';
    return this.unavailable;
  }

  start(onChunk: (chunk: TranscriptChunk) => void, options: SpeechToTextOptions = {}): Promise<SpeechToTextSession> {
    if (!this.isAvailable()) {
      return Promise.reject(
        new SpeechRecognitionError('UNAVAILABLE', this.unavailableReason() ?? 'Speech recognition is unavailable.'),
      );
    }

    return new Promise<SpeechToTextSession>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(
          this.executable,
          // An array, never a command string, and every element of the default
          // is a constant. There is no command line here for anything to be
          // injected into, and nothing variable reaches the child except the
          // audio on its stdin.
          [...(options.mode === 'wake' ? this.wakeArgs : this.args)],
          { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: recognizerEnvironment() },
        );
      } catch (error) {
        reject(
          new SpeechRecognitionError(
            'UNAVAILABLE',
            `Could not start the Windows speech recognizer: ${error instanceof Error ? error.message : 'unknown'}`,
          ),
        );
        return;
      }

      const session = new WindowsSttSession(child, onChunk, {
        onDiagnostic: options.onDiagnostic ?? null,
        transcriptionTimeoutMs: this.transcriptionTimeoutMs,
        maxAudioBytes: this.maxAudioBytes,
        onUnavailable: (reason) => {
          this.unavailable = reason;
        },
      });

      const warmup = setTimeout(() => {
        session.close();
        reject(new SpeechRecognitionError('TIMEOUT', 'The speech recognizer took too long to start.'));
      }, this.warmupTimeoutMs);
      if (typeof warmup.unref === 'function') warmup.unref();

      session
        .ready()
        .then(() => {
          clearTimeout(warmup);
          resolve(session);
        })
        .catch((error: unknown) => {
          clearTimeout(warmup);
          session.close();
          reject(error);
        });
    });
  }
}

interface SessionOptions {
  readonly onDiagnostic: ((line: string) => void) | null;
  readonly transcriptionTimeoutMs: number;
  readonly maxAudioBytes: number;
  onUnavailable(reason: string): void;
}

/**
 * One recognition session: one child process, one utterance.
 *
 * A session is deliberately single-use. Keeping a recognizer warm between
 * utterances would save a few hundred milliseconds and would mean a live
 * audio pipe existed while Axon was not listening — exactly the property this
 * milestone exists to rule out.
 */
class WindowsSttSession implements SpeechToTextSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onChunk: (chunk: TranscriptChunk) => void;
  private readonly options: SessionOptions;

  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly readyPromise: Promise<void>;

  private endResolve: (() => void) | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  private stdoutTail = '';
  /** True while the tail of an abandoned over-long line is being discarded. */
  private skippingLine = false;
  private stderrBytes = 0;
  private stderr = '';
  private bytesWritten = 0;
  private closed = false;
  private ended = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    onChunk: (chunk: TranscriptChunk) => void,
    options: SessionOptions,
  ) {
    this.child = child;
    this.onChunk = onChunk;
    this.options = options;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded, and never shown to the user verbatim: a provider's stderr can
      // name local paths and user accounts.
      if (this.stderrBytes < 2_048) {
        this.stderrBytes += chunk.byteLength;
        this.stderr += chunk.toString('utf8').slice(0, 512);
      }
    });

    child.stdin.on('error', () => {
      // A child that died mid-utterance surfaces here as EPIPE. The 'close'
      // handler owns the outcome.
    });

    child.on('error', (error: Error) => {
      this.fail(new SpeechRecognitionError('UNAVAILABLE', `Speech recognition failed to start: ${error.message}`));
    });

    child.on('close', (code: number | null) => {
      if (code !== 0 && this.stderr.trim() !== '') {
        console.warn('[stt] recognizer stderr:', this.stderr.trim().slice(0, 400));
      }
      // A non-zero exit before READY means the engine could not be loaded at
      // all — most often no recognizer installed for the system language.
      if (this.readyReject && code !== 0) {
        this.options.onUnavailable(
          'Windows speech recognition is not available on this system. ' +
            'Add an English (United States) speech language in Windows Settings to enable it.',
        );
      }
      this.fail(new SpeechRecognitionError('PROVIDER', 'The speech recognizer stopped unexpectedly.'));
      this.settleEnd();
    });
  }

  /** Resolves when the recognizer has loaded and audio may be sent. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Feed one frame of 16-bit PCM.
   *
   * Frames are forwarded straight to the child and never accumulated here:
   * the only copy of the audio in this process is whatever is briefly in the
   * pipe's buffer. Past the byte ceiling, frames are dropped rather than
   * queued.
   */
  push(frame: Int16Array): void {
    if (this.closed || this.ended) return;

    const bytes = frame.byteLength;
    if (this.bytesWritten + bytes > this.options.maxAudioBytes) return;
    this.bytesWritten += bytes;

    // Copied rather than viewed: the incoming array is owned by the IPC layer,
    // and `write` is asynchronous. Little-endian, which is both what the
    // renderer produced and what the .NET audio format expects.
    const copy = Buffer.allocUnsafe(bytes);
    Buffer.from(frame.buffer, frame.byteOffset, bytes).copy(copy);
    this.child.stdin.write(copy);
  }

  /**
   * Close the audio stream and wait for the transcript.
   *
   * Closing stdin is what ends `CopyTo` in the child, which is what starts
   * recognition. Resolves when the child reports END or exits — or when the
   * deadline passes, so a wedged recognizer cannot hold Axon in LISTENING.
   */
  end(): Promise<void> {
    if (this.ended) return Promise.resolve();
    this.ended = true;

    return new Promise<void>((resolve) => {
      this.endResolve = resolve;

      this.endTimer = setTimeout(() => {
        // Whatever phrases arrived before the deadline have already been
        // delivered through `onChunk`; the session simply stops waiting.
        this.close();
        this.settleEnd();
      }, this.options.transcriptionTimeoutMs);
      if (typeof this.endTimer.unref === 'function') this.endTimer.unref();

      try {
        this.child.stdin.end();
      } catch {
        this.settleEnd();
      }
    });
  }

  /** Kill the child and release everything. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }

    try {
      this.child.stdin.destroy();
    } catch {
      /* already gone */
    }
    try {
      this.child.kill();
    } catch {
      /* already exited */
    }

    this.fail(new SpeechRecognitionError('CANCELLED', 'Speech recognition was cancelled.'));
  }

  /**
   * Parse the child's line protocol.
   *
   * Fixed-shape verbs: READY, AUDIO <bytes>, PHRASE <confidence> <base64>,
   * WAKE <confidence> <base64> (the wake grammar matched), NEAR <confidence>
   * <base64> (a near-miss sound-alike matched) — both optionally followed by
   * <startMs> <durationMs> of the matched audio — END. Wake sessions also report
   * RECOGNIZER, GRAMMAR, FORMAT, SPEECH and REJECTED, which go to the
   * diagnostics callback and never become transcripts. Anything else is
   * ignored rather than interpreted — the child is a subprocess, not a trusted
   * peer.
   */
  private onStdout(chunk: string): void {
    this.stdoutTail += chunk;

    // Bound the reassembly buffer. A child emitting one enormous line must not
    // become unbounded memory here — but it must not become a CORRUPT line
    // either. Trimming the buffer would chop the verb off the front and leave
    // a fragment that then gets parsed as something else, so instead the
    // over-long line is abandoned whole and the reader resynchronises at the
    // next newline. Nothing 64KB long on this channel is a spoken phrase.
    if (this.stdoutTail.length > MAX_LINE_BYTES) {
      const newline = this.stdoutTail.lastIndexOf('\n');
      if (newline === -1) {
        this.skippingLine = true;
        this.stdoutTail = '';
        return;
      }
      this.stdoutTail = this.stdoutTail.slice(newline + 1);
    }

    const lines = this.stdoutTail.split('\n');
    this.stdoutTail = lines.pop() ?? '';

    if (this.skippingLine) {
      // The first newline after an abandoned line ends it. Everything up to
      // there is the tail of something already discarded.
      if (lines.length === 0) return;
      this.skippingLine = false;
      lines.shift();
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (line === 'READY') {
        const resolve = this.readyResolve;
        this.readyResolve = null;
        this.readyReject = null;
        resolve?.();
        continue;
      }
      if (line === 'END') {
        this.settleEnd();
        continue;
      }
      if (line.startsWith('PHRASE ')) {
        this.emitPhrase(line.slice('PHRASE '.length), 'dictation');
        continue;
      }
      if (line.startsWith('WAKE ')) {
        this.emitPhrase(line.slice('WAKE '.length), 'wake-phrase');
        continue;
      }
      if (line.startsWith('NEAR ')) {
        this.emitPhrase(line.slice('NEAR '.length), 'near-miss');
        continue;
      }
      this.diagnose(line);
      // AUDIO and anything unrecognised are otherwise deliberately ignored.
    }
  }

  /**
   * Turn a recognizer self-report into a readable diagnostic line.
   *
   * Only the fixed verbs are translated, text fields are decoded from base64
   * and bounded, and nothing arrives here unless a developer asked for
   * diagnostics. Audio is never on this channel: the child has no verb for it.
   */
  private diagnose(line: string): void {
    const report = this.options.onDiagnostic;
    if (!report) return;
    const decode = (encoded: string | undefined): string => {
      if (!encoded) return '';
      try {
        return Buffer.from(encoded, 'base64').toString('utf8').slice(0, 160);
      } catch {
        return '';
      }
    };
    const parts = line.split(' ');
    switch (parts[0]) {
      case 'RECOGNIZER':
        report(`recognizer initialized: ${decode(parts[2])}, culture ${parts[1] ?? '?'}`);
        return;
      case 'GRAMMAR':
        report(`grammar loaded: ${parts[1] ?? '?'}`);
        return;
      case 'FORMAT':
        report(`audio format: ${parts[1] ?? '?'} Hz, ${parts[2] ?? '?'}-bit, ${parts[3] ?? '?'}`);
        return;
      case 'SPEECH':
        report('recognizer detected speech');
        return;
      case 'REJECTED':
        report(`[REJECTED] ${parts[1] ?? '?'} "${decode(parts[2])}" (below the engine's rejection threshold)`);
        return;
      default:
        return;
    }
  }

  private emitPhrase(payload: string, source: 'wake-phrase' | 'near-miss' | 'dictation'): void {
    const space = payload.indexOf(' ');
    if (space <= 0) return;

    const confidence = Number.parseFloat(payload.slice(0, space));
    // "<base64>" or "<base64> <startMs> <durationMs>". Base64 has no spaces, so
    // the fields split cleanly; timing that is not two whole numbers is dropped
    // rather than guessed at.
    const [encoded = '', startField, durationField] = payload.slice(space + 1).split(' ');
    const startMs = startField === undefined ? Number.NaN : Number(startField);
    const durationMs = durationField === undefined ? Number.NaN : Number(durationField);
    const span =
      Number.isInteger(startMs) && Number.isInteger(durationMs) && startMs >= 0 && durationMs > 0
        ? { startMs, durationMs }
        : undefined;

    let text: string;
    try {
      text = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return;
    }
    if (text === '') return;

    this.onChunk({
      text,
      isFinal: true,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
      source,
      ...(span ? { span } : {}),
    });
  }

  private settleEnd(): void {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    const resolve = this.endResolve;
    this.endResolve = null;
    resolve?.();
  }

  /** Reject the warm-up promise if it is still pending. Never throws. */
  private fail(error: Error): void {
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    reject?.(error);
  }
}
