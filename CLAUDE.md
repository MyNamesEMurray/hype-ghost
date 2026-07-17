# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hype Ghost is a Windows desktop app (Electron) for streamers: a "cast" of up to four simulated AI viewers watches the stream via OBS screenshots + a local mic transcript and chats through a dashboard ("Command Deck") and an OBS browser-source overlay. Plain ESM JavaScript throughout (`"type": "module"`, Node ≥20) — no TypeScript, no bundler, no framework.

## Commands

```
npm install      # first time (downloads the Electron binary)
npm start        # desktop app (dev mode uses config.json in the project root)
npm run serve    # headless server only, no window/tray (node src/cli.js, port 3777)
npm run smoke    # boot + route check — exactly what CI runs
npm run icons    # regenerate build/icon.ico + PNGs from assets/*.svg
npm run dist     # build the Windows installer into dist/
```

Tests are plain `node:test` (`npm test` runs `test/*.test.js`); there is no linter. CI (`.github/workflows/ci.yml`) is: syntax-check every JS file, validate `config.example.json`, run the tests, run the smoke test. Reproduce it locally before pushing:

```
npm ci --ignore-scripts
for f in $(git ls-files '*.js' '*.mjs'); do node --check "$f"; done
node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8'))"
npm test
npm run smoke
```

`--ignore-scripts` skips the Electron/sharp binaries — none are needed for the headless server, so this works in environments that can't run Electron.

## Branch model

**Branch off `main`, PR into `main`.** `main` is the only long-lived branch — the trunk and the released line the installer/auto-updater builds from; released states are pinned by `vX.Y.Z` tags, and older lines (1.x/2.x/the retired `v3` integration branch) live in `main`'s history. Feature branches are `claude/<topic>` or `feature/<topic>`. Releasing = bump `package.json`, update `RELEASE_NOTES.md`, tag `vX.Y.Z`, push the tag (or run the Release workflow manually) — it builds and publishes the installer.

## Architecture

The app is a local Express + WebSocket server with two hosts:

- **`electron/main.js`** — desktop shell: tray-first (closing the window destroys the renderer but keeps the server chatting), single-instance lock, auto-update from GitHub Releases. When packaged, config lives in `%APPDATA%/Hype Ghost/`; in dev it's the project root. Saving config from the UI **relaunches the whole app** to apply it (`onConfigSaved`) — unless every changed key is in the server's `HOT_PATHS` set (overlay/theme/cadence/moments/memory/stream/talking points), in which case the server hot-applies it live. Session state (`session.json`: chat history, moments, cost, start time) persists across that relaunch with the same 6-hour freshness rule as session notes.
- **`src/cli.js`** — the same server headless (used by `npm run serve` and the smoke test).

**`src/server.js` — `startServer(opts)`** is the composition root. It wires everything below, owns all mutable session state (the `state` object, `history`, `highlights`, session notes), serves the four pages (`/` dashboard, `/overlay`, `/setup`, `/settings`) and the JSON API, and broadcasts to browser clients over WebSocket (`init` / `state` / `chat` / `moment` / `system` messages; clients send `streamer_message` / `pause` / `resume` / `nudge` / `set_energy` / `override_viewers`). Host-app integration points (restart, tray refresh, native file dialog) come in as `opts` hooks so the server never imports Electron.

**`src/loop.js` — `GhostLoop`** is the timing state machine, deliberately extracted as the hardest-to-reason-about code: when to speak and why (triggers: `timer` / `reply` / `voice` / `nudge`), cadence with jitter/burst/lull, the energy dial (0–100 → cadence multiplier + mood), voice-reply debounce with rate floors, screenshot-gap skipping, the once-per-streamer-activity banter cap for two-ghost exchanges, session-notes/profile update cadence, and the auto-pause dead-man switch (OBS unreachable for N minutes → pause API spend, auto-resume when OBS returns). It talks to the host only through its `hooks` object.

**`src/brain.js` — `Brain`** builds the system/user prompts and calls either the Anthropic API (default) or any OpenAI-compatible endpoint (`brain.provider: "openai"` — Ollama/LM Studio etc.). One generation call returns chat message(s) plus optionally piggybacked tail sections parsed from the raw text: `---NOTES---` (session memory), `---PROFILE---` (cross-stream memory), `---MOMENT---` (highlight flag). Messages are parsed as `NAME: text` lines against the cast roster, hard-capped at 2.

Supporting modules, each a single class/concern: `src/cast.js` (roster resolution, ghost color palette, archetypes, 2.x `bot`/`bot2` → 3.x `cast` migration), `src/config.js` (deep-merge loader — see below), `src/obs.js` (obs-websocket screenshots + overlay install, reconnect backoff), `src/transcript.js` (`TranscriptFeed` — tails LocalVocal .txt/.srt output by byte offset, or polls an OBS text source; instantiated twice: streamer mic + optional party/co-op channel, which is "other people" and never triggers a voice reply), `src/twitch.js` (read-only stream info + viewer count: Helix when app credentials are set, keyless DecAPI fallback with just a channel name otherwise), `src/twitchchat.js` (anonymous read-only IRC to detect active real chat), `src/tts.js` (Windows SAPI speech synthesis via PowerShell → WAV, used when TTS routes to a specific output device — the browser's speechSynthesis can't pick one; static scripts + env-var/temp-file data passing, so no user text is ever interpolated into code), `src/models.js` (model catalog + per-message cost — the UI dropdowns build from this, so adding a model is one edit).

**Frontend** (`public/`) is four self-contained vanilla HTML pages connecting over the WebSocket. `theme.css` owns all tokens and shared components; each page's `<style>` block holds **layout only** — if a rule would help a second page, it moves to theme.css.

## Config

`config.example.json` is the **single source of defaults**, deep-merged under the user's `config.json` at load (`src/config.js` — never throws; bad JSON degrades to defaults with a warning). Every new setting therefore goes into `config.example.json` with a sane default, plus a row in the README config-reference table. `config.json` holds the API key and is gitignored — never commit it. One migration quirk: `loadConfig` nulls out the example's `cast` when the user's config has none of its own, so `resolveCast()` rebuilds from their legacy `bot`/`bot2` instead of silently replacing customized ghosts.

## Non-negotiables

- **Ethics (product-defining):** every cast message carries the `🤖 AI` badge and the overlay keeps its permanent "simulated viewers" watermark — never restyled, shrunk, or made optional. Nothing ever posts to real Twitch chat or affects stream metrics; all Twitch access is read-only.
- **Security posture:** the server listens on 127.0.0.1 only, validates the Host header (DNS-rebinding defense), and checks WebSocket Origin. The API key is never sent to the UI (`/api/config` redacts it; a blank key on save means "keep the saved one"; `/api/overlay-config` exposes only what the overlay needs). Don't weaken any of this.
- **Design:** UI changes follow `DESIGN.md`. Load-bearing rule: violet (`--accent`) is the human; ghosts use the ghost palette (`aqua rose mint gold coral sky`) via the `--gc` custom property — never hardcoded hex, never violet. Motion must have a job and respect `prefers-reduced-motion`. Emoji are the icon system (one per concept, see the DESIGN.md table).
- **Resource posture:** the app shares a machine with OBS and a game — software rendering, below-normal priority, renderer destroyed when closed to tray. Keep new features cheap by default (e.g. screenshot-gap skipping, relaxed polls).
