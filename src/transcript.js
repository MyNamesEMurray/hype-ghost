import { openSync, readSync, fstatSync, closeSync, existsSync, statSync } from 'node:fs';
import { isHallucination, compileCorrections, applyCorrections } from './speech.js';

/**
 * LocalVocal can write plain text or SRT subtitles. In SRT, only every third
 * line is speech — the rest are sequence numbers and timing lines like
 * "00:01:20,320 --> 00:01:21,347" (measured in stream uptime, which we
 * ignore: entries are stamped with arrival wall-clock time instead).
 */
function isSrtMetadata(line) {
  const t = line.trim();
  return /^\d+$/.test(t) || /^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(t);
}

const HEAD_LEN = 64; // bytes compared to detect a rewritten (truncate-mode) file
const MAX_CHUNK = 256 * 1024; // safety cap on a single delta read

/**
 * Ingests the streamer's mic transcription produced by the LocalVocal OBS
 * plugin (local whisper.cpp inside OBS), and keeps a rolling window of what
 * was said recently.
 *
 * File mode tails by byte offset — it reads only the bytes appended since the
 * last poll, so cost and correctness don't degrade as the file grows past any
 * size. Rewrites (LocalVocal's truncate-on-new-sentence mode, or a new
 * session reusing the path) are detected by comparing the first bytes of the
 * file, and reset the offset. A trailing line with no newline yet is held
 * back until it completes, so half-written words never enter the transcript.
 *
 * Every line then passes through the speech-quality layer (`src/speech.js`):
 * Whisper's silence hallucinations are dropped, and the streamer's correction
 * map is applied, before anything reaches the cast or the deck feed.
 */
export class TranscriptFeed {
  constructor({ mode, file, textSource, pollSeconds, windowSeconds, obs, onSpeech, speech }) {
    this.mode = mode || 'off';
    this.file = file;
    this.textSource = textSource;
    this.pollMs = (pollSeconds ?? 2) * 1000;
    this.windowMs = (windowSeconds ?? 120) * 1000;
    this.obs = obs;
    this.onSpeech = onSpeech || (() => {});
    // Live reference to config.speech — hot config saves deep-assign into the
    // same object, so corrections apply mid-stream without a relaunch.
    this.speech = speech || {};
    this.compiled = null; // corrections compiled once, keyed on array identity
    this.compiledFrom = null;
    this.entries = []; // {ts, text}
    this.lastHeardAt = null;
    // file-mode tail state
    this.offset = 0;
    this.head = null; // Buffer of the file's first bytes, for rewrite detection
    this.carry = ''; // incomplete trailing line held until its newline arrives
    // textSource-mode state
    this.lastSourceText = null; // null = not primed yet
  }

  start() {
    if (this.mode === 'file') {
      if (!this.file) {
        console.warn('[transcript] mode is "file" but no file path configured (Settings → Voice).');
        return;
      }
      // Skip whatever is already in the file — old speech from before we
      // started isn't "recent," and shouldn't trigger a reply at startup.
      try {
        if (existsSync(this.file)) {
          this.offset = statSync(this.file).size;
          this.head = this.readHead();
        }
      } catch {}
      setInterval(() => this.pollFile(), this.pollMs);
      console.log(`[transcript] tailing LocalVocal output file: ${this.file}`);
    } else if (this.mode === 'textSource') {
      if (!this.textSource) {
        console.warn('[transcript] mode is "textSource" but no source name configured (Settings → Voice).');
        return;
      }
      // Prime with the current caption so a stale pre-launch line isn't
      // ingested as fresh speech on the first poll.
      this.obs.getTextSourceText(this.textSource).then((text) => {
        if (this.lastSourceText === null) this.lastSourceText = text ?? '';
      });
      setInterval(() => this.pollTextSource(), this.pollMs);
      console.log(`[transcript] polling OBS text source: "${this.textSource}"`);
    }
  }

  /** Compiled corrections, rebuilt only when the config array is swapped out. */
  corrections() {
    const list = this.speech?.corrections;
    if (list !== this.compiledFrom) {
      this.compiledFrom = list;
      this.compiled = compileCorrections(list);
    }
    return this.compiled;
  }

  addLine(text) {
    const raw = String(text).trim();
    if (!raw || isSrtMetadata(raw)) return;
    // Whisper filler on silence/music would otherwise read as the streamer
    // speaking — and a voice reply to something nobody said is worse than
    // missing a line, so this is on by default.
    if (this.speech?.dropHallucinations !== false && isHallucination(raw)) return;
    const cleaned = applyCorrections(raw, this.corrections());
    if (!cleaned) return; // a correction mapping to "" deletes the line
    this.entries.push({ ts: Date.now(), text: cleaned });
    this.lastHeardAt = Date.now();
    this.prune();
    this.onSpeech(cleaned);
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;
    while (this.entries.length && this.entries[0].ts < cutoff) this.entries.shift();
  }

  /**
   * Speech within the window, oldest first, joined — or ''. Pass sinceTs to
   * get only entries newer than it (used to avoid re-sending transcript the
   * model already saw on fast follow-up generations).
   */
  getWindow(sinceTs = 0) {
    this.prune();
    return this.entries
      .filter((e) => e.ts > sinceTs)
      .map((e) => e.text)
      .join(' ');
  }

  // ---- file mode ----

  readHead() {
    try {
      const fd = openSync(this.file, 'r');
      try {
        const size = fstatSync(fd).size;
        const len = Math.min(size, HEAD_LEN);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, 0);
        return buf;
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  pollFile() {
    let size;
    try {
      if (!existsSync(this.file)) return;
      size = statSync(this.file).size;
    } catch {
      return; // transient error (e.g. plugin mid-write) — try again next poll
    }

    // Rewrite detection: shrunk file, or same/bigger file whose first bytes
    // changed (truncate-mode LocalVocal rewrites the whole file per sentence).
    if (size < this.offset || this.headChanged()) {
      this.offset = 0;
      this.carry = '';
    }
    if (size === this.offset) return; // nothing new

    let chunk;
    try {
      const fd = openSync(this.file, 'r');
      try {
        const start = Math.max(this.offset, size - MAX_CHUNK);
        const len = size - start;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, start);
        chunk = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    this.offset = size;
    this.head = this.readHead();

    const text = this.carry + chunk;
    const lines = text.split(/\r?\n/);
    // If the chunk didn't end at a line boundary, hold the tail for next poll
    // so partial words never enter the transcript as speech.
    this.carry = text.endsWith('\n') || text.endsWith('\r') ? '' : lines.pop() ?? '';
    for (const line of lines) this.addLine(line);
  }

  headChanged() {
    if (this.head === null || this.head.length === 0) return false;
    const now = this.readHead();
    if (now === null) return false;
    const len = Math.min(this.head.length, now.length);
    return !this.head.subarray(0, len).equals(now.subarray(0, len));
  }

  // ---- textSource mode ----

  async pollTextSource() {
    const text = await this.obs.getTextSourceText(this.textSource);
    if (text === null || this.lastSourceText === null) return; // unreachable or not primed
    if (text === this.lastSourceText) return;
    this.lastSourceText = text;
    this.addLine(text);
  }
}
