import type { Glyph } from '../content.js';

/**
 * The small line drawing at the top of a capability card.
 *
 * Nine shapes, drawn from the same thin strokes as the rest of the page: a
 * window frame, browser chrome, a field with a caret, capture brackets. They are
 * decorative — every card's meaning is in its heading and its tool names — so
 * they are hidden from assistive technology.
 *
 * They move only on hover, and only a little: a caret blinks, a capture frame
 * closes, a line advances. Nothing here suggests live automation, and the
 * global reduced-motion rule flattens all of it (every effect is a transition
 * or an animation, both of which that rule neutralises).
 */
export function CardGlyph({ kind }: { readonly kind: Glyph }): React.JSX.Element {
  return (
    <span className="glyph" data-kind={kind} aria-hidden="true">
      <svg viewBox="0 0 48 32" role="presentation" focusable="false">
        {draw(kind)}
      </svg>
    </span>
  );
}

function draw(kind: Glyph): React.JSX.Element {
  switch (kind) {
    // A window, opening: the frame with its title bar.
    case 'app':
      return (
        <>
          <rect className="glyph__frame" x="6.5" y="5.5" width="35" height="21" rx="3" />
          <line className="glyph__bar" x1="6.5" y1="12.5" x2="41.5" y2="12.5" />
          <circle className="glyph__dot" cx="11" cy="9" r="1.1" />
          <circle className="glyph__dot" cx="15" cy="9" r="1.1" />
          <rect className="glyph__sweep" x="10" y="16" width="14" height="2" rx="1" />
        </>
      );

    // Browser chrome: a frame with an address bar.
    case 'browser':
      return (
        <>
          <rect className="glyph__frame" x="6.5" y="5.5" width="35" height="21" rx="3" />
          <line className="glyph__bar" x1="6.5" y1="12.5" x2="41.5" y2="12.5" />
          <rect className="glyph__pill" x="16" y="7.5" width="22" height="3.6" rx="1.8" />
          <circle className="glyph__dot" cx="11" cy="9.3" r="1.1" />
          <rect className="glyph__sweep" x="11" y="17" width="12" height="2" rx="1" />
        </>
      );

    // An input, being typed into.
    case 'form':
      return (
        <>
          <rect className="glyph__frame" x="6.5" y="9.5" width="35" height="13" rx="3" />
          <rect className="glyph__sweep" x="11" y="15" width="11" height="2" rx="1" />
          <line className="glyph__caret" x1="24.5" y1="12.5" x2="24.5" y2="19.5" />
        </>
      );

    // The accessibility tree: a window with structure inside it.
    case 'tree':
      return (
        <>
          <rect className="glyph__frame" x="6.5" y="5.5" width="35" height="21" rx="3" />
          <line className="glyph__bar" x1="17.5" y1="5.5" x2="17.5" y2="26.5" />
          <rect className="glyph__sweep" x="21" y="10" width="15" height="2" rx="1" />
          <rect className="glyph__pill" x="21" y="15" width="10" height="2" rx="1" />
          <rect className="glyph__pill" x="21" y="20" width="13" height="2" rx="1" />
        </>
      );

    // A control, about to be pressed.
    case 'control':
      return (
        <>
          <rect className="glyph__pill glyph__pill--wide" x="8.5" y="10.5" width="21" height="11" rx="5.5" />
          <path className="glyph__cursor" d="M28 16.5 L36.5 21 L32.6 22.1 L34.6 26 L32.4 27 L30.5 23 L28 25.6 Z" />
        </>
      );

    // The clock on this machine.
    case 'clock':
      return (
        <>
          <circle className="glyph__frame" cx="24" cy="16" r="10.5" />
          <line className="glyph__hand" x1="24" y1="16" x2="24" y2="10.5" />
          <line className="glyph__hand glyph__hand--minute" x1="24" y1="16" x2="29" y2="18" />
        </>
      );

    // Capture brackets closing on a frame.
    case 'capture':
      return (
        <>
          <path className="glyph__corner" d="M8 13 V9 a1 1 0 0 1 1-1 h4" />
          <path className="glyph__corner" d="M40 13 V9 a1 1 0 0 0-1-1 h-4" />
          <path className="glyph__corner" d="M8 19 v4 a1 1 0 0 0 1 1 h4" />
          <path className="glyph__corner" d="M40 19 v4 a1 1 0 0 1-1 1 h-4" />
          <rect className="glyph__shutter" x="18" y="12" width="12" height="8" rx="2" />
        </>
      );

    // A file in the workspace.
    case 'file':
      return (
        <>
          <path className="glyph__frame" d="M15.5 5.5 h11 l6 6 v15 a1 1 0 0 1-1 1 h-16 a1 1 0 0 1-1-1 v-20 a1 1 0 0 1 1-1 z" />
          <path className="glyph__bar" d="M26.5 5.5 v6 h6" />
          <rect className="glyph__sweep" x="19" y="16" width="10" height="2" rx="1" />
          <rect className="glyph__pill" x="19" y="20.5" width="7" height="2" rx="1" />
        </>
      );

    // A remembered fact: a point with what it connects to.
    case 'memory':
      return (
        <>
          <circle className="glyph__core" cx="24" cy="16" r="3.4" />
          <circle className="glyph__ring" cx="24" cy="16" r="7.5" />
          <circle className="glyph__ring glyph__ring--out" cx="24" cy="16" r="11.5" />
        </>
      );
  }
}
