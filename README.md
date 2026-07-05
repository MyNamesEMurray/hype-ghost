# Hype Ghost 👻

**Local-only simulated AI viewers** for streamers. One or two "ghosts" watch your OBS output
like real viewers — screenshots of your live scene, plus a local transcription of your mic —
and chat with you through a desktop app + an on-stream overlay, so you practice talking to
chat even when nobody is watching.

2.0 highlights: a second ghost persona (they riff on each other, capped so you stay the
show), **local/free brains** (Ollama, LM Studio, or any OpenAI-compatible endpoint — no API
key required), cross-stream memory ("did you ever beat that boss from Tuesday?"), read-only
Twitch chat awareness, spoken messages (local TTS), post-stream recap export, overlay
customization, and a Spanish dashboard. Resource posture: software rendering, below-normal
process priority, and the UI unloads entirely when closed to tray — OBS and your game come
first.

**What it is NOT:**
- It never connects to your Twitch chat (nothing is posted anywhere).
- It never counts as a viewer or affects stream metrics in any way.
- It never pretends to be human — every message is labeled `🤖 AI` and the overlay carries a
  permanent "simulated viewer" watermark, so real viewers and VOD watchers are never misled.

## Install

**[⬇ Download the latest installer](https://github.com/MyNamesEMurray/hype-ghost/releases/latest)** — grab
`Hype Ghost Setup <version>.exe`. Windows SmartScreen will warn because the installer is
unsigned; click **More info → Run anyway**. You'll need your own
[Anthropic API key](https://console.anthropic.com) (~$0.20/hour of streaming) and OBS 28+.

(Building from source instead? Run the installer out of `dist/` after `npm run dist`.) On first launch, a **setup wizard**
walks you through everything: what you want out of Hype Ghost, the ghost's name and
personality, your Anthropic API key (with a live "test key" button), the OBS connection
(with a live connection test), message cadence, and optional extras (voice awareness,
Twitch viewer detection). Re-run it anytime from the tray → **Run Setup Wizard**.

Closing the window **minimizes to the system tray** — the ghost keeps chatting until you
Quit from the tray menu.

**Tray menu:** Open Dashboard · Copy Overlay URL (for OBS) · Pause Ghost · Settings ·
Run Setup Wizard · Edit Config (raw JSON) · Open Config Folder · Start with Windows ·
Quit Hype Ghost.

## Setup notes

- The wizard covers the essentials; for everything else there's a full **Settings** page
  (⚙ in the dashboard, or tray → **Settings**) with live API-key and OBS connection tests.
  Under the hood it's all `%APPDATA%\Hype Ghost\config.json` — full reference below.
- **Overlay:** Settings → Stream → **Add overlay to OBS** creates the browser source for you
  (or add one manually: URL `http://localhost:3777/overlay`, ~460×600, transparent). This
  puts the chat on your stream/VOD.
- **Updates:** the app checks GitHub Releases at launch and updates itself (toggle in
  Settings → App).
- **Voice awareness:** install the
  [LocalVocal](https://obsproject.com/forum/resources/localvocal-local-live-captions-translation-on-the-go.1769/)
  OBS plugin (local whisper.cpp — audio never leaves your PC), add its Transcription filter
  to your mic source, output to a text file or a (hidden) text source, and point the wizard's
  voice-awareness step (or the `transcript` config section) at it. Then answering the ghost
  out loud *is* replying.

## Config reference

| Setting | What it is |
|---|---|
| `app.autoUpdate` | Check GitHub for new versions at launch and update automatically (default true). |
| `app.costMeter` | Show the live session cost pill on the dashboard (default true). |
| `bot.language` | Language the ghost chats in (default English). |
| `stream.context` | Standing context about your stream (game, format, vibe) the ghost always knows. It also sees your current OBS scene name automatically. |
| `talkingPoints` | Topics you want covered; the ghost works one in occasionally when it fits naturally. |
| `anthropic.apiKey` | Anthropic API key (console.anthropic.com), or set `ANTHROPIC_API_KEY` env var. |
| `anthropic.model` | `claude-sonnet-5` is the sweet spot; `claude-haiku-4-5` ~3x cheaper, `claude-opus-4-8` ~3x pricier and chattiest. |
| `bot.name` / `bot.personality` | The ghost's chat name and vibe. |
| `obs.url` / `obs.password` | OBS WebSocket (default port 4455). |
| `obs.screenshotWidth` | Screenshot width in px (default 800). Image tokens scale with pixels (w×h÷750) — JPEG quality has no effect on tokens. |
| `twitch.*` | *(Optional)* App credentials + channel, used **read-only** for live viewer count. Without it, use the dashboard's manual mode toggle. |
| `transcript.mode` | `off`, `file` (tail LocalVocal's .txt/.srt output), or `textSource` (poll a text source over OBS WebSocket). |
| `cadence.soloSeconds` / `quietSeconds` | Average gap between messages when alone / when real viewers are present. |
| `cadence.jitter`, `burstChance`, `lullChance` | Natural rhythm: ±jitter on normal gaps, occasional quick bursts (0.3–0.6x) and long lulls (1.6–3x). |
| `cadence.minScreenshotGapSeconds` | Skip re-screenshotting on quick follow-ups (default 25). |
| `cadence.transcriptWindowSeconds` | How much recent mic speech the ghost hears (default 120). |
| `memory.enabled` / `memory.updateEvery` | Rolling session memory: every N messages the model refreshes a <100-word stream summary, kept as context in every call. Persists across restarts (`session-notes.txt`, ignored after 6h). |

## Cost

~$0.005 per message on Sonnet 5 (screenshot ~480 tokens at 800px + system prompt +
history/transcript/notes). At a 90s solo cadence that's ~40 messages/hour ≈ **$0.20/hour**.
The dashboard's cost pill shows the real number live, and if OBS disappears for 10 minutes
the ghost **auto-pauses** so a forgotten tray app can't burn money overnight — it resumes
by itself when OBS is back (Settings → App).

## Privacy & security

Screenshots of your stream and (if enabled) your mic transcript go to the Anthropic API to
generate messages, and nowhere else. Speech-to-text runs entirely locally inside OBS.
The local server binds to 127.0.0.1 only, validates the Host header, and rejects WebSocket
connections from foreign origins, so other websites can't peek at your chat or transcript.
Two honest notes: your API key is stored **unencrypted** in `%APPDATA%\Hype Ghost\config.json`
(treat that folder like a password, and note it survives uninstall), and auto-updates are
**unsigned** — they're only as trustworthy as the GitHub account that publishes them.
Nothing is sent to Twitch except the optional read-only viewer-count check.

## Development

```
npm install
npm start        # desktop app (uses config.json in this folder)
npm run serve    # headless server only, no window/tray
npm run icons    # regenerate icon.ico / PNGs from assets/*.svg
npm run dist     # build the Windows installer into dist/
```
