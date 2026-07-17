import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GhostLoop } from '../src/loop.js';

// The real example config doubles as the test fixture — if a key the loop
// relies on ever goes missing from config.example.json, these tests notice.
const defaults = () => JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));

function makeLoop({ config = defaults(), brain, obs, history = [], mode = 'solo' } = {}) {
  const calls = { messages: [], system: [], usage: [], notes: [] };
  const loop = new GhostLoop({
    config,
    brain:
      brain ??
      { generate: async () => ({ text: 'hey', notes: null, usage: { input_tokens: 10, output_tokens: 5 } }) },
    obs:
      obs ??
      {
        getSceneName: async () => 'Game',
        screenshot: async () => ({ data: 'x', mediaType: 'image/jpeg', sceneName: 'Game' }),
        ensureConnected: async () => {},
      },
    transcriptFeed: { getWindow: () => '' },
    hooks: {
      getMode: () => mode,
      getHistory: () => history,
      onMessage: (t) => calls.messages.push(t),
      onSystem: (t) => calls.system.push(t),
      onState: () => {},
      getNotes: () => '',
      setNotes: (n) => calls.notes.push(n),
      addUsage: (u) => calls.usage.push(u),
    },
  });
  return { loop, calls };
}

test('intervalMs stays in the burst band when burstChance is 1', () => {
  const config = defaults();
  Object.assign(config.cadence, { soloSeconds: 120, burstChance: 1, lullChance: 0, jitter: 0 });
  const { loop } = makeLoop({ config });
  for (let i = 0; i < 200; i++) {
    const ms = loop.intervalMs();
    assert.ok(ms >= 120 * 0.3 * 1000 && ms <= 120 * 0.6 * 1000, `burst interval out of band: ${ms}`);
  }
});

test('intervalMs stays in the lull band when lullChance is 1', () => {
  const config = defaults();
  Object.assign(config.cadence, { soloSeconds: 120, burstChance: 0, lullChance: 1, jitter: 0 });
  const { loop } = makeLoop({ config });
  for (let i = 0; i < 200; i++) {
    const ms = loop.intervalMs();
    assert.ok(ms >= 120 * 1.6 * 1000 && ms <= 120 * 3 * 1000, `lull interval out of band: ${ms}`);
  }
});

test('intervalMs jitters around base with no burst/lull, and uses quietSeconds in viewers mode', () => {
  const config = defaults();
  Object.assign(config.cadence, { soloSeconds: 100, quietSeconds: 400, burstChance: 0, lullChance: 0, jitter: 0.35 });
  const solo = makeLoop({ config }).loop;
  for (let i = 0; i < 200; i++) {
    const ms = solo.intervalMs();
    assert.ok(ms >= 100 * 0.65 * 1000 && ms <= 100 * 1.35 * 1000, `normal interval out of band: ${ms}`);
  }
  const viewers = makeLoop({ config, mode: 'viewers' }).loop;
  for (let i = 0; i < 50; i++) {
    assert.ok(viewers.intervalMs() >= 400 * 0.65 * 1000);
  }
});

test('intervalMs never drops below the 15s floor', () => {
  const config = defaults();
  Object.assign(config.cadence, { soloSeconds: 20, burstChance: 1, lullChance: 0, jitter: 0 });
  const { loop } = makeLoop({ config });
  for (let i = 0; i < 200; i++) {
    assert.ok(loop.intervalMs() >= 15_000);
  }
});

test('speak delivers a message, forwards usage, and resets the failure streak', async (t) => {
  const { loop, calls } = makeLoop();
  t.after(() => loop.pause());
  loop.failStreak = 3;
  await loop.speak('timer');
  assert.deepEqual(calls.messages, ['hey']);
  assert.equal(calls.usage.length, 1);
  assert.equal(loop.failStreak, 0);
  assert.equal(loop.busy, false);
});

test('circuit breaker: 5 consecutive failures auto-pause with reason "api"', async (t) => {
  let attempts = 0;
  const brain = {
    generate: async () => {
      attempts++;
      throw new Error('boom');
    },
  };
  const { loop, calls } = makeLoop({ brain });
  t.after(() => loop.pause());
  for (let i = 0; i < 5; i++) await loop.speak('timer');
  assert.equal(attempts, 5);
  assert.equal(loop.paused, true);
  assert.equal(loop.autoPaused, true);
  assert.equal(loop.pauseReason, 'api');
  assert.ok(calls.system.at(-1).includes('paused itself'));
  // Further speaks are no-ops while paused.
  await loop.speak('timer');
  assert.equal(attempts, 5);
  // A manual resume clears the streak for a fresh chance.
  loop.resume();
  assert.equal(loop.failStreak, 0);
  assert.equal(loop.pauseReason, null);
});

test('a success between failures resets the streak (no false trip)', async (t) => {
  let fail = true;
  const brain = {
    generate: async () => {
      if (fail) throw new Error('boom');
      return { text: 'ok', notes: null, usage: null };
    },
  };
  const { loop } = makeLoop({ brain });
  t.after(() => loop.pause());
  for (let i = 0; i < 4; i++) await loop.speak('timer');
  assert.equal(loop.failStreak, 4);
  fail = false;
  await loop.speak('timer');
  assert.equal(loop.failStreak, 0);
  assert.equal(loop.paused, false);
});

test('idle scenes (BRB / starting soon) skip the screenshot entirely', async (t) => {
  let seen = null;
  const brain = { generate: async (opts) => ((seen = opts), { text: 'hi', notes: null, usage: null }) };
  const obs = {
    getSceneName: async () => 'BRB - be right back',
    screenshot: async () => {
      throw new Error('should not be called for an idle scene');
    },
    ensureConnected: async () => {},
  };
  const { loop } = makeLoop({ brain, obs });
  t.after(() => loop.pause());
  await loop.speak('timer');
  assert.equal(seen.screenshot, null);
  assert.equal(seen.idleScene, true);
  assert.equal(seen.sceneName, 'BRB - be right back');
});

test('a normal scene name does not trip the idle heuristic', async (t) => {
  let seen = null;
  const brain = { generate: async (opts) => ((seen = opts), { text: 'hi', notes: null, usage: null }) };
  const obs = {
    getSceneName: async () => 'Breakout speedrun - no pause',
    screenshot: async () => ({ data: 'x', mediaType: 'image/jpeg' }),
    ensureConnected: async () => {},
  };
  const { loop } = makeLoop({ brain, obs });
  t.after(() => loop.pause());
  await loop.speak('timer');
  assert.equal(seen.idleScene, false);
  assert.ok(seen.screenshot);
});

test('OBS unreachable starts the fail clock but still generates text-only', async (t) => {
  let seen = null;
  const brain = { generate: async (opts) => ((seen = opts), { text: 'hi', notes: null, usage: null }) };
  const obs = { getSceneName: async () => null, screenshot: async () => null, ensureConnected: async () => {} };
  const { loop, calls } = makeLoop({ brain, obs });
  t.after(() => loop.pause());
  await loop.speak('timer');
  assert.ok(loop.obsFailSince !== null);
  assert.equal(seen.screenshot, null);
  assert.equal(seen.idleScene, false);
  assert.deepEqual(calls.messages, ['hi']);
});

test('dead-man switch pauses with reason "obs" once the limit is exceeded', (t) => {
  const { loop, calls } = makeLoop();
  t.after(() => {
    loop.stopResumeWatcher();
    loop.pause();
  });
  loop.obsFailSince = Date.now() - 11 * 60_000; // limit is 10 minutes
  assert.equal(loop.maybeAutoPause(), true);
  assert.equal(loop.paused, true);
  assert.equal(loop.pauseReason, 'obs');
  assert.ok(calls.system[0].includes('auto-paused'));
  assert.ok(loop.resumeWatcher);
});

test('fireVoiceReply re-validates the history tail before speaking', () => {
  const history = [];
  const { loop } = makeLoop({ history });
  const spoken = [];
  loop.speak = (trigger) => spoken.push(trigger);

  // Streamer typed during the debounce window — the voice path stands down.
  history.push({ id: 's1', role: 'streamer', ts: Date.now(), text: 'typed' });
  loop.fireVoiceReply();
  assert.deepEqual(spoken, []);
  assert.equal(loop.voiceRepliedTo, null);

  // Bot message on the tail — voice reply fires and marks it answered.
  history.push({ id: 'b1', role: 'bot', ts: Date.now(), text: 'question?' });
  loop.fireVoiceReply();
  assert.deepEqual(spoken, ['voice']);
  assert.equal(loop.voiceRepliedTo, 'b1');

  // Same message never gets a second voice reply.
  loop.fireVoiceReply();
  assert.deepEqual(spoken, ['voice']);
});

test('onStreamerMessage schedules a reply trigger at the configured delay', (t) => {
  const { loop } = makeLoop();
  t.after(() => loop.pause());
  const before = Date.now();
  loop.onStreamerMessage();
  assert.equal(loop.pendingTrigger, 'reply');
  const delay = loop.nextMessageAt - before;
  assert.ok(delay >= 5500 && delay <= 6500, `reply delay off: ${delay}`); // default 6s
});

test('pauseFor / resume round-trip and snapshot shape', (t) => {
  const { loop, calls } = makeLoop();
  t.after(() => loop.pause());
  loop.pauseFor('cost', 'cap hit');
  assert.deepEqual(loop.snapshot(), {
    paused: true,
    autoPaused: true,
    pauseReason: 'cost',
    busy: false,
    nextMessageAt: null,
  });
  assert.deepEqual(calls.system, ['cap hit']);
  loop.resume();
  assert.equal(loop.paused, false);
  assert.equal(loop.autoPaused, false);
  assert.equal(loop.pauseReason, null);
});
