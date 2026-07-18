import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TranscriptFeed } from '../src/transcript.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Feeds are driven by calling pollFile() directly — start() is never called,
// so no intervals are created and tests control every tick.
function makeFeed(file) {
  const heard = [];
  const feed = new TranscriptFeed({
    mode: 'file',
    file,
    pollSeconds: 999,
    windowSeconds: 120,
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
