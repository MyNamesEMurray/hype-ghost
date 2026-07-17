# Hype Ghost 3.1.0 — "The Green Room" goes live 👻

The first release of the 3.x line. Everything from 2.0 and 3.0 ships together here, plus the 3.1 hardening pass — so if you're updating from 1.5.1, your practice-chat window is about to become a very different app.

## From one ghost to a directable cast (3.0)

- **The Cast** — up to **four** simulated viewers (was one, then two), each with its own name, personality archetype, and stage color. Edit the whole roster in Settings → Cast.
- **The Command Deck** — the dashboard reimagined: a stage of cast avatars that breathe when active, a live feed, ambient status orbs, a session clock, and a command palette (⌘/Ctrl-K).
- **The energy dial** — one live control that scales how often the cast talks *and* their whole mood, from 🌙 chill to 🔥 electric, mid-stream.
- **Moments** — the cast flags clip-worthy plays into a highlight reel, a ✨ pop on the overlay, and VOD chapter markers in the recap export. **New in 3.1:** if OBS's replay buffer is running, a flagged moment also saves an actual clip (`moments.saveReplay`).
- **A new look** — glass panels, the aurora, accent themes, per-ghost colors, purposeful motion, in a studio-at-night dark theme.

## Carried up from 2.0 (never released until now)

- **Local & free brains** — Ollama, LM Studio, or any OpenAI-compatible endpoint; no API key required.
- **Cross-stream memory** — "did you ever beat that boss from Tuesday?"
- **Real Twitch chat awareness** (read-only) — the cast hangs back when actual chat is active.
- **TTS co-host**, **post-stream recap export**, **overlay customization**, and a **Spanish interface**.

## 3.1 hardening (this release)

- Typed replies are never silently dropped when the cast is mid-message; a hung local brain times out instead of freezing the room.
- Chat history, moments, session cost, and the clock survive app restarts (including settings saves).
- Most settings now **apply live on save** — no more mid-stream app relaunch for overlay, cadence, or theme tweaks.
- Idle scenes (BRB / starting soon) no longer re-send identical screenshots, and the prompt is structured for caching — noticeably cheaper quiet stretches.
- More secrets (local-brain API key, Twitch client secret) are redacted from the settings UI, matching the Anthropic key.
- A `node:test` suite and a wider CI/smoke net behind the scenes.

## Notes

- **Updating from 1.5.1:** the in-app auto-updater will pick this up, or grab `Hype-Ghost-Setup-3.1.0.exe` below. Windows SmartScreen will warn because the installer is unsigned — More info → Run anyway.
- Your existing config migrates automatically (a 2.x-style `bot`/`bot2` setup becomes the new cast).

**Unchanged, as always:** every cast message is labeled 🤖 AI, the overlay keeps its permanent "simulated viewers" watermark, and nothing ever touches real Twitch chat or your stream metrics.
