import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/**
 * "Skip this update" memory for the auto-updater.
 *
 * Skipping v3.1.0 means: never offer v3.1.0 (or anything older) again, but
 * ask normally the moment something strictly newer exists. One marker file,
 * one version — a later skip simply overwrites an earlier one.
 *
 * Plain Node (no Electron imports) so the compare/persist logic is
 * unit-testable; electron/main.js owns the dialog and the updater events.
 */

/**
 * Compare two x.y.z versions (a leading "v" is tolerated).
 * Returns -1 / 0 / 1, or NaN when either side isn't a plain numeric triple —
 * callers treat NaN as "don't trust the marker" and prompt normally.
 */
export function cmpVersions(a, b) {
  const norm = (v) => String(v ?? '').trim().replace(/^v/, '');
  const va = norm(a);
  const vb = norm(b);
  if (!/^\d+(\.\d+)*$/.test(va) || !/^\d+(\.\d+)*$/.test(vb)) return NaN;
  const pa = va.split('.').map(Number);
  const pb = vb.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

export class UpdateSkip {
  constructor(file) {
    this.file = file;
  }

  /** The skipped version string, or null (no marker / unreadable marker). */
  read() {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8'))?.version;
      return typeof v === 'string' && v ? v : null;
    } catch {
      return null;
    }
  }

  /** Should `version` stay silent? True only for the skipped version or older. */
  isSkipped(version) {
    const skipped = this.read();
    if (!skipped) return false;
    const c = cmpVersions(version, skipped);
    return Number.isFinite(c) && c <= 0;
  }

  skip(version) {
    try {
      writeFileSync(this.file, JSON.stringify({ version: String(version) }) + '\n');
    } catch {} // worst case: the user is asked again next launch
  }

  clear() {
    try {
      rmSync(this.file, { force: true });
    } catch {}
  }

  /**
   * Housekeeping at boot: once the app is running at (or past) the skipped
   * version — they updated after all — the marker can never match again;
   * drop it so a stale file doesn't outlive its meaning.
   */
  clearIfNotNewer(currentVersion) {
    const skipped = this.read();
    if (!skipped) return;
    const c = cmpVersions(skipped, currentVersion);
    if (Number.isFinite(c) && c <= 0) this.clear();
  }
}
