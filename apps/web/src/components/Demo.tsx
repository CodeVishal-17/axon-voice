import { Section } from './Section.js';
import { DemoStage } from './demo/DemoStage.js';

/**
 * Section 2: one turn, shown rather than described.
 *
 * The section owns the heading, the copy and the place in the page; what is
 * inside the frame belongs to `demo/DemoStage.tsx`, which swaps an illustrative
 * walkthrough for a real recording on one build variable. That boundary is the
 * point of the split: the capture, when it exists, changes one component.
 */
export function Demo(): React.JSX.Element {
  return (
    <Section
      id="demo"
      eyebrow="A turn, end to end"
      heading="See Axon in action."
      lede="Say what you want done. Axon turns the request into a controlled action, then checks what actually happened."
      className="demo"
    >
      <DemoStage />
    </Section>
  );
}
