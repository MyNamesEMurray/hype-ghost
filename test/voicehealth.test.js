import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceHealth, THRESHOLDS } from '../src/voicehealth.js';

// A deterministic clock: every helper below advances it explicitly, so no test
// depends on wall time or on how long the suite takes to run.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

function make(opts = {}) {
  const c = clock();
  const vh = new VoiceHealth({ now: c.now, ...opts });
  return { vh, c };
}

const byId = (report, id) => report.checks.find((ch) => ch.id === id);

// Varied, whole sentences of the kind a streamer actually produces with the
// plugin set up correctly.
const HEALTHY_LINES = [
  'okay chat that was genuinely the worst dodge i have ever done on stream',
  'i think we need to sell the extra potions before heading back down there',
  'somebody in chat said the boss telegraphs it and honestly they were right',
  'give me one second while i read what you all just posted about the build',
  'the frame rate is fine it is my hands that are the problem here tonight',
  'we are going for the achievement even if it takes the rest of the evening',
  'that sound effect gets me every single time i swear it is not fair',
  'right so the plan is left through the tunnel then up the ladder quickly',
];

/** Feed n distinct, well-formed sentences one second apart. */
function feedHealthy(vh, c, n = 30) {
  for (let i = 0; i < n; i++) {
    c.advance(1000);
    vh.observe(`${HEALTHY_LINES[i % HEALTHY_LINES.length]} take ${i}`);
  }
}

// ---- report shape ----

test('report is serializable and every check has the documented shape', () => {
  const { vh, c } = make();
  feedHealthy(vh, c);
  const report = vh.report();
  assert.deepEqual(
    report.checks.map((ch) => ch.id).sort(),
    ['buffer_too_short', 'decoder_stuck', 'no_transcript', 'partial_transcription', 'vad_hallucinations'],
  );
  for (const ch of report.checks) {
    assert.deepEqual(Object.keys(ch).sort(), ['detail', 'fix', 'id', 'level', 'title']);
    for (const key of ['id', 'level', 'title', 'detail', 'fix']) assert.equal(typeof ch[key], 'string');
    assert.ok(['ok', 'warn', 'unknown'].includes(ch.level), `bad level: ${ch.level}`);
    assert.ok(ch.fix.length > 0);
  }
  // Must survive a round trip: the UI gets this over the WebSocket.
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(typeof report.stats.observed, 'number');
});

test('healthy speech leaves every check quiet', () => {
  const { vh, c } = make();
  feedHealthy(vh, c, 40);
  for (const ch of vh.report().checks) {
    assert.equal(ch.level, 'ok', `${ch.id} should be ok: ${ch.detail}`);
  }
});

// ---- 1. partial transcription ----

test('partial transcription fires when lines keep extending the previous line', () => {
  const { vh, c } = make();
  const sentences = [
    'so the plan here is we go left and then around the back',
    'honestly i think that boss is way easier than people say',
    'we should probably upgrade the shield before the next fight',
    'that jump took me about forty tries last time i promise',
    'alright chat i am reading the messages give me one second',
  ];
  for (const s of sentences) {
    const words = s.split(' ');
    // LocalVocal partial mode writes the sentence three times as it forms.
    for (const cut of [4, 8, words.length]) {
      c.advance(400);
      vh.observe(words.slice(0, cut).join(' '));
    }
  }
  const check = byId(vh.report(), 'partial_transcription');
  assert.equal(check.level, 'warn');
  assert.match(check.fix, /Partial Transcription/i);
});

test('partial transcription also catches re-decoded near-duplicates', () => {
  const { vh, c } = make();
  for (let i = 0; i < 8; i++) {
    c.advance(500);
    vh.observe(`i think we should go left at the fork here number ${i}`);
    c.advance(500);
    vh.observe(`i think we shoud go left at the fork here number ${i}`);
  }
  assert.equal(byId(vh.report(), 'partial_transcription').level, 'warn');
});

test('partial transcription reports unknown below the minimum pair count', () => {
  const { vh, c } = make();
  // Every pair is a redraw, but there are too few pairs to conclude anything.
  for (let i = 0; i < THRESHOLDS.PARTIAL_MIN_PAIRS - 2; i++) {
    c.advance(500);
    vh.observe(i % 2 ? 'we should go left at the fork' : 'we should go left');
  }
  const check = byId(vh.report(), 'partial_transcription');
  assert.equal(check.level, 'unknown');
  assert.match(check.detail, /not enough/i);
});

test('a streamer genuinely repeating themselves once does not trip partial', () => {
  const { vh, c } = make();
  feedHealthy(vh, c, 30);
  c.advance(1000);
  vh.observe(`${HEALTHY_LINES[0]} take 0`); // the same thing said twice, once
  assert.equal(byId(vh.report(), 'partial_transcription').level, 'ok');
});

// ---- 2. buffer size ----

test('short fragment lines point at the buffer size', () => {
  const { vh, c } = make();
  for (const frag of ['okay so', 'yeah no', 'wait what', 'hold on', 'i mean', 'right okay', 'come on', 'oh no', 'we go', 'that one', 'up there', 'nope nope', 'let me', 'one sec', 'here we', 'go now', 'like that']) {
    c.advance(800);
    vh.observe(frag);
  }
  const check = byId(vh.report(), 'buffer_too_short');
  assert.equal(check.level, 'warn');
  assert.match(check.fix, /Buffer size \(ms\)/);
});

test('buffer check reports unknown below the minimum line count', () => {
  const { vh, c } = make();
  for (let i = 0; i < THRESHOLDS.BUFFER_MIN_LINES - 1; i++) {
    c.advance(800);
    vh.observe('yeah no');
  }
  assert.equal(byId(vh.report(), 'buffer_too_short').level, 'unknown');
  c.advance(800);
  vh.observe('yeah no');
  assert.equal(byId(vh.report(), 'buffer_too_short').level, 'warn');
});

// ---- 3. VAD / hallucinations ----

test('a high hallucination drop rate points at VAD', () => {
  const { vh, c } = make();
  for (let i = 0; i < 30; i++) {
    c.advance(1000);
    // Every third line is silence filler the speech layer threw away.
    if (i % 3 === 0) vh.observe('thank you', { dropped: true });
    else vh.observe(`that was a clutch play number ${i} and i did not see it coming`);
  }
  const check = byId(vh.report(), 'vad_hallucinations');
  assert.equal(check.level, 'warn');
  assert.match(check.fix, /VAD/);
});

test('the occasional dropped filler line is normal, not a warning', () => {
  const { vh, c } = make();
  for (let i = 0; i < 40; i++) {
    c.advance(1000);
    if (i === 7) vh.observe('thank you', { dropped: true });
    else vh.observe(`that was a clutch play number ${i} and i did not see it coming`);
  }
  assert.equal(byId(vh.report(), 'vad_hallucinations').level, 'ok');
});

test('VAD check reports unknown below the minimum observation count', () => {
  const { vh, c } = make();
  for (let i = 0; i < THRESHOLDS.DROP_MIN_OBSERVATIONS - 1; i++) {
    c.advance(1000);
    vh.observe('thank you', { dropped: true });
  }
  assert.equal(byId(vh.report(), 'vad_hallucinations').level, 'unknown');
});

test('dropped lines do not count as heard speech but do count as pipeline traffic', () => {
  const { vh, c } = make();
  c.advance(1000);
  vh.observe('thank you', { dropped: true });
  const { stats } = vh.report();
  assert.equal(stats.observed, 1);
  assert.equal(stats.kept, 0);
  assert.equal(stats.dropped, 1);
  assert.equal(stats.lastKeptAt, null);
  assert.equal(stats.lastObservedAt, c.now());
});

// ---- 4. nothing heard ----

test('silence is unknown early and a hedged warning after the window', () => {
  const { vh, c } = make();
  const early = byId(vh.report(), 'no_transcript');
  assert.equal(early.level, 'unknown');

  c.advance(THRESHOLDS.SILENCE_MS + 1000);
  const late = byId(vh.report(), 'no_transcript');
  assert.equal(late.level, 'warn');
  // Honest wording: we cannot tell a broken mic from a quiet streamer.
  assert.match(late.detail, /or nobody has spoken/i);
});

test('the silence window resets on every arriving line, dropped ones included', () => {
  const { vh, c } = make();
  c.advance(THRESHOLDS.SILENCE_MS - 1000);
  vh.observe('okay chat here is the plan for this run', {});
  c.advance(THRESHOLDS.SILENCE_MS - 1000);
  assert.equal(byId(vh.report(), 'no_transcript').level, 'ok');

  c.advance(2000); // now past the window
  assert.equal(byId(vh.report(), 'no_transcript').level, 'warn');

  // Even a hallucination proves LocalVocal is writing where we are looking.
  vh.observe('thank you', { dropped: true });
  assert.equal(byId(vh.report(), 'no_transcript').level, 'ok');
});

// ---- 5. decoder stuck ----

test('the same line arriving repeatedly points at the sampling settings', () => {
  const { vh, c } = make();
  feedHealthy(vh, c, 10);
  for (let i = 0; i < THRESHOLDS.STUCK_RUN; i++) {
    c.advance(1000);
    vh.observe('and then we go in there.');
  }
  const check = byId(vh.report(), 'decoder_stuck');
  assert.equal(check.level, 'warn');
  assert.match(check.fix, /Temperature|Beam size/i);
  assert.equal(vh.report().stats.longestRepeatRun, THRESHOLDS.STUCK_RUN);
});

test('decoder check reports unknown below the minimum line count', () => {
  const { vh, c } = make();
  for (let i = 0; i < THRESHOLDS.STUCK_MIN_LINES - 1; i++) {
    c.advance(1000);
    vh.observe('and then we go in there');
  }
  assert.equal(byId(vh.report(), 'decoder_stuck').level, 'unknown');
});

test('a run that is interrupted does not count as stuck', () => {
  const { vh, c } = make();
  for (let i = 0; i < 16; i++) {
    c.advance(1000);
    vh.observe(i % 3 === 2 ? `something else entirely happened at step ${i}` : 'and then we go in there');
  }
  assert.equal(byId(vh.report(), 'decoder_stuck').level, 'ok');
});

// ---- ring bound ----

test('the observation ring is bounded and keeps the newest lines', () => {
  const { vh, c } = make({ maxObservations: 10 });
  for (let i = 0; i < 500; i++) {
    c.advance(100);
    vh.observe(`line number ${i} of the stream and it keeps going`);
  }
  const { stats } = vh.report();
  assert.equal(vh.observations.length, 10);
  assert.equal(stats.observed, 10);
  assert.equal(stats.ringCapacity, 10);
  // Lifetime counters survive eviction, so long-run totals stay honest.
  assert.equal(stats.totalObserved, 500);
  assert.equal(vh.observations[vh.observations.length - 1].norm.includes('499'), true);
});

test('a fixed problem ages out of the ring once healthy lines replace it', () => {
  const { vh, c } = make({ maxObservations: 30 });
  for (let i = 0; i < 30; i++) {
    c.advance(500);
    vh.observe('thank you', { dropped: true });
  }
  assert.equal(byId(vh.report(), 'vad_hallucinations').level, 'warn');
  feedHealthy(vh, c, 30);
  assert.equal(byId(vh.report(), 'vad_hallucinations').level, 'ok');
});

// ---- clock and pathological input ----

test('an explicit ts overrides the clock and drives the silence window', () => {
  const { vh, c } = make();
  vh.observe('here is a whole sentence for the record', { ts: c.now() - THRESHOLDS.SILENCE_MS - 5000 });
  const check = byId(vh.report(), 'no_transcript');
  assert.equal(check.level, 'warn');
  assert.equal(vh.report().stats.secondsSinceHeard, Math.round((THRESHOLDS.SILENCE_MS + 5000) / 1000));
});

test('report on an empty history is safe and entirely unknown', () => {
  const { vh } = make();
  const report = vh.report();
  for (const ch of report.checks) assert.equal(ch.level, 'unknown', ch.id);
  assert.equal(report.stats.observed, 0);
  assert.equal(report.stats.medianWords, 0);
  assert.equal(report.stats.longestRepeatRun, 0);
  assert.equal(report.stats.dropRate, 0);
  assert.equal(report.stats.secondsSinceHeard, null);
});

test('empty, unicode and enormous lines never throw and are bounded', () => {
  const { vh, c } = make();
  for (const line of ['', '   ', '\n\t', '♪♪♪', '日本語のテスト行です', 'ñandú göö'.repeat(3), 'x'.repeat(50_000), 'a b '.repeat(20_000)]) {
    c.advance(1000);
    assert.doesNotThrow(() => vh.observe(line));
  }
  vh.observe(undefined);
  vh.observe(null, { ts: 'nonsense', dropped: 'yes' });
  vh.observe({ toString: () => 'an object line that stringifies fine' });
  assert.doesNotThrow(() => vh.report());
  // Nothing stored may exceed the comparison cap, however long the input was.
  for (const o of vh.observations) assert.ok(o.norm.length <= THRESHOLDS.MAX_COMPARE_CHARS);
  // A truthy non-boolean `dropped` is not a drop — only an explicit true is.
  assert.equal(vh.report().stats.totalDropped, 0);
});

test('blank lines count as pipeline traffic but never as heard speech', () => {
  const { vh, c } = make();
  for (let i = 0; i < 25; i++) {
    c.advance(1000);
    vh.observe('   ');
  }
  const { stats } = vh.report();
  assert.equal(stats.observed, 25);
  assert.equal(stats.kept, 0);
  assert.equal(byId(vh.report(), 'buffer_too_short').level, 'unknown');
  assert.equal(byId(vh.report(), 'no_transcript').level, 'ok');
});

test('the default clock is Date.now when none is injected', () => {
  const vh = new VoiceHealth();
  const before = Date.now();
  vh.observe('a line said out loud at some point');
  assert.ok(vh.lastObservedAt >= before);
  assert.equal(byId(vh.report(), 'no_transcript').level, 'ok');
});
