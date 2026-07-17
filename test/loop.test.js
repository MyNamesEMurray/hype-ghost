import test from 'node:test';
import assert from 'node:assert/strict';
import { GhostLoop } from '../src/loop.js';

// Preview mode: the setup wizard can be finished without a brain (no API key /
// no local model). The loop must stay quiet — no scheduled generations, no API
// errors — and explain what's missing when the user pokes it.

function makeLoop({ ready }) {
  const events = { system: [], state: 0 };
  const loop = new GhostLoop({
    config: { energy: 55, cadence: {}, app: {}, memory: { enabled: false } },
    brain: { ready: () => ready },
    obs: null,
    transcriptFeed: null,
    partyFeed: null,
    hooks: {
      getMode: () => 'solo',
      getHistory: () => [],
      onMessage: () => {},
      onSystem: (text) => events.system.push(text),
      onState: () => events.state++,
      getNotes: () => '',
      setNotes: () => {},
      addUsage: () => {},
    },
  });
  return { loop, events };
}

test('preview mode: start() stays paused without a brain', () => {
  const { loop, events } = makeLoop({ ready: false });
  loop.start();
  assert.equal(loop.isPaused(), true);
  assert.equal(loop.nextMessageAt, null);
  assert.ok(events.state >= 1, 'hosts must be told so the UI shows paused');
});

test('preview mode: resume, nudge, and typed messages hint instead of scheduling', () => {
  const { loop, events } = makeLoop({ ready: false });
  loop.start();
  loop.resume();
  assert.equal(loop.isPaused(), true, 'resume must not unpause in preview mode');
  loop.nudge();
  loop.onStreamerMessage();
  assert.equal(events.system.length, 3, 'each poke gets a hint');
  assert.match(events.system[0], /Settings/);
  assert.equal(loop.nextMessageAt, null, 'nothing may ever be scheduled');
});

test('with a brain, start() schedules the first message normally', () => {
  const { loop } = makeLoop({ ready: true });
  loop.start();
  assert.equal(loop.isPaused(), false);
  assert.ok(loop.nextMessageAt > Date.now());
  loop.pause(); // clears the pending timer so the test runner can exit
});
