/**
 * Client for a *local* speech-to-text engine server.
 *
 * The file/textSource transcript modes read whatever a third-party OBS plugin
 * decided to write: no voice-activity gating, no way to bias the decoder
 * toward this install's proper nouns, and no confidence signal at all — a
 * garbage line and a perfect line look identical by the time we see them.
 *
 * A streamer-run STT server (whisper.cpp's `server`, faster-whisper-server,
 * WhisperLive, …) gives us all three. They don't share one protocol, but the
 * WebSocket dialects they do speak all boil down to "JSON frames carrying
 * transcript text plus whisper's own per-segment statistics," so this client
 * accepts the handful of shapes seen in the wild and normalizes them into one.
 *
 * Two rules shape everything here:
 *
 * 1. **Loopback only.** The audio-never-leaves-your-PC promise is a product
 *    claim, and the server's whole security posture is 127.0.0.1. A remote
 *    engine URL is a bug, not a feature, so it is refused rather than dialed.
 * 2. **The peer is untrusted.** It is a separate process the streamer
 *    installed, possibly mid-crash, possibly a different tool than we think.
 *    Nothing it sends may throw out of the message handler, and nothing it
 *    claims about its own size may be believed.
 *
 * This module is only the client. It has no config keys, no transcript
 * window, and no speech-quality filtering — the caller wires it into
 * TranscriptFeed and keeps those concerns where they already live.
 */

const MAX_MESSAGE_BYTES = 64 * 1024; // one JSON frame of transcript, generously
const MAX_TEXT_CHARS = 2000; // one utterance; anything longer is not a segment
const MAX_SEGMENTS = 32; // per frame — a batch, not a whole session replay

const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_JITTER = 0.25;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * True only for a ws:// or wss:// URL pointing at this machine. Hostnames are
 * not resolved: a name that merely *maps* to 127.0.0.1 today can be repointed
 * by DNS tomorrow, which is the same rebinding trap the HTTP server's Host
 * check exists to close. Only the three literal spellings are accepted.
 * IPv4-mapped forms (127.0.0.2, 127.x.x.x) are refused too — the engine is
 * expected on the loopback address the rest of the app uses, and a wider
 * allowlist buys nothing but ways to be wrong.
 */
export function isLoopbackUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/** Clamp to 0..1, or null when the value isn't a usable number. */
function unit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/**
 * Turn whisper's statistics into one 0..1 confidence, or null when the engine
 * told us nothing to derive it from.
 *
 * - `words[].probability` is the most direct signal (per-token probability);
 *   averaged when present.
 * - `avg_logprob` is the mean log-probability of the segment's tokens, so
 *   exp() of it is the geometric-mean token probability. Typical good speech
 *   sits around -0.2 (~0.82); garbage runs below -1.0 (~0.37).
 * - `no_speech_prob` is whisper's own "this was silence" estimate, and is the
 *   signal that catches hallucinated text with a *high* token probability.
 *   It scales whatever the above produced, or stands alone if it's all we got.
 * - A plain `confidence`/`probability` field (non-whisper engines) is taken
 *   at face value.
 */
export function deriveConfidence(seg) {
  if (!seg || typeof seg !== 'object') return null;

  let base = null;
  const words = Array.isArray(seg.words) ? seg.words.slice(0, 512) : null;
  if (words && words.length) {
    let sum = 0;
    let n = 0;
    for (const w of words) {
      const p = unit(w?.probability ?? w?.confidence);
      if (p !== null) { sum += p; n++; }
    }
    if (n) base = sum / n;
  }
  if (base === null && typeof seg.avg_logprob === 'number' && Number.isFinite(seg.avg_logprob)) {
    base = Math.min(1, Math.exp(seg.avg_logprob));
  }
  if (base === null) base = unit(seg.confidence ?? seg.probability);

  const noSpeech = unit(seg.no_speech_prob);
  if (noSpeech !== null) return base === null ? 1 - noSpeech : base * (1 - noSpeech);
  return base;
}

/**
 * Explicit finality signal, or undefined when the payload carries none.
 * Kept separate from the default so a segment can inherit the frame's flag.
 */
function finalityOf(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (typeof obj.final === 'boolean') return obj.final;
  if (typeof obj.is_final === 'boolean') return obj.is_final;
  if (typeof obj.partial === 'boolean') return !obj.partial;
  if (typeof obj.is_partial === 'boolean') return !obj.is_partial;
  const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : null;
  if (type === 'partial' || type === 'interim' || type === 'temporary') return false;
  if (type === 'final' || type === 'transcript' || type === 'transcription' || type === 'segment') return true;
  return undefined;
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  if (value.length > MAX_TEXT_CHARS) return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize one raw frame into `[{ text, confidence, final, ts }]`.
 *
 * Accepted shapes, all seen among the common local engines:
 *   - a bare string of text (or a JSON string)
 *   - `{ text, ... }` with optional whisper stats / finality flags
 *   - `{ segments: [{ text, no_speech_prob, avg_logprob, words: [...] }] }`
 *
 * Anything else — malformed JSON, an oversized frame, a shape we don't know —
 * yields `[]`. Never throws: the peer is a third-party process.
 */
export function normalizeMessage(raw, now = Date.now()) {
  let text = null;
  if (typeof raw === 'string') text = raw;
  else if (raw && typeof raw.byteLength === 'number') {
    // Check the declared size before materializing the string, so a hostile
    // frame can't cost us memory just by being read.
    if (raw.byteLength > MAX_MESSAGE_BYTES) return [];
    try {
      text = Buffer.from(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength).toString('utf8');
    } catch {
      return [];
    }
  } else return [];

  if (text.length > MAX_MESSAGE_BYTES) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    payload = trimmed; // engines that stream plain text lines
  }

  const out = [];
  const push = (seg, inherited) => {
    const body = cleanText(seg?.text ?? seg?.transcript ?? (typeof seg === 'string' ? seg : ''));
    if (!body) return;
    const final = finalityOf(seg) ?? inherited ?? true;
    const confidence = typeof seg === 'string' ? null : deriveConfidence(seg);
    out.push({ text: body, confidence, final, ts: now });
  };

  if (typeof payload === 'string') {
    push(payload, undefined);
  } else if (Array.isArray(payload)) {
    for (const seg of payload.slice(0, MAX_SEGMENTS)) push(seg, undefined);
  } else if (payload && typeof payload === 'object') {
    const frameFinal = finalityOf(payload);
    if (Array.isArray(payload.segments)) {
      for (const seg of payload.segments.slice(0, MAX_SEGMENTS)) push(seg, frameFinal);
    } else {
      push(payload, frameFinal);
    }
  }
  return out;
}

/**
 * Streams transcript segments from a local STT server over WebSocket.
 *
 * Lifecycle is `start()` / `stop()`, both idempotent, and `stop()` leaves no
 * timer behind — the host server is long-lived and hot-reloads config, so a
 * leaked reconnect timer would outlive the feed that owns it.
 */
export class SttEngine {
  constructor({
    url,
    initialPrompt = '',
    minConfidence = 0,
    emitPartials = false,
    onSegment,
    onStatus,
    WebSocketImpl,
    backoffMs = DEFAULT_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    jitter = DEFAULT_JITTER,
  } = {}) {
    this.url = String(url ?? '');
    this.initialPrompt = String(initialPrompt ?? '');
    this.minConfidence = Number.isFinite(minConfidence) ? Math.min(1, Math.max(0, minConfidence)) : 0;
    this.emitPartials = !!emitPartials;
    this.onSegment = onSegment || (() => {});
    this.onStatus = onStatus || (() => {});
    this.WebSocketImpl = WebSocketImpl;

    this.backoffMs = backoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.jitter = jitter;

    this.running = false;
    this.connected = false;
    this.socket = null;
    this.timer = null;
    this.attempt = 0;
    // A local engine that isn't running is the normal case (the streamer
    // hasn't launched it yet). Log the first failure, then stay quiet until
    // the state actually changes — no CPU spin, no log spam over hours.
    this.loggedFailure = false;

    this.received = 0;
    this.emitted = 0;
    this.dropped = 0; // finals below minConfidence
    this.lastSegmentAt = null;
  }

  /** Small serializable snapshot for the deck/settings UI. */
  status() {
    return {
      connected: this.connected,
      url: this.url,
      lastSegmentAt: this.lastSegmentAt,
      received: this.received,
      emitted: this.emitted,
      dropped: this.dropped,
    };
  }

  start() {
    if (this.running) return;
    if (!isLoopbackUrl(this.url)) {
      console.warn(
        `[stt] refusing non-loopback engine URL: ${this.url || '(empty)'} — ` +
          'the speech engine must run on this machine (127.0.0.1, localhost or [::1]).',
      );
      return;
    }
    if (typeof this.WebSocketImpl !== 'function') {
      console.warn('[stt] no WebSocket implementation available; engine mode disabled.');
      return;
    }
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      // Detach first: the close we're about to request would otherwise run
      // handleClose and schedule a reconnect for a feed that's shutting down.
      try { sock.removeAllListeners?.(); } catch {}
      try { sock.close(); } catch {}
    }
    if (this.connected) {
      this.connected = false;
      this.emitStatus();
    }
  }

  emitStatus() {
    try {
      this.onStatus(this.status());
    } catch {
      // A throwing status consumer must not take the socket down with it.
    }
  }

  /**
   * Capped exponential backoff with jitter, the same shape src/obs.js uses for
   * an OBS that isn't up: retry soon at first (the engine may just be booting),
   * then settle into a slow poll. Jitter keeps a restarting engine from being
   * hit by every reconnect at the same instant.
   */
  nextDelay() {
    const exp = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** Math.max(0, this.attempt - 1));
    return Math.round(exp * (1 + Math.random() * this.jitter));
  }

  scheduleReconnect() {
    if (!this.running || this.timer) return;
    const delay = this.nextDelay();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    // Never hold the process open for a retry — the host decides its lifetime.
    this.timer.unref?.();
    return delay;
  }

  connect() {
    if (!this.running || this.socket) return;
    this.attempt++;
    let sock;
    try {
      sock = new this.WebSocketImpl(this.url);
    } catch (err) {
      this.noteFailure(err);
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    sock.on('open', () => this.handleOpen(sock));
    sock.on('message', (data) => this.handleMessage(data));
    sock.on('error', (err) => this.noteFailure(err));
    sock.on('close', () => this.handleClose(sock));
  }

  handleOpen(sock) {
    if (sock !== this.socket) return;
    this.connected = true;
    this.attempt = 0;
    // The state changed, so the log is allowed to speak again — and the next
    // outage gets exactly one warning of its own.
    this.loggedFailure = false;
    console.log(`[stt] speech engine connected: ${this.url}`);
    this.sendPrompt();
    this.emitStatus();
  }

  handleClose(sock) {
    if (sock !== this.socket) return;
    this.socket = null;
    if (this.connected) {
      this.connected = false;
      this.emitStatus();
    }
    this.scheduleReconnect();
  }

  noteFailure(err) {
    if (this.loggedFailure) return;
    this.loggedFailure = true;
    const why = err?.message || String(err ?? 'unreachable');
    console.warn(`[stt] speech engine not reachable at ${this.url} (${why}) — retrying quietly.`);
  }

  /**
   * The decoder-biasing hook: whisper takes an `initial_prompt` of context
   * words (ghost names, the game, the channel) and becomes far likelier to
   * transcribe them correctly. Sent on connect and on every live update; the
   * key is spelled several ways across engines, and one extra unknown field
   * is cheaper than guessing wrong.
   */
  sendPrompt() {
    if (!this.connected || !this.socket || !this.initialPrompt) return;
    const frame = JSON.stringify({
      type: 'config',
      initial_prompt: this.initialPrompt,
      initialPrompt: this.initialPrompt,
      prompt: this.initialPrompt,
    });
    try {
      this.socket.send(frame);
    } catch {
      // Engines that don't accept configuration frames simply ignore or reject
      // this; a rejected prompt must not break the transcript stream.
    }
  }

  /**
   * Update the bias prompt live (the game changed, the cast changed).
   *
   * Chosen behaviour: send the new prompt over the *existing* connection and
   * never reconnect. Engines that don't understand the frame keep decoding
   * with the old prompt, which is a slightly worse transcript; reconnecting
   * would instead drop audio mid-sentence and, on a rate-limited engine,
   * restart the model — a much worse failure for a purely cosmetic gain.
   */
  setInitialPrompt(text) {
    const next = String(text ?? '');
    if (next === this.initialPrompt) return;
    this.initialPrompt = next;
    this.sendPrompt();
  }

  /**
   * Frames arrive from a third-party process, so this must never throw: an
   * exception here escapes into the ws library's emit and takes the server
   * with it.
   */
  handleMessage(data) {
    try {
      const segments = normalizeMessage(data);
      for (const seg of segments) {
        this.received++;
        // A partial is rewritten a moment later; forwarding it would reach the
        // cast as a stutter ("i think—" then "i think we win"). Finals only.
        if (!seg.final && !this.emitPartials) continue;
        // Unknown is not the same as bad: an engine that reports no statistics
        // would otherwise be silenced entirely by a non-zero threshold.
        if (seg.final && seg.confidence !== null && this.minConfidence > 0 && seg.confidence < this.minConfidence) {
          this.dropped++;
          continue;
        }
        this.emitted++;
        this.lastSegmentAt = seg.ts;
        try {
          this.onSegment(seg);
        } catch (err) {
          console.warn(`[stt] segment handler threw: ${err?.message || err}`);
        }
      }
    } catch (err) {
      console.warn(`[stt] unreadable frame from speech engine: ${err?.message || err}`);
    }
  }
}
