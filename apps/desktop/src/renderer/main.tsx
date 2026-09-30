import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { OverlayApp } from './OverlayApp.js';
import { applyThemeToDocument, readStoredTheme } from './state/theme.js';
import './styles.css';

/**
 * Which surface this page is. Main loads the same renderer twice: once as the
 * panel, once as the transparent overlay that holds the microphone and shows
 * the orb. The query is set by main, never by page input, and choosing the
 * wrong one grants nothing — main routes audio by window, not by what a page
 * says it is.
 */
const surface = new URLSearchParams(window.location.search).get('surface') === 'overlay' ? 'overlay' : 'panel';
document.documentElement.dataset.surface = surface;

const container = document.getElementById('root');
if (!container) {
  throw new Error('Renderer root element is missing from index.html.');
}

// The stored theme goes on the document BEFORE the first render, so the window
// never flashes the other theme while React starts.
applyThemeToDocument(
  document.documentElement,
  readStoredTheme(
    (() => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    })(),
  ),
);

createRoot(container).render(
  <StrictMode>
    {surface === 'overlay' ? <OverlayApp /> : <App />}
  </StrictMode>,
);
