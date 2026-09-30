/**
 * The one thing about this site that is configured rather than written.
 *
 * WHY THE DOWNLOAD IS NOT A URL IN THE MARKUP.
 *
 * At the time of writing, the repository has no installer: `npm run build` in
 * `apps/desktop` produces an Electron bundle, not a signed distributable, and
 * there is no release to point at. A download button with a plausible-looking
 * link would be the website telling a person something the product cannot do,
 * which is exactly the kind of claim the rest of this site is written to avoid.
 *
 * So the button has two states, and which one it is in is decided by a single
 * build-time value:
 *
 *     VITE_AXON_DOWNLOAD_URL   set    -> a real download button pointing at it
 *                              unset  -> a disabled button that says the build
 *                                        is not published yet, beside a link to
 *                                        the source
 *
 * Set it when there is something to download:
 *
 *     VITE_AXON_DOWNLOAD_URL=https://github.com/<owner>/<repo>/releases/latest npm run web:build
 *
 * Nothing else here is secret and nothing else is read from the environment.
 * Vite inlines only `VITE_`-prefixed variables, and the desktop app's keys
 * (`ASSEMBLYAI_API_KEY`, `ANTHROPIC_API_KEY`) are not among them — they are
 * read by the desktop main process and never exist in this bundle.
 *
 * Three values, all optional, all build-time:
 *
 *     VITE_AXON_DOWNLOAD_URL     the installer
 *     VITE_AXON_SOURCE_URL       the repository (defaults to the real one)
 *     VITE_AXON_DEMO_VIDEO_URL   a recording, for the demo section
 */

/**
 * Where the source lives — the repository this checkout pushes to, not a
 * placeholder. Overridable for a fork.
 */
export const SOURCE_URL = import.meta.env.VITE_AXON_SOURCE_URL ?? 'https://github.com/CodeVishal-17/axon-voice';

/**
 * A recording of Axon actually running, when one exists.
 *
 * The demo section reads this and nothing else: unset, it shows an illustrative
 * walkthrough that says on its face that it is not a recording; set, it plays
 * the file instead, in the same frame, with no other change to the page. See
 * `components/demo/DemoStage.tsx`.
 */
export const DEMO_VIDEO_URL = (import.meta.env.VITE_AXON_DEMO_VIDEO_URL ?? '').trim();

/** The installer, when one exists. */
const DOWNLOAD_URL = import.meta.env.VITE_AXON_DOWNLOAD_URL ?? '';

export interface DownloadState {
  /** True only when a build has actually been published. */
  readonly available: boolean;
  readonly url: string | null;
  /** What the button says. */
  readonly label: string;
  /** The line under it: requirements, or why there is nothing to download. */
  readonly note: string;
}

export const download: DownloadState = DOWNLOAD_URL.trim() === ''
  ? {
      available: false,
      url: null,
      label: 'Download for Windows',
      note: 'No build is published yet. Axon runs from source today — the button turns on when there is an installer to point it at.',
    }
  : {
      available: true,
      url: DOWNLOAD_URL.trim(),
      label: 'Download for Windows',
      note: 'Windows 10 or 11, 64-bit. A microphone, and an AssemblyAI key for spoken conversation.',
    };
