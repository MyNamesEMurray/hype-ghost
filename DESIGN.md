# Hype Ghost design language 👻

The written philosophy behind every surface of the app. If a change doesn't fit these
principles, the change is wrong — or this document needs a deliberate update first.

## Principles

1. **Dark, calm, out of the way.** The app lives next to a stream. Nothing flashes,
   nothing animates for attention, nothing competes with the game.
2. **One purple.** `--accent` (#9b6dff) is the only action color. Primary buttons,
   selected states, links, and the streamer's identity all use it. If two things on one
   screen are purple, one of them is wrong.
3. **The ghost is blue.** `--ghost` (#6dc2ff) marks everything the AI says or is:
   its name, its badge, its messages. Blue = machine, purple = human. Never mix.
4. **AI is always labeled.** Every bot message carries the `.badge-ai` component ("🤖 AI"),
   identical on dashboard and overlay, and the overlay carries a permanent watermark.
   This is the product's ethic rendered visually — it is never restyled per-surface,
   shrunk, or dimmed.
5. **Status is quiet.** Pills, not banners. Good = green text, bad = red text, in the
   same shape. The layout never shifts when status changes (fixed-width where content
   varies, e.g. the mic pill).
6. **Sentence case everywhere.** Buttons, labels, hints: "Test key", "Save & restart",
   "Add overlay to OBS". Title Case only where Windows convention demands it (tray menu).
7. **The ghost voice.** Copy is playful but clear; the persona is "the ghost" (never
   "the bot" or "the AI assistant"). Hints talk like a friendly human, not documentation.
8. **The overlay is a guest on someone's stream.** It shares the color tokens but keeps
   its own typography (bolder, larger, text-shadowed) for legibility over video, a
   transparent background, and zero interactivity. It renders; it never decorates.
9. **Emoji are the icon system.** One emoji per concept, reused everywhere, never
   invented ad hoc:

   | Emoji | Concept |
   |---|---|
   | 👻 | app identity / Ghost persona |
   | 🧠 | brain / model / API |
   | 📷 | stream & OBS |
   | 🎙 | voice / mic transcription |
   | 💬 | chat behavior & cadence |
   | 🔧 | app plumbing |
   | 📺 | Twitch |
   | 📝 | session memory |
   | 🤖 | AI labeling (badges, watermark) — reserved, never decorative |
   | ⚠ | warnings & system notices |
   | ✓ / ✗ | test results |

## Tokens ([public/theme.css](public/theme.css))

- **Colors:** `--bg` `--panel` `--border` `--text` `--dim` `--accent` `--on-accent`
  `--accent-tint(-border)` `--accent-bright` (overlay-only lift) `--ghost` `--on-ghost`
  `--good(-border)` `--bad(-border)` `--warn`. No hex values in page files.
- **Radii:** 6 (badges) · 8 (controls) · 10 (bubbles) · 14 (cards) · 999 (pills/chips/tabs).
- **Type scale:** 12 (hints) · 13 (labels/buttons/meta) · 15 (body) · 17 (toolbar title)
  · 21 (page title). No fractional sizes.
- **Focus:** every interactive element shows a 2px accent ring on `:focus-visible`.

## Structure

`theme.css` owns tokens, base elements (buttons, inputs, selects, headings), and shared
components (`.card` `.pill` `.chip` `.tab` `.result` `.badge-ai` `.hint` layout helpers).
Each page's `<style>` block contains **layout only** — grids, page-specific positioning,
and the overlay's on-video treatment. If a rule would be useful on a second page, it
belongs in theme.css.
