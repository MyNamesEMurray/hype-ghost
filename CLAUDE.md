# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hype Ghost is a local-only simulated AI viewer for streamers: it screenshots the user's OBS output, optionally reads a local mic transcription, and generates short Twitch-style chat messages via the Anthropic API, shown in a desktop dashboard and an OBS browser-source overlay. Product ethics are hard constraints, not preferences: it never touches real Twitch chat (the Twitch client is read-only viewer count), every bot message is labeled 🤖 AI with a permanent overlay watermark, and the streamer — not the ghost — is the show. Features that violate these are wrong by definition (see ROADMAP.md "Principles").

## Commands

```
npm install
npm start        # desktop app via Electron (dev: config.json + session-notes.txt live in the project root)
npm run serve    # headless server only (node src/cli.js), no window/tray
npm run icons    # regenerate build/icon.ico + assets PNGs from assets/*.svg
npm run dist     # electron-builder --win → NSIS installer in dist/
```

- `npm test` runs the `node:test` suite in `test/` (loop timing/circuit-breaker, transcript tailing, config sanitization, cost math, response parsing) — no network, OBS, or fake-timer dependencies; run a single file with `node --test test/loop.test.js`. There is no linter. The end-to-end check is smoke mode: `HG_SMOKE=1 npm start` boots the app headless, fetches the dashboard, and exits 0/1. CI (`.github/workflows/ci.yml`) runs both on Windows, and builds the installer on `v*` tags.
- ESM throughout (`"type": "module"`), Node >= 18, no build/bundle step — `public/` is served as-is.
- The app targets Windows (tray, NSIS, %APPDATA%), but `npm run serve` works anywhere for development.

## Architecture

Two entry points converge on one function: `electron/main.js` (desktop shell: tray, window, auto-update, single-instance lock, native file picker) and `src/cli.js` (headless) both call `startServer()` in `src/server.js`.

`src/server.js` is the composition root and the only place state lives. It owns the Express + WebSocket server on `127.0.0.1:<port>` (default 3777), the chat history, the mode resolution (solo vs viewers), session-notes persistence, and the cost meter. It wires the other modules together and hands `GhostLoop` a `hooks` object for everything host-side (getHistory, onMessage, getNotes, addUsage, …). The Electron shell likewise passes hooks into `startServer` (`onConfigSaved`, `onPauseChanged`, `onFatal`, `pickFile`) — this hook-injection pattern is how the modules stay decoupled and headless-capable.

The pieces, each deliberately single-purpose:

- **`src/loop.js` — GhostLoop**: the timing state machine, extracted so the hardest-to-reason-about logic is in one place. Owns when to speak and why (`trigger`: `timer` | `reply` | `nudge` | `voice`), cadence with jitter/burst/lull, the busy flag, voice-reply debounce with a rate floor, screenshot-gap and idle-scene (BRB/starting-soon) skipping (the image is the biggest per-message token cost), the auto-pause dead-man switch (OBS unreachable N minutes → pause API spend; auto-resumes), and the API-failure circuit breaker (5 consecutive generation failures → auto-pause). All app-initiated pauses go through `pauseFor(reason, …)` — the dashboard shows the reason. Touch timing behavior here, not in the server.
- **`src/brain.js` — Brain**: one Anthropic messages call per chat message. The system prompt encodes the persona and chat-realism rules; message variety is enforced by a weighted style pool in code, not by hoping. Session-notes updates piggyback on a normal generation via a `---NOTES---` delimiter in the same response — there is no separate memory call. The system prompt is deliberately verbose: its length must clear the model's minimum cacheable prefix (~1024 tokens) for prompt caching to engage (a test enforces the floor) — keep per-message content out of it, and don't trim it.
- **`src/config.js`**: `config.example.json` is the single source of config defaults, deep-merged under the user's file. Loading never throws — bad/missing config degrades to defaults with a warning, and every numeric value is type-checked and clamped to the same ranges the Settings UI enforces (a NaN cadence would fire timers instantly and burn money). Add any new config key to `config.example.json` first; that *is* the schema — and give numeric keys a `NUMERIC_LIMITS` entry.
- **`src/models.js`**: single source of truth for the model catalog (ids, labels, $/MTok). The setup wizard and Settings build their model dropdowns from this via `GET /api/config` — adding a model is one edit here, no UI change.
- **`src/obs.js` — ObsCapture**: obs-websocket wrapper for program-scene screenshots, the one-click overlay install, and reading a text source (LocalVocal captions). Dedupes concurrent connects and backs off 30s when OBS is closed — callers just call `screenshot()`/`ensureConnected()` and get null/throw on failure.
- **`src/transcript.js` — TranscriptFeed**: ingests the LocalVocal mic transcription, either tailing a file by byte offset (with rewrite detection and partial-line carry) or polling an OBS text source. Keeps a rolling time window; `onSpeech` is what lets the ghost hear a spoken answer (`loop.onSpeech()`).
- **`src/twitch.js` — TwitchViewers**: read-only Helix viewer count so the ghost goes quiet when real people watch. Never chat, ever.

**Frontend** (`public/`): four plain HTML pages (dashboard, overlay, setup wizard, settings) with no framework and no build. They connect to the server's WebSocket (message types: `init`, `chat`, `state`, `system`) and send commands (`streamer_message`, `pause`, `resume`, `nudge`, `override_viewers`); config editing goes through REST `/api/config` and the `/api/test-*` endpoints. `theme.css` owns all tokens and shared components; a page's `<style>` block may contain layout only — if a rule would help a second page, it belongs in theme.css.

**Config & data paths**: packaged app uses `%APPDATA%/Hype Ghost/` for `config.json` + `session-notes.txt`; dev (`npm start`/`serve`) uses the project root. Saving config from the UI restarts the whole app (Electron relaunches; headless just logs) — there is no hot-reload of config, so don't build partial-apply logic.

## Security invariants (do not weaken)

- The server binds to `127.0.0.1` only, validates the `Host` header against a localhost allowlist (DNS-rebinding defense), and rejects WebSocket upgrades from foreign `Origin`s. The config API holds the unencrypted Anthropic key, so this surface is what protects it.
- Secrets never leave the server: `GET /api/config` redacts the Anthropic key, OBS password, and Twitch client secret (with `*Saved` flags so the UI can say "saved ✓"), and a blank secret in a `POST /api/config` payload means "keep the saved one" (the test endpoints follow the same contract). Preserve both halves when touching config endpoints.
- In Electron, external links open in the real browser (`setWindowOpenHandler` + `will-navigate` guard), never in the chrome-less app window.

## Design language

DESIGN.md is authoritative for every UI/copy change — if a change doesn't fit it, the change is wrong or DESIGN.md needs a deliberate update first. The load-bearing rules: purple `--accent` is the streamer/actions (only one purple thing per screen), blue `--ghost` is everything the AI says or is, the `🤖 AI` badge and overlay watermark are never restyled/shrunk/dimmed, no hex colors outside theme.css, sentence case everywhere, emoji are the icon system (one emoji per concept, from the table in DESIGN.md), and the overlay stays transparent, non-interactive, and legible over video. Copy speaks as "the ghost", never "the bot"/"the AI assistant".
