import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain, parseResponse } from '../src/brain.js';

test('parseResponse passes plain text through trimmed', () => {
  assert.deepEqual(parseResponse('  clean run so far  ', 'Beacon'), { text: 'clean run so far', notes: null });
});

test('parseResponse strips surrounding quotes and a leaked name prefix', () => {
  assert.equal(parseResponse('"nice dodge"', 'Beacon').text, 'nice dodge');
  assert.equal(parseResponse('Beacon: nice dodge', 'Beacon').text, 'nice dodge');
  assert.equal(parseResponse('beacon:   nice dodge', 'Beacon').text, 'nice dodge'); // case-insensitive
});

test('parseResponse survives a bot name full of regex metacharacters', () => {
  assert.equal(parseResponse('G(h)o$t*: hey', 'G(h)o$t*').text, 'hey');
});

test('parseResponse splits out session notes on the delimiter, in any dress', () => {
  for (const delim of ['---NOTES---', '-----NOTES-----', '--- notes ---']) {
    const { text, notes } = parseResponse(`the message\n${delim}\nplaying hades, died to hydra`, 'Beacon');
    assert.equal(text, 'the message');
    assert.equal(notes, 'playing hades, died to hydra');
  }
});

test('parseResponse caps runaway notes at 1000 chars', () => {
  const { notes } = parseResponse(`msg\n---NOTES---\n${'x'.repeat(5000)}`, 'Beacon');
  assert.equal(notes.length, 1000);
});

test('the static system prompt clears the minimum cacheable prefix', () => {
  // The prompt length is load-bearing: below ~1024 tokens the cache_control
  // marker in generate() goes inert and every message pays full input rate
  // for the prefix. ~1.3 tokens/word makes 850 words a safe floor even with
  // an empty personality and no stream context. Don't trim below this —
  // grow the prompt (or lower this only with a measured token count).
  const brain = new Brain({ apiKey: 'sk-test', model: 'claude-sonnet-5', botName: 'Beacon', personality: '' });
  const words = brain.buildSystemPrompt().split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 850, `system prompt is ${words} words — likely below the cacheable minimum`);
});

test('stream context is baked into the system prompt when set', () => {
  const brain = new Brain({
    apiKey: 'sk-test',
    model: 'claude-sonnet-5',
    botName: 'Beacon',
    personality: 'chill',
    streamContext: 'variety streamer, mostly roguelikes',
  });
  assert.ok(brain.buildSystemPrompt().includes('variety streamer, mostly roguelikes'));
  const without = new Brain({ apiKey: 'sk-test', model: 'claude-sonnet-5', botName: 'Beacon', personality: 'chill' });
  assert.ok(!without.buildSystemPrompt().includes('About this stream'));
});
