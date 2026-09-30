/**
 * How Axon was started.
 *
 * `--background` is what the per-user sign-in entry passes: Axon starts with
 * no window, listens locally for its name, and shows the orb only when it is
 * woken. Started any other way (a shortcut, `npm run dev`), it also opens its
 * panel, because a person who launched it by hand expects to see something.
 */

export const BACKGROUND_FLAG = '--background';

export interface LaunchMode {
  readonly background: boolean;
}

export function parseLaunchMode(argv: readonly string[]): LaunchMode {
  return { background: argv.includes(BACKGROUND_FLAG) };
}
