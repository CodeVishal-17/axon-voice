/**
 * The boundary an image-generation service would plug into — and today, the
 * absence of one.
 *
 * Axon ships with NO image provider. None is configured, no key is read for
 * one, and nothing here calls a network. `draw.generate` is registered anyway
 * so that "draw me a cyberpunk city" gets a true answer — "Image generation
 * isn't configured yet." — rather than an invented picture or a model
 * pretending it made one.
 *
 * A provider added later implements this interface and is handed to the
 * registry by the runtime. It holds its own credentials; nothing it is given
 * or returns carries them, and the tool never puts the provider's errors into
 * a result verbatim. What it returns is checked to be a PNG and written by
 * `DrawingStore`, never by the provider.
 */

export interface ImageRequest {
  /** The user's description, as the model relayed it. Untrusted text. */
  readonly prompt: string;
  readonly style: string | null;
  readonly width: number;
  readonly height: number;
}

export interface ImageProvider {
  /** A name to show the user, e.g. in the approval dialog. Never a key. */
  readonly name: string;
  /** PNG bytes. Throws on failure; the tool reports it without the message. */
  generate(request: ImageRequest): Promise<Uint8Array>;
}
