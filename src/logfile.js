import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Rotating file log for the packaged app. The tray-resident process has no
 * visible console, so OBS drops, LocalVocal stalls, and API errors would
 * otherwise vanish — this keeps the last ~2MB of them in the data folder
 * (hype-ghost.log + one .old generation) for bug reports.
 *
 * Logging must never take the app down: every filesystem touch is wrapped,
 * and a failure just means that line is lost.
 */
export class FileLog {
  constructor(file, { maxBytes = 1_000_000 } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
  }

  append(level, parts) {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        if (statSync(this.file).size > this.maxBytes) renameSync(this.file, this.file + '.old');
      } catch {} // no file yet, or .old locked — either way, keep writing
      appendFileSync(this.file, `${new Date().toISOString()} ${level.padEnd(5)} ${parts.map(fmt).join(' ')}\n`);
    } catch {}
  }

  /** Tee console.log/warn/error into the file (console still prints). */
  hookConsole() {
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        this.append(level, args);
      };
    }
  }
}
