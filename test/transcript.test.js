import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TranscriptFeed } from '../src/transcript.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Feeds are driven by calling pollFile() directly — start() is never called,
// so no intervals are created and tests control every tick.
function makeFeed(file, speech) {
  const heard = [];
  const feed = new TranscriptFeed({
    mode: 'file',
    file,
    pollSeconds: 999,
    windowSeconds: 120,
    speech,
    onSpeech: (line) => heard.push(line),
  });
  return { feed, heard };
}

function withTmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hg-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'captions.txt');
}

test('tails appended lines and fires onSpeech per line', (t) => {
  const file = withTmp(t);
  const { feed, heard } = makeFeed(file);
  writeFileSync(file, 'hello world\n');
  feed.pollFile();
  assert.deepEqual(heard, ['hello world']);
  appendFileSync(file, 'second line\n');
  feed.pollFile();
  assert.deepEqual(heard, ['hello world', 'second line']);
  assert.equal(feed.getWindow(), 'hello world second line');
});

test('holds back a partial trailing line until its newline arrives', (t) => {
  const file = withTmp(t);
  const { feed, heard } = makeFeed(file);
  writeFileSync(file, 'incompl');
  feed.pollFile();
  assert.deepEqual(heard, []);
  appendFileSync(file, 'ete line\n');
  feed.pollFile();
  assert.deepEqual(heard, ['incomplete line']);
});

test('filters SRT sequence numbers and timing lines', (t) => {
  const file = withTmp(t);
  const { feed, heard } = makeFeed(file);
  writeFileSync(file, '1\n00:00:01,000 --> 00:00:02,500\nhello there\n\n2\n00:00:03,000 --> 00:00:04,000\nsecond bit\n\n');
  feed.pollFile();
  assert.deepEqual(heard, ['hello there', 'second bit']);
});

test('detects a shrunk (rewritten) file and re-reads from the top', (t) => {
  const file = withTmp(t);
  const { feed, heard } = makeFeed(file);
  writeFileSync(file, 'a much longer first version of the file\n');
  feed.pollFile();
  writeFileSync(file, 'fresh\n');
  feed.pollFile();
  assert.deepEqual(heard, ['a much longer first version of the file', 'fresh']);
});

test('detects a same-size rewrite via the head check', async (t) => {
  const file = withTmp(t);
  const { feed, heard } = makeFeed(file);
  writeFileSync(file, 'aaaa line\n');
  feed.pollFile();
  await sleep(15); // ensure a distinct mtime tick
  writeFileSync(file, 'bbbb line\n'); // same byte length
  feed.pollFile();
  assert.deepEqual(heard, ['aaaa line', 'bbbb line']);
});

test('getWindow prunes entries older than the window and honors sinceTs', (t) => {
  const file = withTmp(t);
  const { feed } = makeFeed(file);
  feed.addLine('old speech');
  feed.addLine('new speech');
  feed.entries[0].ts = Date.now() - 200_000; // beyond the 120s window
  assert.equal(feed.getWindow(), 'new speech');
  assert.equal(feed.getWindow(Date.now() + 1000), ''); // nothing newer than the future
});

// The speech-quality layer sits between the tail and onSpeech, so a dropped
// hallucination never reaches the deck feed, a voice reply, or the window.
test('drops transcription hallucinations before they reach onSpeech', (t) => {
  const file = withTmp(t);
  const { feed, heard } = makeFeed(file, {});
  writeFileSync(file, 'Thank you.\n[Music]\nokay that boss is actually unfair\n');
  feed.pollFile();
  assert.deepEqual(heard, ['okay that boss is actually unfair']);
  assert.equal(feed.getWindow(), 'okay that boss is actually unfair');
});

test('hallucination filtering can be turned off', (t) => {
  const file = withTmp(t);
  const { feed, heard } = makeFeed(file, { dropHallucinations: false });
  writeFileSync(file, 'Thank you.\n');
  feed.pollFile();
  assert.deepEqual(heard, ['Thank you.']);
});

test('applies word fixes before the line is stored or announced', (t) => {
  const file = withTmp(t);
  const { feed, heard } = makeFeed(file, { corrections: [{ from: 'bacon', to: 'Beacon' }] });
  writeFileSync(file, 'lol bacon is right\n');
  feed.pollFile();
  assert.deepEqual(heard, ['lol Beacon is right']);
  assert.equal(feed.getWindow(), 'lol Beacon is right');
});

// Accepting mic-check fixes is a hot config save: the server deep-assigns into
// the same speech object the feed holds, so the next line must already use them
// without an app relaunch.
test('picks up corrections swapped in live, without reconstruction', (t) => {
  const file = withTmp(t);
  const speech = { corrections: [] };
  const { feed, heard } = makeFeed(file, speech);
  writeFileSync(file, 'hey bacon\n');
  feed.pollFile();
  speech.corrections = [{ from: 'bacon', to: 'Beacon' }];
  appendFileSync(file, 'hey bacon again\n');
  feed.pollFile();
  assert.deepEqual(heard, ['hey bacon', 'hey Beacon again']);
});

test('a line deleted entirely by a fix never reaches onSpeech', (t) => {
  const file = withTmp(t);
  const { feed, heard } = makeFeed(file, { corrections: [{ from: 'subscribe now', to: '' }] });
  writeFileSync(file, 'subscribe now\nreal speech here\n');
  feed.pollFile();
  assert.deepEqual(heard, ['real speech here']);
});

// textSource mode must drive the exact same onSpeech path as file mode — the
// deck's "heard" feed echo and voice replies hang off that callback, so both
// transcription modes get identical behavior.
test('textSource mode fires onSpeech on changed captions, same as file mode', async (t) => {
  let sourceText = 'stale pre-launch caption';
  const heard = [];
  const feed = new TranscriptFeed({
    mode: 'textSource',
    textSource: 'LocalVocal Captions',
    pollSeconds: 999,
    windowSeconds: 120,
    obs: { getTextSourceText: async () => sourceText },
    onSpeech: (line) => heard.push(line),
  });
  // Prime exactly like start() does: the pre-launch caption is not fresh speech.
  feed.lastSourceText = await feed.obs.getTextSourceText(feed.textSource);
  await feed.pollTextSource();
  assert.deepEqual(heard, [], 'primed caption must not fire');
  sourceText = 'did you see that dragon';
  await feed.pollTextSource();
  await feed.pollTextSource(); // unchanged caption fires only once
  assert.deepEqual(heard, ['did you see that dragon']);
  sourceText = null; // OBS unreachable mid-stream
  await feed.pollTextSource();
  sourceText = '00:01:02,000 --> 00:01:04,000'; // SRT timing junk is filtered here too
  await feed.pollTextSource();
  assert.deepEqual(heard, ['did you see that dragon']);
  assert.equal(feed.getWindow(), 'did you see that dragon');
});

// ---------------------------------------------------------------------------
// Vocabulary matching, health observation, and engine mode — the wiring that
// joins the speech layer, the diagnostics and the local engine to the feed.
// ---------------------------------------------------------------------------

function makeVocabFeed({ speech = {}, terms = [] } = {}) {
  const heard = [];
  const feed = new TranscriptFeed({
    mode: 'off',
    speech,
    terms: () => terms,
    onSpeech: (line) => heard.push(line),
  });
  return { feed, heard };
}

test('a mangled tracked name is recovered, and ordinary speech is left alone', () => {
  const { feed, heard } = makeVocabFeed({ terms: ['Beacon', 'Hollow Knight'] });
  feed.addLine('hey bacon did you see that');
  feed.addLine('back on hollow night again');
  feed.addLine('i had pecan pie'); // sounds close, looks nothing like it
  assert.deepEqual(heard, [
    'hey Beacon did you see that',
    'back on Hollow Knight again',
    'i had pecan pie',
  ]);
});

test("the streamer's own fixes run first and win", () => {
  // A correction is the streamer telling us, not guessing, so it must not be
  // second-guessed by the phonetic pass afterwards.
  const { feed, heard } = makeVocabFeed({
    speech: { corrections: [{ from: 'wasp', to: 'Wisp' }] },
    terms: ['Wisp', 'Wasteland'],
  });
  feed.addLine('wasp is asking again');
  assert.deepEqual(heard, ['Wisp is asking again']);
});

test('matchVocabulary: false leaves the transcript exactly as heard', () => {
  const { feed, heard } = makeVocabFeed({ speech: { matchVocabulary: false }, terms: ['Beacon'] });
  feed.addLine('hey bacon');
  assert.deepEqual(heard, ['hey bacon']);
});

test('health observes every line, flagging the ones dropped as filler', () => {
  const { feed, heard } = makeVocabFeed();
  feed.addLine('that was a clutch play');
  feed.addLine('Thank you.'); // whisper filler invented during silence
  const { stats } = feed.health.report();
  assert.deepEqual(heard, ['that was a clutch play']);
  assert.equal(stats.observed, 2, 'a dropped line is still evidence about VAD');
  assert.equal(stats.dropped, 1);
});

test('engine mode refuses a non-loopback URL instead of dialing out', async () => {
  // The audio-never-leaves-your-PC promise is a product claim, so a remote
  // engine URL must fail closed rather than connect.
  const feed = new TranscriptFeed({ mode: 'engine', engineUrl: 'ws://example.com:9090', onSpeech: () => {} });
  feed.start();
  await sleep(50); // `ws` is imported lazily, so the engine appears a tick later
  assert.equal(feed.engine.status().connected, false);
  feed.engine.stop();
});

test('engine mode with no URL configured never constructs an engine', () => {
  const feed = new TranscriptFeed({ mode: 'engine', onSpeech: () => {} });
  feed.start();
  assert.equal(feed.engine, null);
});
