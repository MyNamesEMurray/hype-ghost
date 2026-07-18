# Hype Ghost design language 👻 — 3.0 "The Green Room"

The written philosophy behind every surface of the app. If a change doesn't fit these
principles, the change is wrong — or this document needs a deliberate update first.

3.0 reframes the product from *a practice-chat window* into **a director's console for a
simulated room**. The ghosts are no longer a list beside a chat log; they're a **cast** with
stage presence, and the streamer is the director. The visuals moved with the metaphor.

## Principles

1. **A studio at night, not a control panel.** The app lives next to a stream and should feel
   like a calm, dark broadcast studio: a deep gradient base, translucent glass panels, and a
   single signature light — the **aurora** (aqua → violet → rose). Depth and atmosphere, never
   clutter.
2. **Motion has a job or it doesn't ship.** 2.x said *nothing animates*. 3.0 allows motion
   that carries meaning — an active ghost's avatar breathes, a new message rises, a flagged
   moment pops — and nothing else. Everything respects `prefers-reduced-motion`. Decorative
   animation is still wrong.
3. **Violet is the human; the cast own their colors.** `--accent` (violet by default, and
   themeable) is *you* — your messages, your primary actions, your identity. Each ghost carries
   an assignable color from the ghost palette (`aqua rose mint gold coral sky`). A ghost is
   never violet; you are never a ghost color. This separation is load-bearing, not decorative.
4. **AI is always labeled — this never bends.** Every cast message carries the `.badge-ai`
   ("🤖 AI"), identical on deck and overlay, and the overlay carries a permanent
   "simulated viewers, not real people" watermark. This is the product's ethic rendered
   visually. It is never restyled per-surface, shrunk, dimmed, or made optional.
5. **One dial beats ten sliders.** The **energy** dial is the streamer's live tone control:
   one gesture scales both cadence and mood. Raw cadence numbers still exist in Settings for
   power users, but the deck exposes the human-scale control, not the machinery.
6. **Status is ambient.** Connection state lives as small **orbs** in the top bar — a colored
   dot that quietly glows when live. No banners, no layout shift when status changes.
7. **Sentence case, and the ghost voice.** Buttons, labels, hints in sentence case
   ("Say something", "Export recap", "Add overlay to OBS"). Copy is playful but clear; the
   personas are "the cast" / "a ghost", never "the bot" or "the AI assistant". Hints talk like
   a friendly human, not documentation.
8. **The overlay is a guest on someone's stream.** It shares the color tokens but keeps its own
   bolder, text-shadowed typography for legibility over video, a transparent background, and
   zero interactivity. It renders; it never decorates. The AI badge and watermark are guests
   that always announce themselves.
9. **Emoji are the icon system.** One emoji per concept, reused everywhere, never invented
   ad hoc:

   | Emoji | Concept |
   |---|---|
   | 👻 | app identity / a ghost |
   | 🧠 | brain / model / API |
   | 📷 | stream & OBS |
   | 🎙️ | voice / mic transcription |
   | 💬 | chat behavior & cadence |
   | 🎨 | look / theming |
   | 🔧 | app plumbing |
   | 📺 | Twitch |
   | 📝 | session memory |
   | ✨ | clip-worthy moments / highlights |
   | 🤖 | AI labeling (badges, watermark) — reserved, never decorative |
   | ⚠ | warnings & system notices |
   | ✓ / ✗ | test results |

## Tokens ([public/theme.css](public/theme.css))

- **Surfaces:** `--bg` `--bg-2` (base gradient) · `--panel` (solid) · `--glass` `--glass-2`
  (translucent fills) · `--border` `--border-strong`.
- **Text:** `--text` `--dim` `--faint`.
- **Accent (the human):** `--accent` `--accent-2` `--on-accent` `--accent-soft`
  `--accent-line`. Themeable at runtime (violet/cyan/emerald/amber/magenta) by overriding these
  five on `:root`.
- **Cast + status:** `--ghost` (default hue + AI labeling) `--on-ghost` `--good` `--bad`
  `--warn`. Per-ghost hues are applied inline via a `--gc` custom property, never hardcoded.
- **Signature:** `--aurora` (the one gradient — energy dial, moment sparks, brand marks).
- **Radii:** `--r-sm` 8 · `--r-md` 12 · `--r-lg` 16 · `--r-xl` 22 · `--r-full` 999.
- **Type scale:** 11 · 13 · 15 · 18 · 22 · 30. Display sizes use negative letter-spacing.
- **Depth:** `--shadow` `--shadow-sm`. **Focus:** every interactive element shows a 2px accent
  ring on `:focus-visible`.

## Structure

`theme.css` owns tokens, base elements (buttons, inputs, selects, headings), and shared
components (`.card` `.pill` `.chip` `.tab` `.result` `.badge-ai` `.orb` layout helpers).
Each page's `<style>` block contains **layout only** — the deck's stage/feed grid, the energy
dial and cast-tile treatments, the settings nav, the overlay's on-video styling. If a rule
would be useful on a second page, it belongs in theme.css.
