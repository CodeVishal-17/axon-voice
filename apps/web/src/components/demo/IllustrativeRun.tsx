import { useEffect, useState } from 'react';
import { Orb } from '../Orb.js';
import { DEMO_BEATS } from '../../content.js';
import { useInView } from '../../hooks/useInView.js';
import { useReducedMotion } from '../../hooks/useReducedMotion.js';
import { useOrbSize } from '../../hooks/useOrbSize.js';

/** How long one beat holds before the next arrives. */
const BEAT_MS = 1_500;

const STATE_NAME: Readonly<Record<string, string>> = {
  listening: 'Listening',
  thinking: 'Thinking',
  executing: 'Executing',
  speaking: 'Speaking',
};

/**
 * The illustrative walkthrough: one turn, beat by beat.
 *
 * NOT A RECORDING, and it says so on its face — there is no session behind it,
 * no window being driven, nothing live. It is a drawing of the exchange in
 * `DEMO_BEATS`, which is the simplest true thing Axon does: a sentence becomes
 * a request, the request has to be allowed, and the result is checked before it
 * is claimed. The orb changes state with each beat, using the desktop app's own
 * colours, so the page and the product agree about what each colour means.
 *
 * It runs once when it scrolls into view, and can be replayed. With reduced
 * motion every beat is present from the start and nothing is scheduled.
 */
export function IllustrativeRun(): React.JSX.Element {
  const reduced = useReducedMotion();
  // A long floor: the run should start when a visitor actually reaches it, not
  // while it is still below the fold. The floor is still there so the beats
  // cannot stay invisible on a browser where the observer never fires.
  const { ref, shown } = useInView<HTMLDivElement>({ disabled: reduced, fallbackMs: 6_000 });
  const orbSize = useOrbSize(148);
  const [beats, setBeats] = useState(reduced ? DEMO_BEATS.length : 0);
  /** Bumped by Replay to restart the timer. */
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (reduced) {
      setBeats(DEMO_BEATS.length);
      return;
    }
    if (!shown) return;
    setBeats(0);
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setBeats(index);
      if (index >= DEMO_BEATS.length) window.clearInterval(timer);
    }, BEAT_MS);
    return () => window.clearInterval(timer);
  }, [shown, reduced, run]);

  // The orb shows the beat that has most recently arrived; before the first one
  // it is idle, which is what Axon is doing before you speak.
  const current = beats === 0 ? null : DEMO_BEATS[Math.min(beats, DEMO_BEATS.length) - 1] ?? null;
  const rgb = current?.orb.rgb ?? ([150, 166, 198] as const);
  const motion = current?.orb.motion ?? 'idle';
  const stateName = current === null ? 'Idle' : STATE_NAME[current.orb.motion] ?? 'Idle';

  return (
    <div className="stage" ref={ref}>
      <div className="stage__frame">
        <p className="stage__badge">
          <span className="stage__badge-dot" aria-hidden="true" />
          Illustrative — not a recording
        </p>

        <div className="run">
          <div className="run__orb">
            <Orb size={orbSize} rgb={rgb} motion={motion} interactive />
            <p className="run__state" aria-live="polite">
              {stateName}
            </p>
          </div>

          <ol className="run__beats">
            {DEMO_BEATS.map((beat, index) => (
              <li className="beat" key={beat.who} data-shown={index < beats} data-who={beat.who.toLowerCase()}>
                <span className="beat__who">{beat.who}</span>
                <div className="beat__body">
                  <p className="beat__line">
                    {beat.spoken ? `“${beat.text}”` : beat.text}
                    {beat.tool === undefined ? null : (
                      <>
                        <span className="beat__arrow" aria-hidden="true">
                          →
                        </span>
                        <code>{beat.tool}</code>
                      </>
                    )}
                  </p>
                  {beat.note === undefined ? null : <p className="beat__note">{beat.note}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="stage__foot">
        <p className="stage__caption">
          A walkthrough of the exchange, drawn on this page — not a capture of a session. A real recording will take its place
          here.
        </p>
        {reduced ? null : (
          <button className="button button--ghost button--small" type="button" onClick={() => setRun((n) => n + 1)}>
            Replay
          </button>
        )}
      </div>
    </div>
  );
}
