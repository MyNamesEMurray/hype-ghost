import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';

const PERSONAS = [
  { name: 'Beacon', personality: 'curious and goofy' },
  { name: 'Wisp', personality: 'dry one-liners' },
];

function makeBrain(raw, opts = {}) {
  const brain = new Brain({
    brain: { provider: 'anthropic' },
    anthropic: { apiKey: 'sk-test', model: 'claude-sonnet-5' },
    personas: PERSONAS,
    language: 'English',
    ...opts,
  });
  // Stub the transport: everything under test is prompt assembly and parsing.
  const calls = [];
  brain.callAnthropic = async (blocks, maxTokens, systemParts) => {
    calls.push({ blocks, maxTokens, systemParts });
    return { raw, usage: { input_tokens: 1, output_tokens: 1 } };
  };
  return { brain, calls };
}

const baseArgs = { history: [], energy: 55, mode: 'solo', trigger: 'timer' };

// Stubs one layer lower — the SDK client itself — so the real callAnthropic
// runs and the outgoing request body can be asserted.
function makeWiredBrain(model) {
  const brain = new Brain({
    brain: { provider: 'anthropic' },
    anthropic: { apiKey: 'sk-test', model },
    personas: PERSONAS,
    language: 'English',
  });
  const sent = [];
  brain.client = {
    messages: {
      create: async (params) => {
        sent.push(params);
        return { content: [{ type: 'text', text: 'Beacon: hi' }], usage: {} };
      },
    },
  };
  return { brain, sent };
}

test('parses NAME: lines and every piggybacked tail section', async () => {
  const { brain } = makeBrain(
    [
      'Beacon: oh no that was close',
      'Wisp: skill issue tbh',
      '---NOTES---',
      'Playing Hollow Knight, stuck on Hornet.',
      '---PROFILE---',
      'Hollow Knight: reached Hornet.',
      '---GAMEINFO---',
      'Health is the mask row top-left. Death shows a grey "you died" wash.',
      '---MOMENT---',
      'clutch Hornet dodge',
    ].join('\n')
  );
  const out = await brain.generate({ ...baseArgs, updateNotes: true, updateProfile: true, updateGameInfo: true, flagMoments: true });

  assert.deepEqual(out.messages, [
    { speaker: 'Beacon', text: 'oh no that was close' },
    { speaker: 'Wisp', text: 'skill issue tbh' },
  ]);
  assert.match(out.notes, /stuck on Hornet/);
  assert.match(out.profile, /reached Hornet/);
  assert.match(out.gameInfo, /mask row top-left/);
  assert.equal(out.moment, 'clutch Hornet dodge');
  // Tail sections must not leak into the chat messages.
  assert.ok(!out.messages.some((m) => /GAMEINFO|NOTES/.test(m.text)));
});

test('gameInfo is null when the model does not emit the section', async () => {
  const { brain } = makeBrain('Beacon: hi chat');
  const out = await brain.generate({ ...baseArgs });
  assert.equal(out.gameInfo, null);
});

test('the screen guide rides the cached context block, not the per-message turn', async () => {
  const { brain, calls } = makeBrain('Beacon: hi', {});
  await brain.generate({
    ...baseArgs,
    gameInfo: 'Health is the mask row top-left.',
    streamInfo: { game: 'Hollow Knight' },
  });
  const [{ systemParts, blocks }] = calls;
  // Second system part = the slow-moving context block, its own cache breakpoint.
  assert.equal(systemParts.length, 2);
  assert.match(systemParts[1], /mask row top-left/);
  assert.match(systemParts[1], /Hollow Knight/);
  // …and not repeated in the volatile user turn, which would defeat the point.
  assert.ok(!blocks.some((b) => b.text && b.text.includes('mask row top-left')));
});

test('the guide is only requested on the update cadence, and budgeted for', async () => {
  const { brain, calls } = makeBrain('Beacon: hi');
  await brain.generate({ ...baseArgs, streamInfo: { game: 'Hades' } });
  await brain.generate({ ...baseArgs, streamInfo: { game: 'Hades' }, updateGameInfo: true });

  const askedOff = calls[0].blocks.some((b) => b.text && b.text.includes('---GAMEINFO---'));
  const askedOn = calls[1].blocks.some((b) => b.text && b.text.includes('---GAMEINFO---'));
  assert.equal(askedOff, false);
  assert.equal(askedOn, true);
  assert.ok(calls[1].maxTokens > calls[0].maxTokens, 'needs output budget for the guide');
  assert.match(calls[1].blocks.at(-1).text, /Hades/);
});

test('context block is null when there is nothing slow-moving to cache', async () => {
  const { brain } = makeBrain('Beacon: hi');
  assert.equal(brain.buildContextBlock({}), null);
  assert.match(brain.buildContextBlock({ gameInfo: 'HUD notes' }), /HUD notes/);
});

// The transcript is ASR output; naming the proper nouns lets the model recover
// a near-miss instead of reacting to nonsense.
test('vocabulary terms are named in the byte-stable system prompt', () => {
  const { brain } = makeBrain('', { vocabulary: ['Beacon', 'emurray', 'Hollow Knight'] });
  const prompt = brain.buildSystemPrompt();
  assert.match(prompt, /Beacon, emurray, Hollow Knight/);
  const { brain: bare } = makeBrain('');
  assert.ok(!/near-miss/.test(bare.buildSystemPrompt()));
});

// Thinking shares max_tokens with the visible text on current-generation
// models, so a budget sized for a one-line message truncates it away.
test('every generation reserves output budget for thinking', async () => {
  const { brain, sent } = makeWiredBrain('claude-sonnet-5');
  await brain.generate({ ...baseArgs });
  assert.ok(sent[0].max_tokens >= 600, `plain message budget too tight: ${sent[0].max_tokens}`);
  await brain.generate({ ...baseArgs, updateNotes: true, updateProfile: true, updateGameInfo: true, streamInfo: { game: 'Hades' } });
  assert.ok(sent[1].max_tokens > sent[0].max_tokens, 'tail sections still add their own room');
});

// effort is GA on the 5-series but errors on Haiku 4.5, so it can only go to
// models known to accept it — and never to a custom id we know nothing about.
test('effort is capped only for models that accept the parameter', async () => {
  for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8']) {
    const { brain, sent } = makeWiredBrain(model);
    await brain.generate({ ...baseArgs });
    assert.deepEqual(sent[0].output_config, { effort: 'low' }, model);
  }
  for (const model of ['claude-haiku-4-5', 'claude-some-future-model', 'my-local-thing']) {
    const { brain, sent } = makeWiredBrain(model);
    await brain.generate({ ...baseArgs });
    assert.equal('output_config' in sent[0], false, `${model} must not receive output_config`);
  }
});

// Removed on the current generation: sending either is a 400 on every call.
test('no sampling or explicit thinking parameters are ever sent', async () => {
  const { brain, sent } = makeWiredBrain('claude-opus-5');
  await brain.generate({ ...baseArgs });
  for (const banned of ['temperature', 'top_p', 'top_k', 'thinking']) {
    assert.equal(banned in sent[0], false, `${banned} must not be sent`);
  }
});

// The 1h TTL is what makes caching pay off at this app's 8-minute cadence.
test('both cache breakpoints carry the 1h TTL', async () => {
  const { brain, sent } = makeWiredBrain('claude-sonnet-5');
  await brain.generate({ ...baseArgs, streamContext: 'variety streamer' });
  assert.equal(sent[0].system.length, 2);
  for (const part of sent[0].system) {
    assert.deepEqual(part.cache_control, { type: 'ephemeral', ttl: '1h' });
  }
});
