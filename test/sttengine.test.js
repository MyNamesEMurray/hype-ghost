import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SttEngine, isLoopbackUrl, normalizeMessage, deriveConfidence } from '../src/sttengine.js';

/**
 * Stand-in for `ws`. Every instance registers itself so a test can drive the
 * socket's lifecycle by hand — no real sockets, no network, no real waiting.
 */
function makeFakeWs() {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.handlers = new Map();
      sockets.push(this);
    }
    on(event, fn) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    removeAllListeners() {
      this.handlers.clear();
    }
    send(frame) {
      if (this.closed) throw new Error('socket closed');
      this.sent.push(frame);
    }
    close() {
      this.closed = true;
    }
    fire(event, arg) {
      for (const fn of this.handlers.get(event) ?? []) fn(arg);
    }
  }
  return { FakeWebSocket, sockets };
}

function makeEngine(t, opts = {}) {
  const { FakeWebSocket, sockets } = makeFakeWs();
  const seen = [];
  const engine = new SttEngine({
    url: 'ws://127.0.0.1:9090/stt',
    onSegment: (seg) => seen.push(seg),
    WebSocketImpl: FakeWebSocket,
    backoffMs: 10,
    maxBackoffMs: 80,
    jitter: 0,
    ...opts,
  });
  t.after(() => engine.stop());
  return { engine, sockets, seen };
}

// ---- loopback enforcement ----

test('isLoopbackUrl accepts the three local spellings only', () => {
  assert.ok(isLoopbackUrl('ws://127.0.0.1:9090'));
  assert.ok(isLoopbackUrl('ws://localhost:9090/stream'));
  assert.ok(isLoopbackUrl('ws://LOCALHOST:9090'));
  assert.ok(isLoopbackUrl('ws://[::1]:9090'));
  assert.ok(isLoopbackUrl('wss://127.0.0.1:9090'));

  assert.equal(isLoopbackUrl('ws://192.168.1.50:9090'), false);
  assert.equal(isLoopbackUrl('ws://stt.example.com:9090'), false);
  assert.equal(isLoopbackUrl('ws://127.0.0.1.evil.com:9090'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1:9090'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
  assert.equal(isLoopbackUrl(''), false);
  assert.equal(isLoopbackUrl(undefined), false);
});

test('start() refuses a non-loopback URL and never dials', (t) => {
  const { engine, sockets } = makeEngine(t, { url: 'ws://10.0.0.5:9090' });
  engine.start();
  assert.equal(sockets.length, 0);
  assert.equal(engine.running, false);
  assert.equal(engine.status().connected, false);
});

// ---- payload shapes ----

test('normalizes a bare {text} object', () => {
  const [seg] = normalizeMessage(JSON.stringify({ text: '  we got the boss  ' }), 1000);
  assert.equal(seg.text, 'we got the boss');
  assert.equal(seg.final, true); // unmarked frames are treated as final
  assert.equal(seg.confidence, null);
  assert.equal(seg.ts, 1000);
});

test('normalizes a segments[] frame with whisper statistics', () => {
  const segs = normalizeMessage(
    JSON.stringify({
      segments: [
        { text: 'first line', avg_logprob: -0.2, no_speech_prob: 0.01 },
        { text: 'second line', words: [{ probability: 0.9 }, { probability: 0.7 }] },
      ],
    }),
  );
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, 'first line');
  assert.ok(Math.abs(segs[0].confidence - Math.exp(-0.2) * 0.99) < 1e-9);
  assert.equal(segs[1].text, 'second line');
  assert.ok(Math.abs(segs[1].confidence - 0.8) < 1e-9);
});

test('normalizes a bare string frame', () => {
  const [seg] = normalizeMessage('just talking here');
  assert.equal(seg.text, 'just talking here');
  assert.equal(seg.final, true);
  assert.equal(seg.confidence, null);
});

test('normalizes a Buffer frame', () => {
  const [seg] = normalizeMessage(Buffer.from(JSON.stringify({ text: 'from a buffer' })));
  assert.equal(seg.text, 'from a buffer');
});

test('malformed and oversized payloads are ignored, never thrown', () => {
  // Unparseable JSON falls back to plain text (some engines stream raw lines),
  // so it yields a segment rather than an exception.
  const fallback = normalizeMessage('{"text":', 5);
  assert.deepEqual(fallback, [{ text: '{"text":', confidence: null, final: true, ts: 5 }]);
  assert.deepEqual(normalizeMessage(''), []);
  assert.deepEqual(normalizeMessage('   '), []);
  assert.deepEqual(normalizeMessage(null), []);
  assert.deepEqual(normalizeMessage(42), []);
  assert.deepEqual(normalizeMessage(JSON.stringify({ text: null })), []);
  assert.deepEqual(normalizeMessage(JSON.stringify({ segments: 'not an array', foo: 1 })), []);
  // Oversized: both the whole frame and a single absurd "utterance".
  assert.deepEqual(normalizeMessage('x'.repeat(64 * 1024 + 1)), []);
  assert.deepEqual(normalizeMessage(Buffer.alloc(64 * 1024 + 1, 0x61)), []);
  assert.deepEqual(normalizeMessage(JSON.stringify({ text: 'y'.repeat(5000) })), []);
});

test('handleMessage swallows hostile frames and a throwing consumer', (t) => {
  const { engine, sockets } = makeEngine(t, {
    onSegment: () => {
      throw new Error('consumer exploded');
    },
  });
  engine.start();
  const sock = sockets[0];
  sock.fire('open');
  assert.doesNotThrow(() => sock.fire('message', JSON.stringify({ segments: {} })));
  assert.doesNotThrow(() => sock.fire('message', Buffer.alloc(0)));
  assert.doesNotThrow(() => sock.fire('message', 12345));
  assert.doesNotThrow(() => sock.fire('message', JSON.stringify({ text: 'boom' })));
  assert.equal(engine.status().emitted, 1);
});

test('caps the number of segments taken from one frame', () => {
  const segments = Array.from({ length: 100 }, (_, i) => ({ text: `line ${i}` }));
  assert.equal(normalizeMessage(JSON.stringify({ segments })).length, 32);
});

// ---- partials vs finals ----

test('partials are suppressed by default and finals emitted', (t) => {
  const { engine, sockets, seen } = makeEngine(t);
  engine.start();
  const sock = sockets[0];
  sock.fire('open');
  sock.fire('message', JSON.stringify({ text: 'i think', partial: true }));
  sock.fire('message', JSON.stringify({ text: 'i think we', type: 'interim' }));
  sock.fire('message', JSON.stringify({ text: 'i think we win', final: true }));
  assert.deepEqual(seen.map((s) => s.text), ['i think we win']);
  const status = engine.status();
  assert.equal(status.received, 3);
  assert.equal(status.emitted, 1);
  assert.equal(status.dropped, 0);
  assert.ok(status.lastSegmentAt > 0);
});

test('emitPartials opts into interim segments', (t) => {
  const { engine, sockets, seen } = makeEngine(t, { emitPartials: true });
  engine.start();
  sockets[0].fire('open');
  sockets[0].fire('message', JSON.stringify({ text: 'i think', partial: true }));
  assert.deepEqual(seen.map((s) => s.final), [false]);
});

test('a frame-level finality flag is inherited by its segments', () => {
  const segs = normalizeMessage(JSON.stringify({ partial: true, segments: [{ text: 'half a thought' }] }));
  assert.equal(segs[0].final, false);
});

// ---- confidence ----

test('deriveConfidence covers the whisper signals and returns null with none', () => {
  assert.equal(deriveConfidence({ text: 'x' }), null);
  assert.equal(deriveConfidence({ no_speech_prob: 0.25 }), 0.75);
  assert.ok(Math.abs(deriveConfidence({ avg_logprob: -1 }) - Math.exp(-1)) < 1e-9);
  assert.ok(Math.abs(deriveConfidence({ confidence: 0.6 }) - 0.6) < 1e-9);
  // words[] wins over avg_logprob, and no_speech_prob scales the result.
  assert.ok(Math.abs(deriveConfidence({ words: [{ probability: 0.8 }], avg_logprob: -3, no_speech_prob: 0.5 }) - 0.4) < 1e-9);
  // Out-of-range and non-numeric junk never escapes 0..1 or becomes NaN.
  assert.equal(deriveConfidence({ confidence: 5 }), 1);
  assert.equal(deriveConfidence({ confidence: 'high' }), null);
  assert.equal(deriveConfidence({ avg_logprob: NaN }), null);
  assert.equal(deriveConfidence(null), null);
});

test('finals below minConfidence are dropped and counted', (t) => {
  const { engine, sockets, seen } = makeEngine(t, { minConfidence: 0.5 });
  engine.start();
  const sock = sockets[0];
  sock.fire('open');
  sock.fire('message', JSON.stringify({ text: 'mumble', no_speech_prob: 0.9 })); // 0.1
  sock.fire('message', JSON.stringify({ text: 'clear speech', no_speech_prob: 0.05 })); // 0.95
  assert.deepEqual(seen.map((s) => s.text), ['clear speech']);
  assert.equal(engine.status().dropped, 1);
  assert.equal(engine.status().emitted, 1);
});

test('a null confidence is never dropped', (t) => {
  const { engine, sockets, seen } = makeEngine(t, { minConfidence: 0.9 });
  engine.start();
  sockets[0].fire('open');
  sockets[0].fire('message', JSON.stringify({ text: 'no stats at all' }));
  assert.deepEqual(seen.map((s) => s.text), ['no stats at all']);
  assert.equal(engine.status().dropped, 0);
});

// ---- initial prompt ----

test('sends the initial prompt on connect and updates it without reconnecting', (t) => {
  const { engine, sockets } = makeEngine(t, { initialPrompt: 'Wisp, Ember, Hollow Knight' });
  engine.start();
  const sock = sockets[0];
  sock.fire('open');
  assert.equal(sock.sent.length, 1);
  assert.equal(JSON.parse(sock.sent[0]).initial_prompt, 'Wisp, Ember, Hollow Knight');

  engine.setInitialPrompt('Wisp, Ember, Celeste');
  assert.equal(sock.sent.length, 2);
  assert.equal(JSON.parse(sock.sent[1]).initial_prompt, 'Wisp, Ember, Celeste');
  assert.equal(sockets.length, 1); // same connection — no reconnect

  engine.setInitialPrompt('Wisp, Ember, Celeste'); // unchanged: no traffic
  assert.equal(sock.sent.length, 2);
});

test('no prompt frame is sent when none is configured', (t) => {
  const { engine, sockets } = makeEngine(t);
  engine.start();
  sockets[0].fire('open');
  assert.equal(sockets[0].sent.length, 0);
});

// ---- reconnect backoff ----

test('backoff grows and caps', (t) => {
  const { engine } = makeEngine(t);
  engine.attempt = 1;
  assert.equal(engine.nextDelay(), 10);
  engine.attempt = 2;
  assert.equal(engine.nextDelay(), 20);
  engine.attempt = 3;
  assert.equal(engine.nextDelay(), 40);
  engine.attempt = 4;
  assert.equal(engine.nextDelay(), 80);
  engine.attempt = 20;
  assert.equal(engine.nextDelay(), 80); // capped, not astronomically large
});

test('jitter stays within the configured band', (t) => {
  const { engine } = makeEngine(t, { jitter: 0.25 });
  engine.attempt = 1;
  for (let i = 0; i < 50; i++) {
    const d = engine.nextDelay();
    assert.ok(d >= 10 && d <= 13, `delay ${d} out of band`);
  }
});

test('a closed socket schedules a reconnect that dials again', async (t) => {
  const { engine, sockets } = makeEngine(t);
  engine.start();
  sockets[0].fire('open');
  assert.equal(engine.status().connected, true);
  sockets[0].fire('close');
  assert.equal(engine.status().connected, false);
  assert.ok(engine.timer, 'reconnect timer scheduled');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sockets.length, 2, 'reconnected on a fresh socket');
});

test('a connect that fails outright backs off instead of spinning', async (t) => {
  let dials = 0;
  class ThrowingWs {
    constructor() {
      dials++;
      throw new Error('ECONNREFUSED');
    }
  }
  const engine = new SttEngine({
    url: 'ws://127.0.0.1:9091',
    WebSocketImpl: ThrowingWs,
    backoffMs: 10,
    maxBackoffMs: 20,
    jitter: 0,
  });
  t.after(() => engine.stop());
  engine.start();
  assert.equal(dials, 1);
  await new Promise((r) => setTimeout(r, 60));
  // Retried, but a handful of times — not once per event-loop turn.
  assert.ok(dials > 1 && dials < 8, `dialled ${dials} times`);
});

// ---- lifecycle ----

test('start() is idempotent', (t) => {
  const { engine, sockets } = makeEngine(t);
  engine.start();
  engine.start();
  assert.equal(sockets.length, 1);
});

test('stop() clears timers, closes the socket and is safe twice', async (t) => {
  const { engine, sockets } = makeEngine(t);
  const statuses = [];
  engine.onStatus = (s) => statuses.push(s.connected);
  engine.start();
  sockets[0].fire('open');
  sockets[0].fire('close'); // arms the reconnect timer
  assert.ok(engine.timer);

  engine.stop();
  assert.equal(engine.timer, null);
  assert.equal(engine.running, false);
  engine.stop(); // no throw, still clean
  assert.equal(engine.timer, null);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sockets.length, 1, 'no reconnect after stop()');
  assert.deepEqual(statuses, [true, false]);
});

test('stop() closes a live socket and detaches its handlers', (t) => {
  const { engine, sockets } = makeEngine(t);
  engine.start();
  const sock = sockets[0];
  sock.fire('open');
  engine.stop();
  assert.equal(sock.closed, true);
  sock.fire('close'); // detached — must not resurrect the reconnect loop
  assert.equal(engine.timer, null);
  assert.equal(sockets.length, 1);
});
