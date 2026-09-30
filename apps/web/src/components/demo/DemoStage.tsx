import { DEMO_VIDEO_URL } from '../../config.js';
import { IllustrativeRun } from './IllustrativeRun.js';

/**
 * THE SWAPPABLE SURFACE OF THE DEMO SECTION.
 *
 * Everything around it — the heading, the copy, the frame's place in the page —
 * belongs to `Demo.tsx` and does not change. This file decides only what is
 * inside the frame, and it has exactly two answers:
 *
 *   VITE_AXON_DEMO_VIDEO_URL set    a real recording, played here
 *                            unset  the illustrative walkthrough, labelled
 *
 * So replacing the illustration with a capture of Axon running is one build
 * variable, not a redesign. If the recording should eventually be something
 * other than a file — an embed, a player with chapters — it is this component
 * that gets replaced, and nothing else on the page needs to know.
 *
 * The illustration is never presented as a session. It carries a badge saying
 * what it is, and the caption underneath repeats it.
 */
export function DemoStage(): React.JSX.Element {
  if (DEMO_VIDEO_URL !== '') {
    return (
      <div className="stage">
        <div className="stage__frame">
          <video className="stage__video" src={DEMO_VIDEO_URL} controls preload="metadata" playsInline />
        </div>
        <div className="stage__foot">
          <p className="stage__caption">Axon running on Windows, recorded.</p>
        </div>
      </div>
    );
  }

  return <IllustrativeRun />;
}
