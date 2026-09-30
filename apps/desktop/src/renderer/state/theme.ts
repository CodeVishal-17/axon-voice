/**
 * Light and dark.
 *
 * PURE helpers, and a deliberately small concern. The theme is a per-machine
 * appearance preference: it is not a secret, not a setting any tool reads, and
 * nothing about Axon's behaviour depends on it — so it lives in the page's own
 * storage rather than in the settings database, and every storage call is
 * guarded, because a page whose storage is unavailable must still render.
 */

export type Theme = 'dark' | 'light';

export const THEMES: readonly Theme[] = ['dark', 'light'];
export const THEME_STORAGE_KEY = 'axon.theme';
export const DEFAULT_THEME: Theme = 'dark';

export function parseTheme(value: unknown): Theme | null {
  return value === 'dark' || value === 'light' ? value : null;
}

interface ReadableStorage {
  getItem(key: string): string | null;
}

interface WritableStorage {
  setItem(key: string, value: string): void;
}

/** The stored theme, or the default. Never throws. */
export function readStoredTheme(storage: ReadableStorage | null | undefined): Theme {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY)) ?? DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Remember a theme. Never throws; a theme that cannot be saved is still applied. */
export function storeTheme(storage: WritableStorage | null | undefined, theme: Theme): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
}

export function otherTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

/** Put the theme on the document, where the stylesheet reads it. */
export function applyThemeToDocument(root: { dataset: DOMStringMap; style: { colorScheme: string } }, theme: Theme): void {
  root.dataset['theme'] = theme;
  root.style.colorScheme = theme;
}
