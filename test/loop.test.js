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

// ---- voice replies only when the cast was actually addressed ----
//
// A streamer talks almost continuously — narrating, thinking out loud, talking
// to a co-op partner. Treating all of it as "they answered me" fires an extra
// generation after nearly every cast message, roughly doubling API spend on a
// chatty stream. Nothing is lost by skipping: undirected speech still reaches
// the cast through the transcript window on the next scheduled generation.

function makeVoiceLoop({ cadence = {}, lastMessage } = {}) {
  const spoken = [];
  const loop = new GhostLoop({
    config: { energy: 55, cadence, app: {}, memory: { enabled: false } },
    brain: { ready: () => true },
    obs: null,
    transcriptFeed: null,
    partyFeed: null,
    castNames: ['Beacon', 'Wisp'],
    hooks: {
      getMode: () => 'solo',
      getHistory: () => (lastMessage ? [lastMessage] : []),
      onMessage: () => {},
      onSystem: () => {},
      onState: () => {},
      getNotes: () => '',
      setNotes: () => {},
      addUsage: () => {},
    },
  });
  loop.speak = (trigger) => spoken.push(trigger);
  return { loop, spoken };
}

const botMsg = (text, agoMs = 1000) => ({ id: 'm1', role: 'bot', author: 'Beacon', text, ts: Date.now() - agoMs });

test('a ghost named out loud earns a voice reply', (t) => {
  const { loop } = makeVoiceLoop({ lastMessage: botMsg('what is that thing?') });
  loop.onSpeech('beacon i have literally no idea');
  assert.ok(loop.voiceReplyTimer, 'reply should be scheduled');
  clearTimeout(loop.voiceReplyTimer);
});

test('undirected narration does not', (t) => {
  const { loop } = makeVoiceLoop({ lastMessage: botMsg('nice, that looked rough.') });
  loop.onSpeech('okay so if i go left here i can probably grab the chest first');
  assert.equal(loop.voiceReplyTimer, null, 'no generation should be scheduled');
});

test('answering a question promptly counts as addressed; answering late does not', (t) => {
  const fresh = makeVoiceLoop({ lastMessage: botMsg('wait, is that the boss?', 5_000) });
  fresh.loop.onSpeech('yeah thats him');
  assert.ok(fresh.loop.voiceReplyTimer, 'a prompt answer is a reply');
  clearTimeout(fresh.loop.voiceReplyTimer);

  // The "curious" archetype ends a lot of messages with "?", so the window is
  // deliberately short — otherwise this rule matches nearly everything.
  const stale = makeVoiceLoop({ lastMessage: botMsg('wait, is that the boss?', 90_000) });
  stale.loop.onSpeech('yeah thats him');
  assert.equal(stale.loop.voiceReplyTimer, null, 'too late to be an answer');
});

test('a statement the cast made is not a question', (t) => {
  const { loop } = makeVoiceLoop({ lastMessage: botMsg('that was clean.') });
  loop.onSpeech('thanks, took me ages');
  assert.equal(loop.voiceReplyTimer, null);
});

test('name matching is whole-word and case-insensitive', (t) => {
  const hit = makeVoiceLoop({ lastMessage: botMsg('hi') });
  hit.loop.onSpeech('WISP what do you think');
  assert.ok(hit.loop.voiceReplyTimer);
  clearTimeout(hit.loop.voiceReplyTimer);

  const miss = makeVoiceLoop({ lastMessage: botMsg('hi') });
  miss.loop.onSpeech('the whole cave is wispy and weird');
  assert.equal(miss.loop.voiceReplyTimer, null, '"wispy" must not match "Wisp"');
});

test('the old always-reply behaviour is still reachable', (t) => {
  const { loop } = makeVoiceLoop({
    cadence: { voiceReplyRequiresAddress: false },
    lastMessage: botMsg('nice, that looked rough.'),
  });
  loop.onSpeech('okay so if i go left here');
  assert.ok(loop.voiceReplyTimer, 'opt-out restores the previous behaviour');
  clearTimeout(loop.voiceReplyTimer);
});

test('being addressed cannot bypass the rate floor or the staleness window', (t) => {
  const floored = makeVoiceLoop({ cadence: { minVoiceReplyGapSeconds: 600 }, lastMessage: botMsg('hi') });
  floored.loop.lastVoiceReplyAt = Date.now();
  floored.loop.onSpeech('beacon are you there');
  assert.equal(floored.loop.voiceReplyTimer, null, 'rate floor still wins');

  const stale = makeVoiceLoop({ lastMessage: botMsg('hi', 10 * 60_000) });
  stale.loop.onSpeech('beacon are you there');
  assert.equal(stale.loop.voiceReplyTimer, null, 'stale message still wins');
});
