import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const examplePath = path.join(packageRoot, 'config.example.json');

function isPlainObject(v) {
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

// Bounds for every numeric config value — the same ranges the Settings UI
// enforces on its inputs. The tray's "Edit Config (raw JSON)" invites hand
// editing, and a non-numeric cadence value would otherwise become a NaN
// timer: setTimeout(fn, NaN) fires immediately, which turns the ghost into
// a rapid-fire money-burning loop. Wrong type -> default; out of range ->
// clamped.
const NUMERIC_LIMITS = {
  'port': [1024, 65535],
  'obs.screenshotWidth': [320, 1920],
  'app.autoPauseMinutes': [2, 120],
  'app.costCapDollars': [0, 1000],
  'memory.updateEvery': [2, 20],
  'transcript.pollSeconds': [1, 30],
  'cadence.soloSeconds': [20, 900],
  'cadence.quietSeconds': [60, 3600],
  'cadence.jitter': [0, 1],
  'cadence.burstChance': [0, 1],
  'cadence.lullChance': [0, 1],
  'cadence.replyDelaySeconds': [2, 60],
  'cadence.minVoiceReplyGapSeconds': [0, 300],
  'cadence.minScreenshotGapSeconds': [0, 300],
  'cadence.viewerPollSeconds': [30, 600],
  'cadence.transcriptWindowSeconds': [30, 600],
};

function sanitize(config, defaults) {
  const problems = [];
  // A config section replaced by a scalar ("cadence": 5) would make every
  // lookup inside it undefined — restore the whole section from defaults.
  for (const [key, defVal] of Object.entries(defaults)) {
    if (isPlainObject(defVal) && !isPlainObject(config[key])) {
      config[key] = defVal;
      problems.push(`"${key}" is not an object — using defaults for that section`);
    }
  }
  for (const [dotted, [min, max]] of Object.entries(NUMERIC_LIMITS)) {
    const keys = dotted.split('.');
    const parent = keys.slice(0, -1).reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), config);
    const holder = keys.length === 1 ? config : parent;
    if (!isPlainObject(holder)) continue;
    const key = keys.at(-1);
    const def = keys.reduce((o, k) => (o == null ? undefined : o[k]), defaults);
    const value = holder[key];
    // Accept numbers and numeric strings ("90" from a hand edit); anything
    // else (including "", null, booleans) falls back to the default.
    const num =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : NaN;
    if (!Number.isFinite(num)) {
      holder[key] = def;
      problems.push(`"${dotted}" is not a number — using default ${def}`);
    } else {
      const clamped = Math.min(max, Math.max(min, num));
      holder[key] = clamped;
      if (clamped !== num) problems.push(`"${dotted}" out of range — clamped to ${clamped}`);
    }
  }
  return problems;
}

/**
 * Load config with config.example.json as the single source of defaults.
 * Never throws: invalid JSON or a missing file degrades to defaults with a
 * warning, and numeric values are type-checked and clamped, so a hand-edited
 * config can't brick startup (or worse, NaN the message timer).
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
  const problems = sanitize(config, defaults);
  if (problems.length) {
    warning = [warning, `config values corrected: ${problems.join('; ')}`].filter(Boolean).join(' | ');
  }
  return { config, warning };
}
