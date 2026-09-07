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
unsigned; click **More info → Run anyway**. The installer is a normal wizard: pick where the
program goes (per-user by default — no admin needed — or per-machine), desktop/start-menu
shortcuts included, and auto-updates keep working either way. You'll need your own
[Anthropic API key](https://console.anthropic.com) (~$0.20/hour of streaming) and OBS 28+.

(Building from source instead? Run the installer out of `dist/` after `npm run dist`.) On first launch, a **setup wizard**
walks you through everything: what you want out of Hype Ghost, the ghost's name and
personality, your Anthropic API key (with a live "test key" button), the OBS connection
(with a live connection test), message cadence, and optional extras (voice awareness,
Twitch viewer detection). Re-run it anytime from the tray → **Run Setup Wizard**.

Just want a look around first? The brain step has a **"Skip this step"** link — the app
then opens in **preview mode**: the full deck, settings, and overlay to explore, zero cost,
but the cast stays quiet until you connect a brain (Settings → Brain). A key isn't required
to poke around; the free local-model route (Ollama / LM Studio) never needs one at all.

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
  Settings → App). When an update is ready you choose: **Restart now**, **Later** (from the
  tray menu, or it installs when you quit), or **Skip this update** — a skipped version is
  never offered again (not even downloaded); you're only asked again when something newer
  is released. **Settings → App → Check for updates** looks right now, whether or not
  automatic checks are on — and because asking by hand is asking about the version you
  skipped too, it clears a skip rather than staying quiet about it.
- **Settings → About** shows the app version, the honesty/privacy rules at a glance, where
  your data lives, and **Reset to factory defaults** — wipes all settings and memory, then
  re-runs the setup wizard.
- **Game screen guide:** the cast learns how to *read* each game it watches — where the
  health bar is, what a death or menu screen looks like, where your webcam and alerts sit —
  and reuses it on later streams of that game. It writes this itself from screenshots it is
  already being shown, so it costs no extra API calls, and it sits in the cached part of the
  prompt. The point is reacting to game **state** ("your health is gone") rather than just
  appearance. It's plain text at **Settings → Stream → Screen guide**: read it, and edit it
  if it gets something wrong, because it's treated as truth on every message. Nothing is
  learned under a category that isn't one game (`Just Chatting`, `Music`, …) — see
  `memory.gameInfoSkip`.
- **Data folder:** settings, session memory, the cross-stream profile, and the app log
  (`hype-ghost.log`, rotating) live in `%APPDATA%\Hype Ghost` by default. **Settings →
  About → Move data folder…** relocates all of it to any folder you like (another drive, a
  synced folder); files are copied over, a small `storage.json` pointer in the default
  folder remembers the location, and **Back to default location** undoes it.
- **Voice awareness:** install the
  [LocalVocal](https://obsproject.com/forum/resources/localvocal-local-live-captions-translation-on-the-go.1769/)
  OBS plugin (local whisper.cpp — audio never leaves your PC), add its Transcription filter
  to your mic source, output to a text file or a (hidden) text source, and point the wizard's
  voice-awareness step (or the `transcript` config section) at it. Then answering the ghost
  out loud *is* replying. Everything it hears also shows up as faint 🎙 lines in the deck
  feed (toggle in Settings → Voice), so when the cast reacts oddly you can see exactly what
  the transcription thought you said.
- **Getting transcription accurate:** run **Settings → Voice → Mic check**. It hands you a
  short script built from your ghosts' names, your channel, and anything in
  `speech.vocabulary`; you read it out loud, and Hype Ghost lines it up against what
  LocalVocal actually heard. You get your real word error rate and one-click **word fixes**
  for the names it got wrong, applied to every transcript line from then on (live, no
  restart). It is a measurement, not training — nothing is uploaded and no model is
  modified. Tuning that helps *before* you get there, in order of impact:
  - **Paste in an initial prompt.** Whisper conditions its decoder on one, and proper nouns
    are exactly what it fumbles. **Settings → Voice → LocalVocal tuning → Show my settings**
    writes the prompt for you from your ghosts, your channel, the current game and
    `speech.vocabulary`; copy it into the Transcription filter's **Initial prompt** box.
    Costs nothing, needs no bigger model, and the mic check will show it in the number.
  - **Let it check its own setup.** **Settings → Voice → Voice health** reads the last stretch
    of transcript and names the LocalVocal setting behind what it sees — stuttering duplicate
    lines mean partial transcription is on, one- and two-word fragments mean the buffer is
    too short, filler in the silences means VAD is off.
  - **Use a bigger, English-only model.** LocalVocal defaults to `tiny.en`. Moving to
    `small.en` (or `medium.en` on a strong PC) is the single biggest accuracy win, and at
    equal size the `.en` models beat the multilingual ones for English.
  - **Trade latency for accuracy.** Most LocalVocal guides tune for snappy on-screen
    captions; that's the wrong target here. The cast speaks on a cadence of *minutes*, so a
    longer processing buffer costs you nothing and gives Whisper more context per chunk.
  - **Turn partial transcriptions off.** They write half-finished duplicate lines into the
    file Hype Ghost tails.
  - **Fix the audio first.** Noise suppression *before* the Transcription filter in the
    chain, and no game or music audio bleeding into the mic track — no model recovers from
    a dirty input.
  - **Fix mishears as they happen.** Click any 🎙 line in the deck feed, retype what you
    actually said, press Enter — the words that changed become permanent corrections and
    apply to the very next line, no save or restart. This is where the correction map
    really grows: the mic check covers names you can predict up front, this covers whatever
    a real stream throws at it. Re-running the mic check shows your past scores, so a
    LocalVocal change can be judged by a number instead of a feeling.
  - **Run a real speech-to-text engine instead** (`transcript.mode: "engine"`). Point Hype
    Ghost at a speech-to-text server running on your own PC (whisper.cpp's `server`,
    faster-whisper-server, WhisperLive) and it gets what LocalVocal cannot give it: voice
    activity detection, so silence never reaches the decoder to be hallucinated into filler;
    a per-line **confidence** score, so a line the engine isn't sure about is dropped rather
    than answered; and the initial prompt above wired in automatically instead of pasted.
    Loopback addresses only — audio still never leaves your machine. LocalVocal stays the
    default and nothing about the other modes changes.
  - Note the trade-off with the OBS crash below: the CPU backend is the safe one, and it's
    also what limits how big a model you can run. Move up model sizes until OBS starts
    struggling, then step back one.
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
| `app.updateChannel` | Which builds the auto-updater follows: `auto` (default — matches the build you're running, the long-standing behaviour), `stable`, or `beta` (early test builds). Beta builds are published as GitHub prereleases and stable installs never see them. Note a beta install won't return to stable by itself — a stable release only publishes to the stable feed — so `stable` is the deliberate way back, and the only case allowed to step the version down. |
| `app.autoUpdate` | Check GitHub for new versions at launch and update automatically (default true). Off still leaves **Settings → App → Check for updates** working, so you can look when you choose to. |
| `app.setupComplete` | Set by the setup wizard when you finish it (even via the brain step's "skip"). Once true, `/` opens the dashboard — without a brain that's **preview mode**: everything explorable, cast quiet, $0. |
| `app.costMeter` | Show the live session cost readout in the deck's top bar (default true). |
| `app.fontScale` | UI text size for the deck/settings/wizard: `1` default, `1.1` large, `1.25` extra large (Settings → App, applies live). Never shrinks below default, and the on-stream overlay is unaffected. |
| `app.ttsOutputDevice` | Which speaker/headphone spoken cast messages play on (Settings → App → 🔊, with a test button). Picking a specific device keeps chat out of your stream mix and off the VOD; that path speaks with Windows (SAPI) voices. Blank = system default device with browser voices. |
| `bot.language` | Language the whole cast chats in (default English). |
| `stream.context` | Standing context about your stream (game, format, vibe) the cast always knows. It also sees your current OBS scene name automatically. |
| `stream.autoInfo` | Pull your **live game/category and stream title from Twitch** and feed them to the cast every message (default true). Needs only your Twitch channel name (`twitch.channel`) — keyless via DecAPI, or your own app credentials if set. Works even while offline, since Twitch keeps your set title/category. |
| `stream.gameFromObs` | Fallback: guess the game from an OBS **Game/Window Capture** source's captured window when Twitch has no category (default true). |
| `talkingPoints` | Topics you want covered; the cast works one in occasionally when it fits naturally. |
| `anthropic.apiKey` | Anthropic API key (console.anthropic.com), or set `ANTHROPIC_API_KEY` env var. |
| `anthropic.model` | `claude-sonnet-5` is the sweet spot; `claude-haiku-4-5` ~3x cheaper, `claude-opus-5` ~1.7x pricier and chattiest. Any other model ID your key can reach also works — Settings → Brain → **Custom model ID…** (or just set it here), so a new release isn't gated behind an app update. It must be **vision-capable**, and the cost meter only prices the listed models: on anything else the deck shows a message count with no dollar figure. |
| `bot.name` / `bot.personality` | Legacy single-ghost fields, kept in sync with `cast[0]` for backward compatibility. |
| `obs.url` / `obs.password` | OBS WebSocket (default port 4455). |
| `obs.screenshotWidth` | Screenshot width in px (default 800). Image tokens scale with pixels (w×h÷750) — JPEG quality has no effect on tokens. |
| `twitch.channel` | *(Optional)* Your channel name — on its own it enables **read-only** viewer detection, chat awareness, and live game/title context, no developer app needed. Without it, use the dashboard's manual mode toggle. |
| `twitch.decapi` | Fetch viewer count + stream info keylessly via [DecAPI](https://decapi.me), a community-run Twitch API proxy (default true). Only your public channel name is sent to it. Set false to opt out. |
| `twitch.clientId` / `clientSecret` | *(Optional, power users)* App credentials from dev.twitch.tv — when set, the official Helix API is used directly instead of DecAPI. |
| `transcript.mode` | `off`, `file` (tail LocalVocal's .txt/.srt output), `textSource` (poll a text source over OBS WebSocket), or `engine` (connect to a local speech-to-text server you run — see `transcript.engineUrl`). |
| `transcript.showInFeed` | Echo what voice awareness hears into the deck feed as faint 🎙 lines (party audio as 🎧) so you can spot mishears the cast might be reacting to (default true). Deck only — never in the cast's chat history, the recap, or the on-stream overlay. |
| `transcript2.*` | *(Optional)* A **second** transcription channel for party/co-op audio (a separate audio device with its own LocalVocal filter). Same `mode`/`file`/`textSource`/`pollSeconds` as `transcript`, plus `label` — how the cast refers to those people (e.g. "my co-op squad"). Treated as *other people*, never as the streamer. |
| `speech.dropHallucinations` | Discard speech-to-text filler — "Thank you.", "Thanks for watching!", "please subscribe", words stuck on repeat (default true). Whisper invents these during near-silence, which is most of a mic-only track: the pauses between sentences, breaths, keyboard, room tone. Matched whole-line only, so a real sentence containing those words survives. Applies to both channels. |
| `transcript.engineUrl` | Engine mode only: the loopback WebSocket URL of a local speech-to-text server (default `ws://127.0.0.1:9090`). Non-loopback URLs are refused — the audio-never-leaves-your-PC promise is not negotiable. |
| `transcript.engineMinConfidence` | Engine mode only: drop a line the engine reports below this confidence, 0–1 (default 0.5). A line with no confidence reported is always kept, since unknown is not the same as bad. 0 keeps everything. |
| `speech.matchVocabulary` | Rewrite a transcript word that *sounds* like a tracked name (ghosts, channel, game, `speech.vocabulary`) to that name, even when the mic check never saw that mangling (default true). Names of four letters or more only, and only on a genuine phonetic match, so ordinary speech is untouched. `speech.corrections` is applied first and always wins. |
| `speech.corrections` | Word fixes applied to every transcript line before the cast sees it: `[{ "from": "bacon", "to": "Beacon" }]`. Whole words only, case-insensitive; a blank `to` deletes the phrase. Build this from **Settings → Voice → Mic check**, or by hand. Applies live on save. |
| `memory.gameInfoEvery` | How often (in cast messages) the cast refreshes its **screen guide** for the current game — what the HUD means, what a death screen looks like, where your overlay sits (default 8). Written as a tail section on generations that are already happening, so it costs no extra API calls. Stored per game in `game-notes.json` and reused on later streams; view and edit it at Settings → Stream. |
| `memory.gameInfoSkip` | Categories that aren't a single game — `Just Chatting`, `Music`, `IRL` and friends, pre-filled with the common Twitch ones. No screen guide is learned, stored, or read under these, because one keyed to "Just Chatting" would blend every game played beneath it and describe none of them. Whole-name match, case- and space-insensitive (so `Music` skips but `Music Racer` doesn't). Add your own if a Window Capture reports something like a browser as the "game". |
| `speech.vocabulary` | Extra proper nouns worth getting right — the game, in-jokes, regulars' names. Your ghosts' names and `twitch.channel` are included automatically. Used to build the mic-check script, and told to the cast so it reads a near-miss as the real word. |
| `cadence.soloSeconds` / `quietSeconds` | Average gap between messages when alone / when real viewers are present. |
| `cadence.jitter`, `burstChance`, `lullChance` | Natural rhythm: ±jitter on normal gaps, occasional quick bursts (0.3–0.6x) and long lulls (1.6–3x). |
| `cadence.voiceReplyRequiresAddress` | Only spend a voice reply when the cast is actually addressed — a ghost named out loud, or a prompt answer to a question one just asked (default true). Most stream talk is narration, and replying to all of it fires an extra generation after nearly every message; turning this off restores the old behaviour and roughly doubles cost on a talkative stream. Undirected speech still reaches the cast — it's in the transcript the next scheduled message reads. |
| `cadence.voiceReplyDelaySeconds` | How long after you stop talking a voice reply lands (default 8). |
| `cadence.voiceReplyWindowSeconds` | How recent the cast's last message must be for your speech to count as answering it (default 120). |
| `cadence.voiceAnswerWindowSeconds` | How soon after a ghost's *question* your speech still counts as answering it (default 30). Short on purpose: the curious archetype ends a lot of messages with "?", so a generous window would match nearly everything. |
| `cadence.minScreenshotGapSeconds` | Skip re-screenshotting on quick follow-ups (default 25). |
| `cadence.transcriptWindowSeconds` | How much recent mic speech the ghost hears (default 120). |
| `memory.enabled` / `memory.updateEvery` | Rolling session memory: every N messages the model refreshes a <100-word stream summary, kept as context in every call. Persists across restarts (`session-notes.txt`, ignored after 6h). |

## Cost

~$0.005 per message on Sonnet 5 (screenshot ~480 tokens at 800px + system prompt +
history/transcript/notes). At a 90s solo cadence that's ~40 messages/hour ≈ **$0.20/hour**.
The dashboard's cost pill shows the real number live, and if OBS disappears for 10 minutes
the ghost **auto-pauses** so a forgotten tray app can't burn money overnight — it resumes
by itself when OBS is back (Settings → App).

**Message count, not per-message price, is usually what makes a bill surprising.** Three things
multiply it: the **energy dial** (100 shortens every gap to ~0.45x, more than doubling volume),
**voice replies** (see `cadence.voiceReplyRequiresAddress`), and the model itself (Opus is ~1.7x
Sonnet, ~5x Haiku). Hover the cost pill for the token split — the share of input served from
cache, and output-tokens-per-message. A one-line chat message is ~60 output tokens, so a number
far above that means thinking is doing the spending.

Current-generation models think by default, and thinking tokens bill at output rates — on a
one-line chat message that is mostly waste, so the app pins **`effort: low`** for models that
accept it (the 5-series and Opus 4.8). It doesn't turn thinking off: a single generation can
also be merging session notes or the screen guide, and disabling it risks reasoning leaking
into text that goes on the stream overlay. A **custom model ID** never receives the setting —
there is no way to know whether an unknown model accepts it, so it may cost more per message.

## Privacy & security

Screenshots of your stream and (if enabled) your mic transcript go to the Anthropic API to
generate messages, and nowhere else. Speech-to-text runs entirely locally inside OBS.
The local server binds to 127.0.0.1 only, validates the Host header, and rejects WebSocket
connections from foreign origins, so other websites can't peek at your chat or transcript.
Two honest notes: your API key is stored **unencrypted** in `%APPDATA%\Hype Ghost\config.json`
(treat that folder like a password, and note it survives uninstall), and auto-updates are
**unsigned** — they're only as trustworthy as the GitHub account that publishes them.
Nothing is sent to Twitch except the optional read-only viewer-count check. If a Twitch
channel is set without app credentials, your (public) channel name is sent to
[DecAPI](https://decapi.me) — a community-run, read-only Twitch API proxy — to fetch the
viewer count and stream title/category; set `twitch.decapi: false` to opt out.

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
