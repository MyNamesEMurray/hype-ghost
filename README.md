# Hype Ghost 👻

A **local-only simulated AI viewer** for streamers. It watches your OBS output like a real
viewer would — screenshots of your live scene, plus a local transcription of your mic — and
chats with you through a desktop app + an on-stream overlay, so you practice talking to chat
even when nobody is watching.

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

**Tray menu:** Open Dashboard · Copy Overlay URL (for OBS) · Pause Ghost · Run Setup Wizard ·
Edit Config · Start with Windows · Quit.

## Setup notes

- The wizard covers the essentials; every setting lives in `%APPDATA%\Hype Ghost\config.json`
  (tray → **Edit Config**) — full reference below.
- **Overlay:** in OBS, add a **Browser Source** with URL `http://localhost:3777/overlay`,
  ~460×600, transparent background. This puts the chat on your stream/VOD.
- **Voice awareness:** install the
  [LocalVocal](https://obsproject.com/forum/resources/localvocal-local-live-captions-translation-on-the-go.1769/)
  OBS plugin (local whisper.cpp — audio never leaves your PC), add its Transcription filter
  to your mic source, output to a text file or a (hidden) text source, and point the wizard's
  voice-awareness step (or the `transcript` config section) at it. Then answering the ghost
  out loud *is* replying.

## Config reference

| Setting | What it is |
|---|---|
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

~$0.005 per message on Sonnet 5 (screenshot ~480 tokens at 800px + cached system prompt +
history/transcript/notes). At a 90s solo cadence that's ~40 messages/hour ≈ **$0.20/hour**.

## Privacy

Screenshots of your stream and (if enabled) your mic transcript go to the Anthropic API to
generate messages, and nowhere else. Speech-to-text runs entirely locally inside OBS.
Nothing is sent to Twitch except the optional read-only viewer-count check.

## Development

```
npm install
npm start        # desktop app (uses config.json in this folder)
npm run serve    # headless server only, no window/tray
npm run icons    # regenerate icon.ico / PNGs from assets/*.svg
npm run dist     # build the Windows installer into dist/
```
