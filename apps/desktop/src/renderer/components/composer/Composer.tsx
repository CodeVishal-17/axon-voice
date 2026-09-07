/**
 * The text composer — Axon's primary input until voice lands.
 *
 * Keyboard contract:
 *   Enter        send
 *   Shift+Enter  newline
 *
 * The textarea grows with its content up to a cap, so a multi-line request is
 * readable while typing without the composer taking over the window.
 *
 * The disabled state is driven by the main process (`busy` comes from the
 * event stream), not by a local flag set on submit. If a turn is refused, or
 * one is already running when this window mounts, the composer reflects the
 * real state rather than an optimistic guess about it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_LENGTH = 4000;
const MAX_HEIGHT_PX = 160;

export interface ComposerProps {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly placeholder: string;
  onSend(text: string): void;
}

export function Composer({ busy, disabled, placeholder, onSend }: ComposerProps): React.JSX.Element {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const blocked = busy || disabled;
  const canSend = value.trim() !== '' && !blocked;

  // Re-measure on every change: shrinking needs the reset to `auto` first,
  // otherwise the box only ever grows.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  // Return focus when a turn finishes, so the next message can be typed
  // without reaching for the mouse.
  useEffect(() => {
    if (!blocked) textareaRef.current?.focus();
  }, [blocked]);

  const send = useCallback(() => {
    const text = value.trim();
    if (text === '' || blocked) return;
    // Cleared immediately: the message is now the transcript's business, and
    // leaving it in the box invites an accidental double-send.
    setValue('');
    onSend(text);
  }, [value, blocked, onSend]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // `isComposing` guards IME input, where Enter commits a candidate rather
      // than ending the sentence.
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        send();
      }
    },
    [send],
  );

  return (
    <form
      className={`composer${blocked ? ' composer-blocked' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={1}
        value={value}
        maxLength={MAX_LENGTH}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="Message Axon"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="composer-send"
        disabled={!canSend}
        aria-label={busy ? 'Axon is working' : 'Send message'}
        title={busy ? 'Axon is working' : 'Send (Enter)'}
      >
        {busy ? <span className="composer-spinner" aria-hidden="true" /> : '↑'}
      </button>
    </form>
  );
}
