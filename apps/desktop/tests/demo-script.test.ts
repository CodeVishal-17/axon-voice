/**
 * `docs/DEMO.md` is the canonical demo, not a description of it.
 *
 * The document is generated from `CANONICAL_DEMO`, and this test fails when
 * the file on disk is not exactly what the generator produces — so a change to
 * the script that nobody re-rendered, or an edit to the document that nobody
 * made in the script, is caught here rather than on stage.
 *
 *   npm run demo:doc      regenerates it
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANONICAL_DEMO } from './support/canonical-demo.js';
import { renderDemoDocument } from './support/demo-document.js';

const DOC = path.resolve(__dirname, '../../../docs/DEMO.md');
const WRITE = process.env.npm_lifecycle_event === 'demo:doc';

describe('the demo document', () => {
  it('is exactly what the canonical script renders to', () => {
    const rendered = renderDemoDocument();
    if (WRITE) {
      fs.mkdirSync(path.dirname(DOC), { recursive: true });
      fs.writeFileSync(DOC, rendered, 'utf8');
    }
    expect(fs.existsSync(DOC), 'docs/DEMO.md is missing — run `npm run demo:doc`').toBe(true);
    expect(fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n')).toBe(rendered);
  });

  it('contains every spoken command, word for word', () => {
    const doc = renderDemoDocument();
    for (const beat of CANONICAL_DEMO) expect(doc).toContain(`*"${beat.say}"*`);
  });

  it('carries no credential and no real personal secret', () => {
    const doc = renderDemoDocument();
    expect(doc).not.toMatch(/hunter2|ghp_|sk-ant-|ASSEMBLYAI_API_KEY=/);
  });

  it('tells the truth about the wake-word test instead of hiding it', () => {
    const doc = renderDemoDocument();
    expect(doc).toContain('Hey Axon');
    expect(doc).toContain('Hello Axon');
    expect(doc).toContain('Hi Axon');
    expect(doc).toMatch(/does not\s+reliably finalise a synthesised phrase/);
  });
});
