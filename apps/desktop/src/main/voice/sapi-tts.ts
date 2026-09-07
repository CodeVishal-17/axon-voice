/**
 * Windows SAPI text-to-speech.
 *
 * ARCHITECTURAL NOTE — read before editing.
 *
 * This is the only module in Axon that spawns a process for speech, and the
 * only one that touches a speech provider. Everything above it depends on the
 * `TextToSpeech` interface in `@axon/core`, so replacing SAPI with a cloud
 * voice is a change to `create-tts.ts` and nothing else.
 *
 * SECURITY — the injection boundary.
 *
 * The text to speak originates, ultimately, outside Axon: a model wrote it,
 * possibly after reading a web page or a file written by someone hostile. It
 * is therefore treated as data at every step:
 *
 *   - The PowerShell program is a MODULE CONSTANT. Nothing is interpolated
 *     into it — not the text, not a voice name, not a rate. Reading `SCRIPT`
 *     below tells you the entire program that will ever run.
 *   - The text arrives on the child's STDIN and is read with
 *     `[Console]::In.ReadToEnd()`. It never appears in `argv`, never in the
 *     script body, and never in a filename.
 *   - `-NoProfile` stops a user profile script from running first;
 *     `-NonInteractive` stops any prompt from blocking forever.
 *   - The child gets no shell: `spawn` is called with an argv array and
 *     `shell: false`, so there is no command line for a quote to escape from.
 *
 * The consequence is that a reply containing `$(rm -rf /)` is spoken aloud,
 * word by word, exactly as written. There is no parser between the text and
 * the speaker that could do anything else with it.
 *
 * The audio comes back base64-encoded on stdout. Raw bytes through a Windows
 * pipe are subject to encoding translation; base64 is a few percent larger and
 * removes an entire class of corruption.
 */

import { spawn } from 'node:child_process';
import { SPEECH_LIMITS, type SpeechAudio, type TextToSpeech } from '@axon/core';
import { parseWav } from './wav.js';

/**
 * The complete program run in the child process.
 *
 * A module constant, never a template. See the security note above.
 */
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Speech',
  // The text is DATA arriving on stdin. It is never part of this program.
  '$text = [Console]::In.ReadToEnd()',
  "if ([string]::IsNullOrWhiteSpace($text)) { [Console]::Error.Write('empty'); exit 2 }",
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$stream = New-Object System.IO.MemoryStream',
  'try {',
  '  $synth.SetOutputToWaveStream($stream)',
  // Speak() renders to the stream; it does not reach the speakers. Playback
  // happens in the renderer so the same graph can drive the orb.
  '  $synth.Speak($text)',
  '  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))',
  '} finally {',
  '  $synth.Dispose()',
  '  $stream.Dispose()',
  '}',
].join('\n');

const POWERSHELL = 'powershell.exe';

export interface SapiOptions {
  /** Injected in tests. Defaults to the real Windows PowerShell. */
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxAudioBytes?: number;
  readonly platform?: NodeJS.Platform;
}

export class SpeechSynthesisError extends Error {
  readonly kind: 'UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED' | 'EMPTY' | 'PROVIDER' | 'TOO_LARGE' | 'MALFORMED';

  constructor(kind: SpeechSynthesisError['kind'], message: string) {
    super(message);
    this.name = 'SpeechSynthesisError';
    this.kind = kind;
  }
}

export class SapiTextToSpeech implements TextToSpeech {
  readonly name = 'windows-sapi';

  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly maxAudioBytes: number;
  private readonly platform: NodeJS.Platform;

  constructor(options: SapiOptions = {}) {
    this.executable = options.executable ?? POWERSHELL;
    this.timeoutMs = options.timeoutMs ?? SPEECH_LIMITS.synthesisTimeoutMs;
    this.maxAudioBytes = options.maxAudioBytes ?? SPEECH_LIMITS.maxAudioBytes;
    this.platform = options.platform ?? process.platform;
  }

  /** SAPI is a Windows facility; nothing here pretends to work elsewhere. */
  isAvailable(): boolean {
    return this.platform === 'win32';
  }

  synthesize(text: string, signal?: AbortSignal): Promise<SpeechAudio> {
    if (!this.isAvailable()) {
      return Promise.reject(
        new SpeechSynthesisError('UNAVAILABLE', 'Windows speech synthesis is only available on Windows.'),
      );
    }
    if (text.trim() === '') {
      return Promise.reject(new SpeechSynthesisError('EMPTY', 'There was nothing to speak.'));
    }
    if (signal?.aborted) {
      return Promise.reject(new SpeechSynthesisError('CANCELLED', 'Speech was cancelled before it started.'));
    }

    return new Promise<SpeechAudio>((resolve, reject) => {
      const child = spawn(
        this.executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
        // No shell. The argv array is passed to the process directly, so there
        // is no command string for anything to be injected into.
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const kill = (): void => {
        // The child may already be gone; killing a dead process throws on some
        // platforms and is never worth failing the turn over.
        try {
          child.kill();
        } catch {
          /* already exited */
        }
      };

      const timer = setTimeout(() => {
        kill();
        finish(() =>
          reject(new SpeechSynthesisError('TIMEOUT', `Speech synthesis took longer than ${this.timeoutMs}ms.`)),
        );
      }, this.timeoutMs);

      const onAbort = (): void => {
        kill();
        finish(() => reject(new SpeechSynthesisError('CANCELLED', 'Speech was cancelled.')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        // Base64 is 4/3 the size of the audio; bound the buffer before it is
        // decoded rather than after, so a runaway child cannot exhaust memory.
        if (stdoutBytes > this.maxAudioBytes * 1.4) {
          kill();
          finish(() => reject(new SpeechSynthesisError('TOO_LARGE', 'Speech audio exceeded the size limit.')));
          return;
        }
        stdout.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        // Bounded: a provider that fails in a loop must not fill memory with
        // its complaints. Only the first 4KB is ever kept, and it is never
        // shown to the user verbatim.
        if (stderr.length < 8) stderr.push(chunk.subarray(0, 512));
      });

      child.on('error', (error: Error) => {
        kill();
        finish(() =>
          reject(
            new SpeechSynthesisError(
              'UNAVAILABLE',
              `Could not start the Windows speech synthesiser: ${error.message}`,
            ),
          ),
        );
      });

      child.on('close', (code: number | null) => {
        finish(() => {
          if (code !== 0) {
            // The child's stderr is deliberately NOT propagated to the user:
            // it can contain local paths and internal detail. It is logged for
            // a developer and summarised for everyone else.
            const detail = Buffer.concat(stderr).toString('utf8').trim();
            if (detail !== '') console.warn('[tts] synthesiser stderr:', detail.slice(0, 400));
            reject(
              new SpeechSynthesisError('PROVIDER', `The Windows speech synthesiser failed (exit code ${code}).`),
            );
            return;
          }

          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(Buffer.from(Buffer.concat(stdout).toString('ascii').trim(), 'base64'));
          } catch {
            reject(new SpeechSynthesisError('MALFORMED', 'The synthesiser returned audio Axon could not read.'));
            return;
          }

          if (bytes.byteLength > this.maxAudioBytes) {
            reject(new SpeechSynthesisError('TOO_LARGE', 'Speech audio exceeded the size limit.'));
            return;
          }

          // Validate before anything downstream sees it. The renderer is only
          // ever handed audio main has already parsed and recognised.
          try {
            const info = parseWav(bytes);
            resolve({ bytes, mimeType: 'audio/wav', sampleRate: info.sampleRate });
          } catch (error) {
            reject(
              new SpeechSynthesisError(
                'MALFORMED',
                error instanceof Error ? error.message : 'The synthesiser returned unusable audio.',
              ),
            );
          }
        });
      });

      // Write the text as UTF-8 and close stdin, which is what makes
      // `ReadToEnd()` in the child return.
      child.stdin.on('error', () => {
        // A child that died before we finished writing surfaces here as EPIPE.
        // The 'close' handler owns the outcome; nothing to add.
      });
      child.stdin.end(text, 'utf8');
    });
  }
}
