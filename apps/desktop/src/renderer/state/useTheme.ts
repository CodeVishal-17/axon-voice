/**
 * The theme, as React state.
 *
 * The document already carries the stored theme before React renders (see
 * `main.tsx`), so there is no flash of the wrong one. Changing it updates the
 * document, remembers the choice, and tells main so the native title bar can
 * match. That last call carries one of two words and nothing else; main
 * accepts only those two.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  applyThemeToDocument,
  otherTheme,
  parseTheme,
  readStoredTheme,
  storeTheme,
  THEME_STORAGE_KEY,
  type Theme,
} from './theme.js';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function tellMain(theme: Theme): void {
  // Structural and optional: an older bridge without the call is not an error.
  const bridge = window.axon as { setAppearance?: (appearance: Theme) => Promise<void> } | undefined;
  void bridge?.setAppearance?.(theme).catch(() => undefined);
}

export function useTheme(): { readonly theme: Theme; setTheme(theme: Theme): void; toggle(): void } {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme(storage()));

  useEffect(() => {
    applyThemeToDocument(document.documentElement, theme);
    tellMain(theme);
  }, [theme]);

  // The panel and the overlay are two pages of one origin. A theme chosen in
  // one reaches the other through the storage event, so the orb over the
  // desktop never wears a different look from the window.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = parseTheme(event.newValue);
      if (next) setThemeState(next);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    storeTheme(storage(), next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((current) => {
      const next = otherTheme(current);
      storeTheme(storage(), next);
      return next;
    });
  }, []);

  return { theme, setTheme, toggle };
}
