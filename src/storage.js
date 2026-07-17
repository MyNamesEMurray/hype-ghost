import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the app's mutable files live (config, session memory, cross-stream
 * profile, log). The default is the host's data dir — Electron's userData
 * when packaged, the project root in dev. A small pointer file *in the
 * default dir* can redirect everything else to a user-chosen folder
 * (Settings → About → Storage), so the pointer itself is always findable.
 *
 * Plain functions (no Electron imports) so the whole flow is unit-testable
 * and the headless server stays Electron-free.
 */

export const POINTER_FILE = 'storage.json';

// Every data file the app writes, relative to its data dir. The log and the
// update-skip marker are listed so migration and factory reset carry/clear
// them with everything else.
export const DATA_FILES = ['config.json', 'session-notes.txt', 'session.json', 'profile.md', 'hype-ghost.log', 'update-skip.json'];

export function dataFilePaths(dir) {
  return {
    configPath: path.join(dir, 'config.json'),
    notesPath: path.join(dir, 'session-notes.txt'),
    sessionPath: path.join(dir, 'session.json'),
    profilePath: path.join(dir, 'profile.md'),
    logPath: path.join(dir, 'hype-ghost.log'),
    skipPath: path.join(dir, 'update-skip.json'),
  };
}

/**
 * Resolve the active data dir from the pointer in defaultDir. Any problem —
 * no pointer, bad JSON, relative path, folder deleted or on an unplugged
 * drive — falls back to the default: the app must always boot.
 */
export function resolveDataDir(defaultDir) {
  try {
    const raw = readFileSync(path.join(defaultDir, POINTER_FILE), 'utf8');
    const dir = JSON.parse(raw)?.dataDir;
    if (
      typeof dir === 'string' &&
      path.isAbsolute(dir) &&
      existsSync(dir) &&
      statSync(dir).isDirectory() &&
      path.resolve(dir) !== path.resolve(defaultDir)
    ) {
      return { dir, custom: true };
    }
  } catch {}
  return { dir: defaultDir, custom: false };
}

/** Write the pointer, or clear it (dir = null / the default itself). */
export function setDataDir(defaultDir, dir) {
  const pointer = path.join(defaultDir, POINTER_FILE);
  if (!dir || path.resolve(dir) === path.resolve(defaultDir)) {
    rmSync(pointer, { force: true });
    return;
  }
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(pointer, JSON.stringify({ dataDir: dir }, null, 2) + '\n');
}

/**
 * Copy (never move — the originals stay behind as a fallback if the new
 * location goes bad) every known data file that exists. Returns the names
 * copied so the caller can report what traveled.
 */
export function migrateDataFiles(fromDir, toDir) {
  if (path.resolve(fromDir) === path.resolve(toDir)) return [];
  mkdirSync(toDir, { recursive: true });
  const copied = [];
  for (const name of DATA_FILES) {
    const src = path.join(fromDir, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, path.join(toDir, name));
    copied.push(name);
  }
  return copied;
}
