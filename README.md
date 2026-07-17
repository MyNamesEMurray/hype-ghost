# Hype Ghost 👻

**Local-only simulated AI viewers** for streamers. A *cast* of "ghosts" watch your OBS output
like real viewers — screenshots of your live scene, plus a local transcription of your mic —
and chat with you through a desktop app + an on-stream overlay, so you practice talking to
chat even when nobody is watching.

**3.0 — "The Green Room"** is a ground-up reimagining of the interface. The old chat window
becomes a **Command Deck**: a stage of your cast, a live feed, an **energy dial**, and a
highlight reel — the console you direct your simulated room from.

3.0 highlights:
- **The Cast** — up to **four** ghosts (was two), each with its own name, personality
  archetype, and stage color. They react to the stream and to each other; you're always the
  show. Edit the whole roster on Settings → Cast.
- **The energy dial** — one live control on the deck scales how often the cast talks *and*
  their whole mood, from 🌙 chill to 🔥 electric, mid-stream, no settings trip.
- **Moments** — the cast auto-flags genuinely clip-worthy plays into a highlight reel on the
  deck, a ✨ pop on the overlay, and **VOD chapter markers** in your recap export.
- **Command palette** — ⌘/Ctrl-K for pause, energy, mode, overlay URL, recap, and more.
- **A new look** — glass panels, a signature aurora, accent themes, per-ghost colors, and
  purposeful motion, in a studio-at-night dark theme.

Carried over from 2.x: **local/free brains** (Ollama, LM Studio, or any OpenAI-compatible
endpoint — no API key required), cross-stream memory ("did you ever beat that boss from
Tuesday?"), read-only Twitch chat awareness, spoken messages (local TTS), overlay
customization, and a Spanish interface. Resource posture: software rendering, below-normal
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
- **Party / co-op audio (second channel):** streaming alongside friends? Route their audio
  (Discord/TeamSpeak/party chat) to a separate OBS source, add a *second* LocalVocal
  Transcription filter to it, output to a **different** file/text source than your mic, and
  point Settings → Voice → **Second channel** (`transcript2`) at it. The cast then hears your
  co-op partners as *other people* — it can acknowledge them ("nice shot Jordan") without ever
  mistaking them for you. It's ambient context, so it never triggers a "you answered me" reply.

## Config reference

| Setting | What it is |
|---|---|
| `cast` | The roster: 1–4 ghosts, each `{ name, personality, color, enabled }`. Colors: `aqua rose mint gold coral sky` (violet is reserved for you). Edit on Settings → Cast. A 2.x config with no `cast` is migrated from `bot`/`bot2` automatically. |
| `energy` | Default room energy 0–100 (default 55). The deck's live energy dial overrides this per session; low = calmer/slower, high = livelier/faster. |
| `moments.enabled` | Let the cast flag clip-worthy plays into the highlight reel + recap VOD chapters (default true). |
| `moments.saveReplay` | When a moment is flagged and OBS's **replay buffer** is running, save it — the ✨ becomes an actual clip on disk (default true; a no-op if the buffer is off). |
| `theme.accent` | Your (the human's) accent color on the deck: `violet cyan emerald amber magenta` (default violet). |
| `overlay.theme` / `overlay.reactions` | Overlay style (`cards` or `compact`) and whether a ✨ moment pop shows on the overlay. |
| `app.autoUpdate` | Check GitHub for new versions at launch and update automatically (default true). |
| `app.costMeter` | Show the live session cost readout in the deck's top bar (default true). |
| `bot.language` | Language the whole cast chats in (default English). |
| `stream.context` | Standing context about your stream (game, format, vibe) the cast always knows. It also sees your current OBS scene name automatically. |
| `stream.autoInfo` | Pull your **live game/category and stream title from Twitch** and feed them to the cast every message (default true). Uses your Twitch channel + app credentials (`twitch.*`). Works even while offline, since Twitch keeps your set title/category. |
| `stream.gameFromObs` | Fallback: guess the game from an OBS **Game/Window Capture** source's captured window when Twitch has no category (default true). |
| `talkingPoints` | Topics you want covered; the cast works one in occasionally when it fits naturally. |
| `anthropic.apiKey` | Anthropic API key (console.anthropic.com), or set `ANTHROPIC_API_KEY` env var. |
| `anthropic.model` | `claude-sonnet-5` is the sweet spot; `claude-haiku-4-5` ~3x cheaper, `claude-opus-4-8` ~3x pricier and chattiest. |
| `bot.name` / `bot.personality` | Legacy single-ghost fields, kept in sync with `cast[0]` for backward compatibility. |
| `obs.url` / `obs.password` | OBS WebSocket (default port 4455). |
| `obs.screenshotWidth` | Screenshot width in px (default 800). Image tokens scale with pixels (w×h÷750) — JPEG quality has no effect on tokens. |
| `twitch.*` | *(Optional)* App credentials + channel, used **read-only** for live viewer count. Without it, use the dashboard's manual mode toggle. |
| `transcript.mode` | `off`, `file` (tail LocalVocal's .txt/.srt output), or `textSource` (poll a text source over OBS WebSocket). |
| `transcript2.*` | *(Optional)* A **second** transcription channel for party/co-op audio (a separate audio device with its own LocalVocal filter). Same `mode`/`file`/`textSource`/`pollSeconds` as `transcript`, plus `label` — how the cast refers to those people (e.g. "my co-op squad"). Treated as *other people*, never as the streamer. |
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

## Troubleshooting

**OBS crashes when I switch Scene Collections (but Safe Mode works).**
This is a crash **inside the third-party [LocalVocal](https://obsproject.com/forum/resources/localvocal-local-live-captions-translation-on-the-go.1769/) plugin**, not Hype Ghost. Hype Ghost never loads into the OBS process — its only OBS footprint is an inert browser-source overlay, which still loads fine in Safe Mode. The crash report points at `obs-localvocal.dll` faulting inside its ggml/whisper backend (`ggml_backend_load_best`) as OBS re-creates LocalVocal's transcription filter while loading the collection (`ChangeSceneCollection → LoadAudioDevice → obs_source_create_internal`). Safe Mode disables third-party plugins, so LocalVocal never loads and the switch succeeds — which is what pinpoints LocalVocal as the cause. Fixes, in order:

1. **Update LocalVocal** to the newest build that matches your OBS version (its OBS-forum resource page / GitHub releases). A LocalVocal built for an older OBS is the usual cause on a newer OBS.
2. On an **OBS beta/nightly**, LocalVocal may not support it yet — run OBS stable, or remove LocalVocal until a compatible build ships.
3. **Remove the LocalVocal transcription filter** from your mic in the affected scene collection(s) (right-click the source → Filters → remove it), which stops the crashing backend from loading; re-add it after updating.
4. In LocalVocal's settings, prefer the **CPU** backend and a smaller model — GPU backend auto-selection (CUDA/Vulkan) is what faults in `ggml_backend_load_best`.

Voice awareness is **optional** in Hype Ghost. If you don't need it, skip LocalVocal entirely (Settings → Voice → Off) and everything else works — you just reply by typing instead of talking out loud.

## Development

```
npm install
npm start        # desktop app (uses config.json in this folder)
npm run serve    # headless server only, no window/tray
npm test         # node:test suite (test/*.test.js)
npm run icons    # regenerate icon.ico / PNGs from assets/*.svg
npm run dist     # build the Windows installer into dist/
```
