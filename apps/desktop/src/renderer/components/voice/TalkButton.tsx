/**
 * The push-to-talk control.
 *
 * One button with two jobs, because there is one underlying capability: press
 * to start listening, press again to stop early. The global hotkey in the main
 * process does exactly the same two things through exactly the same API, so
 * there is no second path to keep in agreement with this one.
 *
 * ACCESSIBILITY. The state is announced in text, not only in colour and
 * motion: `aria-pressed` tells assistive technology whether Axon is listening,
 * the label changes with it, and the caption beside the orb says "Axon is
 * listening" in words. Nobody should have to interpret an animation to know
 * whether their microphone is on.
 */

export interface TalkButtonProps {
  readonly listening: boolean;
  readonly available: boolean;
  /** Why listening is unavailable, when it is. Shown as the tooltip. */
  readonly reason: string | null;
  /** The registered shortcut, for the hint. Null when none could be taken. */
  readonly hotkey: string | null;
  /** True while Axon is busy with something that cannot be interrupted. */
  readonly busy: boolean;
  onStart(): void;
  onStop(): void;
}

/** "Control+Shift+Space" -> "Ctrl + Shift + Space". */
function prettyHotkey(accelerator: string): string {
  return accelerator.replace(/\bControl\b/g, 'Ctrl').split('+').join(' + ');
}

export function TalkButton({
  listening,
  available,
  reason,
  hotkey,
  busy,
  onStart,
  onStop,
}: TalkButtonProps): React.JSX.Element {
  const disabled = !available || (busy && !listening);
  const label = listening ? 'Stop listening' : 'Talk to Axon';

  return (
    <div className="talk">
      <button
        type="button"
        className={`talk-button${listening ? ' talk-button-live' : ''}`}
        onClick={listening ? onStop : onStart}
        disabled={disabled}
        aria-pressed={listening}
        aria-label={listening ? 'Stop listening' : 'Talk to Axon'}
        title={available ? (hotkey ? `${label} (${prettyHotkey(hotkey)})` : label) : (reason ?? label)}
      >
        <span className="talk-icon" aria-hidden="true">
          {listening ? '■' : '🎙'}
        </span>
        {label}
      </button>

      {available && hotkey ? (
        <span className="talk-hint">
          or press <kbd>{prettyHotkey(hotkey)}</kbd>
        </span>
      ) : null}

      {!available && reason ? (
        <span className="talk-hint talk-hint-blocked" role="status">
          {reason}
        </span>
      ) : null}
    </div>
  );
}
