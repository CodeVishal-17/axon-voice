/**
 * One explicit, streaming, anti-aliased sample-rate conversion.
 *
 * PURE. No DOM, no audio APIs.
 *
 * WHY THIS REPLACED `resample()`.
 *
 * Axon now reads the microphone track directly (see `microphone.ts`), which
 * delivers audio at the DEVICE's rate — 48 kHz on the machine this was built
 * on — so conversion to 16 kHz (the local wake detector) or 24 kHz (AssemblyAI)
 * happens here, at one well-defined boundary, instead of being delegated to
 * an AudioContext asked nicely for a rate.
 *
 * The old helper was linear interpolation applied to each block independently.
 * Two defects, both measurable in `resampler.test.ts`:
 *
 *   - NO LOW-PASS. Taking every third sample of 48 kHz audio folds everything
 *     between 8 and 24 kHz down into the speech band. Fricatives — the "s" and
 *     "f" a recognizer leans on — are exactly that energy.
 *   - NO STATE ACROSS BLOCKS. Each block restarted its read position at zero
 *     and floored its output length, so any non-integer ratio (44.1 -> 24 kHz)
 *     dropped a fraction of a sample per block and put a phase jump at every
 *     boundary.
 *
 * This is a windowed-sinc (Blackman) interpolator whose cutoff sits below the
 * TARGET's Nyquist, carrying its read position and its history from one call
 * to the next, so a stream cut into blocks of any size produces the same
 * output as the stream in one piece.
 *
 * It holds the last few dozen input samples as filter history and nothing else.
 */

/** Zero crossings of the sinc on each side. 16 gives ~-70 dB stopband with Blackman, at negligible cost for speech. */
const HALF_TAPS = 16;

export class StreamingResampler {
  readonly fromRate: number;
  readonly toRate: number;
  /** Input samples advanced per output sample. */
  private readonly step: number;
  /** Cutoff as a fraction of the INPUT Nyquist. */
  private readonly cutoff: number;
  /** Kernel half-width in input samples. */
  private readonly halfWidth: number;
  private readonly taps: number;
  /** The kernel, tabulated once per resampler rather than evaluated per tap on the capture thread. */
  private readonly table: Float32Array;
  /**
   * Input history. Index 0 of `history` is absolute input sample `historyStart`.
   * Bounded: trimmed to what the kernel can still reach after every call.
   */
  private history: Float32Array = new Float32Array(0);
  private historyStart = 0;
  /** Absolute input position (in input samples) of the next output sample. */
  private position = 0;

  constructor(fromRate: number, toRate: number) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('sample rates must be positive');
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.step = fromRate / toRate;
    // Downsampling: cut below the target's Nyquist, with a 5% guard band.
    // Upsampling: the input's own Nyquist is the limit.
    this.cutoff = Math.min(1, toRate / fromRate) * 0.95;
    this.halfWidth = Math.ceil(HALF_TAPS / this.cutoff);
    this.taps = 2 * this.halfWidth;
    this.table = buildTable(this.halfWidth, this.cutoff);
    // Start the kernel centred on the first sample; the first `halfWidth`
    // outputs see zeros on their left, which is the honest thing a filter does
    // at the start of a stream.
    this.position = 0;
  }

  /** Whether this converts at all. Identity rates pass samples through untouched. */
  get identity(): boolean {
    return this.fromRate === this.toRate;
  }

  /**
   * Convert one block. Returns the output samples that are fully determined by
   * the input so far; the remainder comes out of later calls.
   */
  process(input: Float32Array): Float32Array {
    if (this.identity) return input;

    // Append the block to history.
    const merged = new Float32Array(this.history.length + input.length);
    merged.set(this.history, 0);
    merged.set(input, this.history.length);
    this.history = merged;
    const available = this.historyStart + this.history.length; // absolute end (exclusive)

    // An output at `position` needs input up to `position + halfWidth`.
    const count = Math.max(0, Math.floor((available - 1 - this.halfWidth - this.position) / this.step) + 1);
    const out = new Float32Array(count);
    for (let n = 0; n < count; n += 1) {
      out[n] = this.sampleAt(this.position);
      this.position += this.step;
    }

    // Drop history the kernel can no longer reach.
    const keepFrom = Math.max(this.historyStart, Math.floor(this.position) - this.halfWidth - 1);
    const drop = keepFrom - this.historyStart;
    if (drop > 0) {
      this.history = this.history.slice(drop);
      this.historyStart = keepFrom;
    }
    return out;
  }

  private sampleAt(t: number): number {
    const center = Math.floor(t);
    const fraction = t - center;
    const row = Math.min(PHASES - 1, Math.round(fraction * PHASES)) * this.taps;
    const first = center - this.halfWidth + 1;
    let sum = 0;
    for (let j = 0; j < this.taps; j += 1) {
      const index = first + j - this.historyStart;
      const sample = index >= 0 && index < this.history.length ? (this.history[index] ?? 0) : 0;
      sum += sample * (this.table[row + j] ?? 0);
    }
    return sum;
  }
}

/** Fractional positions the kernel is tabulated at. 1/512 of a sample is far below audible phase error. */
const PHASES = 512;

/**
 * Tabulate a Blackman-windowed sinc, one normalised row per fractional phase.
 * Normalising each row to sum to one keeps DC exact despite truncation.
 */
function buildTable(halfWidth: number, cutoff: number): Float32Array {
  const taps = 2 * halfWidth;
  const table = new Float32Array(PHASES * taps);
  for (let p = 0; p < PHASES; p += 1) {
    const fraction = p / PHASES;
    let total = 0;
    for (let j = 0; j < taps; j += 1) {
      const x = fraction + halfWidth - 1 - j; // t - k, with k = center - halfWidth + 1 + j
      let w = 0;
      if (Math.abs(x) < halfWidth) {
        const arg = x * cutoff;
        const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
        const phase = (x + halfWidth) / (2 * halfWidth);
        const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * phase) + 0.08 * Math.cos(4 * Math.PI * phase);
        w = sinc * window;
      }
      table[p * taps + j] = w;
      total += w;
    }
    if (total !== 0) for (let j = 0; j < taps; j += 1) table[p * taps + j] = (table[p * taps + j] ?? 0) / total;
  }
  return table;
}

/**
 * Deterministic mono from any channel layout: the mean of the channels.
 *
 * `channels[c][i]` is sample i of channel c. Averaging rather than taking the
 * left channel means a device whose speech sits mostly in one capsule is not
 * silently halved, and it can never produce interleaved samples.
 */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) + (channel[i] ?? 0);
  }
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) / channels.length;
  return out;
}
