/**
 * `wake:live` focus mode: why this voice's "Hey Axon" is not detected.
 *
 *   $env:AXON_WAKE_FOCUS='hey_axon'; $env:AXON_WAKE_DEBUG='1'; npm run wake:live
 *
 * Optional:
 *   AXON_WAKE_LIVE_RUNS=10              utterances of the phrase (default 10)
 *   AXON_WAKE_FOCUS_NEGATIVES=1         also measure hard negatives on the same instruments
 *   AXON_CAPTURE_PROCESSING=ec=off      one controlled preprocessing change (or ns=off, agc=off)
 *
 * Not a pass/fail test and never a claim of readiness. It prompts for ONE
 * phrase, and for every utterance reports what the production detector did
 * and what three instruments running on the SAME live frames measured
 * (`focus-report.ts`): a threshold ladder that brackets the keyword score, an
 * alignment fan across the model's 320 ms decode chunk, and a free decode of the
 * same acoustic model showing which word pieces it actually heard. At the end it
 * answers the investigation's questions from those numbers.
 *
 * Nothing is recorded. The free decode's text goes to this terminal only.
 */

const PHRASES = { hey_axon: 'Hey Axon', hello_axon: 'Hello Axon', hi_axon: 'Hi Axon' };
const NEGATIVES = ['Axon', 'Hey', 'Hey there', 'Hey Jackson', 'I was talking about Axon yesterday', 'Taxon'];
/** Long enough for the free decode's end-of-speech rule (0.5 s of silence) to report. */
const LISTEN_MS = 7_000;

async function runFocusSession(ctx) {
  const { focus, outDir, run, window, heard, wait, until, loopback, speakAloud } = ctx;
  const report = require(require('node:path').join(outDir, 'focus-report.js'));
  const { WAKE_KEYWORDS, DEFAULT_KEYWORD_THRESHOLD } = require(require('node:path').join(outDir, 'wake-keywords.js'));

  const phrase = PHRASES[focus];
  const keyword = WAKE_KEYWORDS.find((k) => k.id === focus);
  const runs = Math.max(1, Math.min(30, Number.parseInt(process.env.AXON_WAKE_LIVE_RUNS ?? '10', 10) || 10));
  const withNegatives = process.env.AXON_WAKE_FOCUS_NEGATIVES === '1';
  const processingLabel = process.env.AXON_CAPTURE_PROCESSING || 'default';
  const threshold = Number.parseFloat(process.env.AXON_WAKE_THRESHOLD ?? '') || DEFAULT_KEYWORD_THRESHOLD;

  console.log(`\nFOCUS MODE — "${phrase}" (${focus})`);
  console.log(`  utterances: ${runs}${withNegatives ? ` + negatives ${NEGATIVES.length}` : ''}   preprocessing: ${processingLabel}   production threshold: ${threshold}`);
  console.log('  This measures a failure mechanism. It does not decide whether the wake word is ready.\n');

  // The diagnostic process has to load eight spotters and a recognizer.
  const ready = await until(() => heard.some((e) => /focus diagnostic is listening/.test(e.line)), 40_000);
  const config = heard.filter((e) => /spotter CONFIG /.test(e.line)).map((e) => e.line.replace(/^\[wake\] spotter /, ''));
  console.log(`${ready ? '✓' : '✗'} focus diagnostic running`);
  for (const line of config) console.log(`  ${line}`);
  if (!ready) return 1;

  // --- the room, before anything is asked -------------------------------------------------
  // Measured: a loopback run with noise suppression off decoded long stretches of
  // speech nobody had played — somebody or something talking near the laptop.
  // Scored under that, a miss says nothing about the detector. So the room is
  // measured first, in silence, and reported as a WORD COUNT and a level: what
  // was said in the room is not printed.
  console.log('\n→ Stay SILENT for 8 seconds while the room is measured.');
  const ambientSince = Date.now();
  await wait(8_000);
  const ambientLines = heard.filter((e) => e.at >= ambientSince);
  const ambientWords = ambientLines
    .map((e) => report.parseFocusLine(e.line))
    .filter((e) => e && e.kind === 'heard')
    .reduce((n, e) => n + e.text.split(/\s+|\//).filter(Boolean).length, 0);
  const ambientPeak = ambientLines
    .filter((e) => /capture page/.test(e.line))
    .reduce((max, e) => Math.max(max, Number.parseFloat((/peak ([\d.]+)/.exec(e.line) ?? [])[1] ?? '0')), 0);
  const noisyRoom = ambientWords > 0;
  console.log(
    `  room: ${ambientWords} word(s) decoded in silence, capture peak ${ambientPeak.toFixed(3)}` +
      `${noisyRoom ? '   ⚠ COMPETING SPEECH IN THE ROOM — results below are confounded; find a quiet room' : '   quiet'}`,
  );

  const prompts = [
    ...Array.from({ length: runs }, () => ({ say: phrase, expect: true })),
    ...(withNegatives ? NEGATIVES.map((say) => ({ say, expect: false })) : []),
  ];

  const utterances = [];
  for (const [index, prompt] of prompts.entries()) {
    await until(async () => (await run('window.axon.getSnapshot().then((s) => s.voiceAgent.active)')) === false, 15_000);
    await wait(2_000);
    const since = Date.now();
    console.log(`\n→ [${index + 1}/${prompts.length}] ${loopback ? 'playing' : 'SAY NOW'}: "${prompt.say}"   (then stay quiet)`);
    if (loopback) await speakAloud(prompt.say);
    await wait(LISTEN_MS);
    const until_ = Date.now();

    const lines = heard.filter((e) => e.at >= since && e.at <= until_);
    const activations = lines
      .map((e) => /heard \[SPOTTER (\w+)\].*-> ACTIVATE/.exec(e.line))
      .filter(Boolean)
      .map((m) => m[1]);
    const events = lines.map((e) => report.parseFocusLine(e.line)).filter(Boolean);
    const capture = lines.filter((e) => /capture page/.test(e.line)).map((e) => e.line);

    utterances.push({ prompt, since, until: until_, activations, events, capture });
    const hits = events.filter((e) => e.kind === 'hit' && e.id === focus);
    const heardText = events.filter((e) => e.kind === 'heard').map((e) => e.text).join(' / ');
    console.log(`  production: ${activations.length > 0 ? `ACTIVATED (${activations.join(', ')})` : 'no activation'}   instruments: ${hits.length} hit(s)   model heard: ${heardText || '(nothing)'}`);

    if (activations.length > 0) {
      await run('window.axon.stopVoiceSession()');
      await until(async () => !window.isVisible(), 8_000);
    }
  }
  // Let the last diagnostic STATS window close, so drops during the last utterance are counted.
  await wait(5_500);

  // --- classify ------------------------------------------------------------------------
  const statsLines = heard
    .filter((e) => /spotter STATS focus /.test(e.line))
    .map((e) => ({ at: e.at, dropped: Number.parseInt((/dropped=(\d+)ms/.exec(e.line) ?? [])[1] ?? '0', 10) }));

  const verdicts = utterances.map((u) => {
    const droppedMs = statsLines
      .filter((s) => s.at > u.since && s.at - 5_000 < u.until)
      .reduce((sum, s) => sum + s.dropped, 0);
    const verdict = report.classifyUtterance({
      activated: u.prompt.expect ? u.activations.includes(focus) : u.activations.length > 0,
      hits: u.events.filter((e) => e.kind === 'hit' && e.id === focus),
      heard: u.events.filter((e) => e.kind === 'heard'),
      productionThreshold: threshold,
      keywordPieces: keyword.pieces,
      diagnosticDroppedMs: droppedMs,
    });
    const levelLine = u.capture[u.capture.length - 1] ?? '';
    // Loudest capture-page window during the utterance: peak and clipped samples.
    // Clipping is a confound, and it has to be visible next to the verdict.
    const capturePeak = u.capture.reduce((max, line) => Math.max(max, Number.parseFloat((/peak ([\d.]+)/.exec(line) ?? [])[1] ?? '0')), 0);
    const clipped = u.capture.reduce((sum, line) => sum + Number.parseInt((/clipped (\d+)/.exec(line) ?? [])[1] ?? '0', 10), 0);
    const pipeline = (/\[(track-processor|script-processor)\]/.exec(levelLine) ?? [])[1] ?? '?';
    const source = (/source (\d+) Hz/.exec(levelLine) ?? [])[1] ?? '?';
    const ec = (/ec=(\w+)/.exec(levelLine) ?? [])[1] ?? '?';
    const ns = (/ns=(\w+)/.exec(levelLine) ?? [])[1] ?? '?';
    const agc = (/agc=(\w+)/.exec(levelLine) ?? [])[1] ?? '?';
    // Words the free decode heard during the utterance, beyond the phrase itself.
    const phraseWords = u.prompt.say.split(/\s+/).length;
    const heardWords = verdict.heardText.split(/\s+|\//).filter(Boolean).length;
    const extraWords = Math.max(0, heardWords - phraseWords);
    return { u, verdict, droppedMs, capturePeak, clipped, extraWords, format: { pipeline, source, ec, ns, agc }, otherActivations: u.activations.filter((id) => id !== focus) };
  });

  const printable = (pieces) => pieces.map((p) => p.replace(/▁/g, '_')).join(' ');
  console.log('\n\nFOCUS DIAGNOSTIC — PER UTTERANCE\n');
  for (const [i, { u, verdict, droppedMs, capturePeak, clipped, extraWords, format, otherActivations }] of verdicts.entries()) {
    const bracket =
      verdict.scoreAtLeast === null
        ? `< ${report.FOCUS_THRESHOLDS[0]} (never produced at offset 0)`
        : verdict.scoreBelow === null
          ? `>= ${verdict.scoreAtLeast}`
          : `${verdict.scoreAtLeast} <= score < ${verdict.scoreBelow}`;
    console.log(`#${i + 1} spoken: "${u.prompt.say}"   ${u.prompt.expect ? '' : '(NEGATIVE) '}`);
    console.log(`   result:        ${verdict.result}${otherActivations.length ? `   (production also activated on ${otherActivations.join(', ')})` : ''}`);
    const anyCandidate = verdict.ladderFired.length > 0 || verdict.offsetsFiring.length > 0;
    console.log(`   candidate:     ${anyCandidate ? focus : 'NONE'}   score bracket (offset 0): ${bracket}   production threshold: ${threshold}`);
    console.log(`   alignment:     fired at ${verdict.offsetsFiring.length}/${report.FOCUS_OFFSETS_MS.length} offsets (${verdict.offsetsFiring.join(', ') || '—'} ms) of a ${report.MODEL_CHUNK_MS} ms decode chunk`);
    // Truncated: the phrase is two words, and anything much longer is the room.
    const shown = verdict.heardText.length > 60 ? `${verdict.heardText.slice(0, 60)}…` : verdict.heardText;
    const pieceText = verdict.heardPieces.length > 12 ? `${verdict.heardPieces.length} pieces` : printable(verdict.heardPieces) || '—';
    console.log(`   model heard:   ${shown || '(nothing)'}   pieces: ${pieceText}`);
    if (extraWords > 2) console.log(`   ⚠ confound:    ${extraWords} extra word(s) decoded during this utterance — competing speech`);
    console.log(`   log-probs:     ${verdict.heardLogProbs.map((v) => v.toFixed(2)).join(' ') || '—'}`);
    console.log(`   missing:       ${verdict.missing.length ? printable(verdict.missing) : 'none — every keyword piece was emitted'}`);
    const segmentLevel = verdict.heardText ? `segment rms ${verdict.rms.toFixed(3)} peak ${verdict.peak.toFixed(3)}` : 'segment level n/a';
    console.log(`   audio:         ${segmentLevel}   capture peak ${capturePeak.toFixed(3)}   clipped samples ${clipped}${clipped > 0 ? ' — CLIPPING (confound)' : ''}`);
    console.log(`   format:        source ${format.source} Hz -> 16000 Hz mono PCM16 LE [${format.pipeline}] ec=${format.ec} ns=${format.ns} agc=${format.agc}`);
    console.log(`   diagnostic:    dropped ${droppedMs} ms during this utterance${droppedMs > 0 ? ' — MEASUREMENT INVALID' : ''}`);
  }

  // --- answers ------------------------------------------------------------------------
  const positives = verdicts.filter((v) => v.u.prompt.expect);
  const negatives = verdicts.filter((v) => !v.u.prompt.expect);
  const valid = positives.filter((v) => v.verdict.result !== 'INVALID');
  const count = (result) => positives.filter((v) => v.verdict.result === result).length;

  console.log('\n\nFOCUS DIAGNOSTIC — SUMMARY\n');
  console.log(`  preprocessing: ${processingLabel}   utterances: ${positives.length} (${positives.length - valid.length} invalid)`);
  const confounded = verdicts.filter((v) => v.extraWords > 2).length;
  console.log(`  room: ${ambientWords} word(s) in silence${noisyRoom ? ' — CONFOUNDED' : ''}   utterances with competing speech: ${confounded}/${verdicts.length}\n`);
  console.log('  threshold | candidates (offset 0) | detected (production)');
  for (const row of report.ladderTable(positives.map((v) => v.verdict))) {
    console.log(`  ${row.threshold.toFixed(2).padEnd(9)} | ${String(row.candidates).padEnd(21)} | ${row.detected}`);
  }
  if (negatives.length > 0) {
    console.log('\n  negatives   threshold | fired (offset 0)');
    for (const row of report.ladderTable(negatives.map((v) => v.verdict))) {
      console.log(`              ${row.threshold.toFixed(2).padEnd(9)} | ${row.candidates}`);
    }
    console.log(`  negatives that activated production: ${negatives.filter((v) => v.u.activations.length > 0).length}/${negatives.length}`);
  }

  const alignmentHistogram = report.FOCUS_OFFSETS_MS.map((_, k) => valid.filter((v) => v.verdict.offsetsFiring.length === k + 1).length);
  const missingCounts = new Map();
  for (const v of valid) for (const piece of v.verdict.missing) missingCounts.set(piece, (missingCounts.get(piece) ?? 0) + 1);
  const configOk = config.some((l) => /fileRoundTrip=ok/.test(l)) && !config.some((l) => /MISSING/.test(l));

  console.log('\n  1. Does the model produce a candidate?');
  console.log(`     ${valid.filter((v) => v.verdict.ladderFired.length > 0 || v.verdict.offsetsFiring.length > 0).length}/${valid.length} valid utterances produced "${focus}" at some threshold >= ${report.FOCUS_THRESHOLDS[0]} or some alignment.`);
  console.log('  2. What score does it produce?');
  console.log(`     brackets: ${valid.map((v) => (v.verdict.scoreAtLeast === null ? '<0.01' : v.verdict.scoreBelow === null ? `>=${v.verdict.scoreAtLeast}` : `${v.verdict.scoreAtLeast}-${v.verdict.scoreBelow}`)).join(', ') || '—'}`);
  console.log('  3. Is the score below the threshold?');
  console.log(`     DETECTED ${count('DETECTED')}   BELOW_THRESHOLD ${count('BELOW_THRESHOLD')}   MISSED_BY_ALIGNMENT ${count('MISSED_BY_ALIGNMENT')}   NO_CANDIDATE ${count('NO_CANDIDATE')}   INVALID ${count('INVALID')}`);
  console.log('  4. Is alignment causing misses?');
  console.log(`     offsets firing at the production threshold, per utterance: ${alignmentHistogram.map((n, k) => `${k + 1}/${report.FOCUS_OFFSETS_MS.length}: ${n}`).join('   ')}   0/${report.FOCUS_OFFSETS_MS.length}: ${valid.filter((v) => v.verdict.offsetsFiring.length === 0).length}`);
  console.log('  5. Is preprocessing affecting recall?');
  console.log(`     this run: ${processingLabel}. Compare the table above across runs with AXON_CAPTURE_PROCESSING=ec=off, ns=off, agc=off — one per run.`);
  console.log('  6. Is the issue speaker-specific?');
  console.log('     Compare this table with the same run spoken by another person, and with the synthetic baseline in docs/wake-word.md.');
  console.log('  7. Is the runtime keyword configuration correct?');
  console.log(`     ${configOk ? 'YES' : 'NO'} — ${config.length} CONFIG line(s) above: every piece resolves to a token id and the keywords file round-trips.`);
  console.log('  8. What the model heard instead:');
  console.log(`     pieces most often missing: ${[...missingCounts.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${printable([p])} (${n})`).join(', ') || 'none'}`);
  const brief = (text) => (text.length > 40 ? `${text.slice(0, 40)}…` : text || '—');
  console.log(`     free decodes: ${valid.map((v) => `"${brief(v.verdict.heardText)}"`).join(', ')}`);
  console.log('\n  This is a diagnostic. It does not change the production threshold, and it does not say the wake word is ready.\n');
  return 0;
}

module.exports = { runFocusSession };
