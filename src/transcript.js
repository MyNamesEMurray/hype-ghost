import { openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';

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

/**
 * Ingests the streamer's mic transcription produced by the LocalVocal OBS
 * plugin (local whisper.cpp inside OBS), and keeps a rolling window of what
 * was said recently.
 *
 * Two ingestion modes, matching LocalVocal's two output options:
 *  - 'file':       tail the .txt file LocalVocal writes (append or truncate mode)
 *  - 'textSource': poll an OBS text source over the existing OBS WebSocket
 *                  connection (the source can stay hidden in every scene)
 */
export class TranscriptFeed {
  constructor({ mode, file, textSource, pollSeconds, windowSeconds, obs, onSpeech }) {
    this.mode = mode || 'off';
    this.file = file;
    this.textSource = textSource;
    this.pollMs = (pollSeconds ?? 2) * 1000;
    this.windowMs = (windowSeconds ?? 120) * 1000;
    this.obs = obs;
    this.onSpeech = onSpeech || (() => {});
    this.entries = []; // {ts, text}
    this.lastFileContent = '';
    this.lastSourceText = '';
    this.lastHeardAt = null;
  }

  start() {
    if (this.mode === 'file') {
      if (!this.file) {
        console.warn('[transcript] mode is "file" but no file path configured.');
        return;
      }
      // Skip whatever is already in the file — old speech from before we
      // started isn't "recent," and shouldn't trigger a reply at startup.
      this.lastFileContent = this.readTail() ?? '';
      setInterval(() => this.pollFile(), this.pollMs);
      console.log(`[transcript] tailing LocalVocal output file: ${this.file}`);
    } else if (this.mode === 'textSource') {
      if (!this.textSource) {
        console.warn('[transcript] mode is "textSource" but no source name configured.');
        return;
      }
      setInterval(() => this.pollTextSource(), this.pollMs);
      console.log(`[transcript] polling OBS text source: "${this.textSource}"`);
    }
  }

  addLine(text) {
    const cleaned = String(text).trim();
    if (!cleaned) return;
    this.entries.push({ ts: Date.now(), text: cleaned });
    this.lastHeardAt = Date.now();
    this.prune();
    this.onSpeech(cleaned);
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;
    while (this.entries.length && this.entries[0].ts < cutoff) this.entries.shift();
  }

  /** Everything the streamer said within the window, oldest first, or ''. */
  getWindow() {
    this.prune();
    return this.entries.map((e) => e.text).join(' ');
  }

  // ---- file mode: read the tail of the file each poll and diff it ----
  // Handles both LocalVocal file modes: append (new lines added) and
  // truncate (file rewritten with only the latest sentence).
  /** Last 64 KB of the file, or null if unreadable/missing. */
  readTail() {
    if (!existsSync(this.file)) return null;
    try {
      const fd = openSync(this.file, 'r');
      try {
        const size = fstatSync(fd).size;
        const readLen = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, size - readLen);
        return buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return null; // transient read error (e.g. plugin mid-write) — try again next poll
    }
  }

  pollFile() {
    const content = this.readTail();
    if (content === null || content === this.lastFileContent) return;
    // Appended: new text is the suffix. Rewritten/truncated: treat it all as new.
    const fresh = content.startsWith(this.lastFileContent)
      ? content.slice(this.lastFileContent.length)
      : content;
    this.lastFileContent = content;
    for (const line of fresh.split(/\r?\n/)) {
      if (isSrtMetadata(line)) continue;
      this.addLine(line);
    }
  }

  // ---- textSource mode: poll the text source's current text via obs-websocket ----
  async pollTextSource() {
    const text = await this.obs.getTextSourceText(this.textSource);
    if (text === null || text === this.lastSourceText) return;
    this.lastSourceText = text;
    this.addLine(text);
  }
}
