/**
 * The Cast — Hype Ghost 3.0 promotes the old bot/bot2 pair into a full roster
 * of up to four simulated viewers. This module owns the ghost color palette
 * (assignable stage identities), the personality archetypes the setup wizard
 * offers, and the migration from a 2.x config (bot + bot2) to a 3.x cast.
 *
 * Design rule carried from 2.x: violet is the streamer's color (human), so it
 * never appears in the ghost palette. Machine colors never touch the human's.
 */

// Each ghost gets a color token: a bright hue for legibility over video and a
// dark "on" color for text placed on a fill of that hue.
export const GHOST_COLORS = {
  aqua: { hex: '#5ad1ff', on: '#04121b' },
  rose: { hex: '#ff9ecb', on: '#1c0713' },
  mint: { hex: '#5fe6b0', on: '#04140d' },
  gold: { hex: '#ffd166', on: '#1c1304' },
  coral: { hex: '#ff9d7a', on: '#1c0a04' },
  sky: { hex: '#8fb4ff', on: '#050c1c' },
};
export const GHOST_COLOR_ORDER = ['aqua', 'rose', 'mint', 'gold', 'coral', 'sky'];

// The human's accent themes (the deck's --accent family) — ghosts never wear
// these. Served to the pages via /api/config, /api/overlay-config, and the
// WS init snapshot so the hex values live in exactly one place.
export const ACCENT_COLORS = {
  violet: { accent: '#a78bfa', accent2: '#c4b5fd', on: '#0d0620', soft: 'rgba(167,139,250,.14)', line: 'rgba(167,139,250,.4)' },
  cyan: { accent: '#38bdf8', accent2: '#7dd3fc', on: '#04121c', soft: 'rgba(56,189,248,.14)', line: 'rgba(56,189,248,.4)' },
  emerald: { accent: '#34d399', accent2: '#6ee7b7', on: '#04140d', soft: 'rgba(52,211,153,.14)', line: 'rgba(52,211,153,.4)' },
  amber: { accent: '#fbbf24', accent2: '#fcd34d', on: '#1c1204', soft: 'rgba(251,191,36,.14)', line: 'rgba(251,191,36,.4)' },
  magenta: { accent: '#f472b6', accent2: '#f9a8d4', on: '#1c0714', soft: 'rgba(244,114,182,.14)', line: 'rgba(244,114,182,.4)' },
};

// Personality presets surfaced as one-tap chips in setup and the cast editor.
export const ARCHETYPES = [
  { id: 'curious', label: 'Curious', emoji: '🔎', color: 'aqua',
    personality: 'friendly, curious, a little goofy; loves asking questions about whatever is on screen' },
  { id: 'hype', label: 'Hype', emoji: '🔥', color: 'coral',
    personality: 'high-energy hype friend; celebrates every small win, big on encouragement, never negative' },
  { id: 'lurker', label: 'Lurker', emoji: '🌙', color: 'rose',
    personality: 'chill half-lurker; dry one-liners; pretends not to care but clearly does' },
  { id: 'deadpan', label: 'Deadpan', emoji: '😐', color: 'sky',
    personality: 'dry, deadpan, lightly sarcastic; roasts gently but is secretly very supportive' },
  { id: 'nerd', label: 'The nerd', emoji: '🧠', color: 'mint',
    personality: 'knows the game inside out; drops tips and lore, geeks out over mechanics, never condescending' },
  { id: 'goblin', label: 'Chaos goblin', emoji: '👾', color: 'gold',
    personality: 'chaotic gremlin energy; memes, emote spam, playful nonsense, but reads the room' },
];

function colorFor(key, index) {
  if (GHOST_COLORS[key]) return key;
  return GHOST_COLOR_ORDER[index % GHOST_COLOR_ORDER.length];
}

/**
 * Resolve the active cast from config. Prefers the 3.x `cast` array; falls
 * back to migrating a 2.x `bot`/`bot2` config so old installs keep working.
 * Returns 1–4 personas, each with a name, personality, and resolved color.
 *
 * @returns {Array<{name:string, personality:string, colorKey:string, hex:string, on:string}>}
 */
export function resolveCast(config) {
  let entries = Array.isArray(config.cast) ? config.cast.filter((c) => c && c.enabled !== false) : [];
  if (!entries.length) {
    // 2.x migration: the primary bot, plus the second ghost if it was on.
    entries = [
      { name: config.bot?.name, personality: config.bot?.personality, color: 'aqua' },
      ...(config.bot2?.enabled
        ? [{ name: config.bot2.name, personality: config.bot2.personality, color: 'rose' }]
        : []),
    ];
  }
  return entries.slice(0, 4).map((c, i) => {
    const key = colorFor(c.color, i);
    const { hex, on } = GHOST_COLORS[key];
    return {
      name: (c.name || `Ghost ${i + 1}`).slice(0, 24),
      personality: c.personality || 'friendly and curious',
      archetype: c.archetype,
      colorKey: key,
      hex,
      on,
    };
  });
}
