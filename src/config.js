import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const examplePath = path.join(packageRoot, 'config.example.json');

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// User values win; missing keys fall back to defaults, recursively. This is
// what makes an old or hand-edited config safe: a missing cadence key becomes
// the example's value instead of NaN timers / crashes.
function deepMerge(defaults, user) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(user ?? {})) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(defaults[key]) ? deepMerge(defaults[key], value) : value;
  }
  return out;
}

/**
 * Load config with config.example.json as the single source of defaults.
 * Never throws: invalid JSON or a missing file degrades to defaults with a
 * warning, so a hand-edited config can't brick startup.
 *
 * @returns {{ config: object, warning: string|null }}
 */
export function loadConfig(configPath) {
  const defaults = JSON.parse(readFileSync(examplePath, 'utf8'));
  let user = {};
  let warning = null;
  if (!existsSync(configPath)) {
    warning = `config not found at ${configPath} — using defaults. Run the setup wizard to create it.`;
  } else {
    try {
      user = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      warning = `config at ${configPath} is not valid JSON (${err.message}) — using defaults. Fix or re-save it in Settings.`;
    }
  }
  const config = deepMerge(defaults, user);
  // Cast migration: if the user's config predates 3.x (no `cast` key of their
  // own), drop the example cast so resolveCast() rebuilds the roster from their
  // customized bot/bot2 instead of silently replacing it with "Beacon/Wisp".
  if (!isPlainObject(user) || !Array.isArray(user.cast)) config.cast = null;
  return { config, warning };
}
