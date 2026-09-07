/**
 * Minimal RIFF/WAVE inspection.
 *
 * Two jobs, both security-relevant:
 *
 * 1. **Vouch for the bytes.** Nothing reaches the renderer that main has not
 *    parsed and recognised as linear PCM. The renderer's `decodeAudioData` is
 *    a media parser, and media parsers are a classic attack surface; feeding
 *    it only audio we have already validated is cheap and narrows what it can
 *    ever be asked to chew on.
 *
 * 2. **Measure the real duration.** The SPEAKING watchdog has to be derived
 *    from the audio, not guessed from the character count, or a hostile or
 *    broken renderer could hold Axon in SPEAKING indefinitely.
 *
 * Deliberately not a general WAV library. It accepts uncompressed PCM mono or
 * stereo and rejects everything else, because that is all the synthesiser
 * produces and a narrower parser is a smaller thing to get wrong.
 */

/** Linear PCM. The only format this build will play. */
const WAVE_FORMAT_PCM = 1;

const RIFF = 0x52494646; // 'RIFF'
const WAVE = 0x57415645; // 'WAVE'
const FMT_ = 0x666d7420; // 'fmt '
const DATA = 0x64617461; // 'data'

export interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly dataBytes: number;
  readonly durationMs: number;
}

export class InvalidWavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWavError';
  }
}

/**
 * Parse and validate a WAV buffer.
 *
 * Throws `InvalidWavError` rather than returning null: audio that cannot be
 * described is audio we refuse to play, and a caller that ignored a null would
 * be handing unvalidated bytes onward.
 */
export function parseWav(bytes: Uint8Array): WavInfo {
  // 44 is the smallest canonical header; anything shorter cannot describe
  // itself, let alone carry samples.
  if (bytes.byteLength < 44) {
    throw new InvalidWavError(`Audio is too short to be a WAV file (${bytes.byteLength} bytes).`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0, false) !== RIFF || view.getUint32(8, false) !== WAVE) {
    throw new InvalidWavError('Audio is not a RIFF/WAVE stream.');
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  let sawFmt = false;

  // Walk the chunk list rather than assuming the canonical 44-byte layout:
  // SAPI is free to emit a LIST or fact chunk before the data, and hardcoding
  // offset 44 would silently mis-measure the duration when it does.
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (chunkId === FMT_) {
      if (chunkSize < 16 || body + 16 > bytes.byteLength) {
        throw new InvalidWavError('WAV format chunk is truncated.');
      }
      const audioFormat = view.getUint16(body, true);
      if (audioFormat !== WAVE_FORMAT_PCM) {
        throw new InvalidWavError(`WAV is not linear PCM (format ${audioFormat}).`);
      }
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      sawFmt = true;
    } else if (chunkId === DATA) {
      // Trust the smaller of the declared size and what is actually present:
      // a truncated file must not be reported as longer than it is.
      dataBytes = Math.min(chunkSize, bytes.byteLength - body);
    }

    // Chunks are word-aligned; an odd size is followed by a pad byte.
    offset = body + chunkSize + (chunkSize % 2);
    // A zero or nonsensical size would loop forever.
    if (chunkSize === 0 && chunkId !== DATA) break;
  }

  if (!sawFmt) throw new InvalidWavError('WAV has no format chunk.');
  if (dataBytes <= 0) throw new InvalidWavError('WAV has no audio data.');
  if (channels !== 1 && channels !== 2) {
    throw new InvalidWavError(`WAV has an unsupported channel count (${channels}).`);
  }
  if (bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) {
    throw new InvalidWavError(`WAV has an unsupported sample width (${bitsPerSample} bits).`);
  }
  if (sampleRate < 4_000 || sampleRate > 192_000) {
    throw new InvalidWavError(`WAV has an implausible sample rate (${sampleRate} Hz).`);
  }

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  const durationMs = Math.round((dataBytes / bytesPerSecond) * 1000);

  return { sampleRate, channels, bitsPerSample, dataBytes, durationMs };
}
