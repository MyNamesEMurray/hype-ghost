# Hype Ghost Roadmap 👻

Planning document for the 2.0 release and beyond. Order within a phase ≠ commitment.

## Shipped in 1.x

- ✅ **Auto-update** (1.4.0) — electron-updater against GitHub Releases; toggle in Settings → App.
- ✅ **One-click overlay install** (1.4.0) — Settings → Stream → "Add overlay to OBS".
- ✅ **Cost meter** (1.4.0) — live session $/tokens pill on the dashboard.
- ✅ **Talking points** (1.4.0) — streamer-provided topics worked in naturally.
- ✅ **Game awareness, part 1** (1.4.0) — current OBS scene name + standing stream context in every generation. *(Remaining: per-game memory/vocabulary.)*
- ✅ **Multi-language, part 1** (1.4.0) — the ghost chats in `bot.language`. *(Remaining: UI translation.)*
- ✅ **Auto-pause dead-man switch** (1.5.0) — stops API spend when OBS has been gone for N minutes; auto-resumes.
- ✅ **Security hardening** (1.5.0) — WebSocket origin allowlist, Host-header check, API key never leaves the server, external links open in the real browser.
- ✅ **Design system** (1.5.0) — shared theme.css + written design language (DESIGN.md).

## 2.0 — "The room gets real"

### 1. Dual AI chatters
Two distinct personas that react to the stream **and to each other**. Different names,
overlay colors, personalities, and attention (one watches gameplay closely, one lurks and
jokes). Design constraints:
- Single API call per cycle generates the next message (with a chosen speaker) or an
  occasional short 2–3 message exchange released with staggered human-ish delays — cost
  stays roughly flat vs. one chatter.
- Hard banter cap: max one bot-to-bot reply without streamer input in between. The streamer
  is the show, not the audience.
- Shared session-notes memory, separate voices.

### 2. Local & free brains (provider abstraction)
Remove the hard requirement for a paid Anthropic key. Provider setting:
- **Anthropic** (current default — best quality)
- **Local via Ollama / LM Studio** (OpenAI-compatible endpoint at localhost) — the privacy
  option and the $0 option. Small vision models (Gemma 3, Qwen-VL, Llama 3.2 Vision) are
  adequate for short chat messages; low cadence tolerates slow generation. Caveat to
  document: GPU contention while gaming/streaming — recommend small quantized models.
- **Custom OpenAI-compatible URL** — unlocks free cloud tiers (Gemini, Groq, OpenRouter
  free variants). Caveat to document honestly: free tiers generally may train on your data;
  free ≠ private. Local is the privacy corner, free-tier is the budget corner.
Setup wizard should branch on "I don't want to pay / I want everything local."
Prep already done: the model catalog lives in src/models.js and the UI builds its
dropdowns from the server, so adding providers is one surface, not five.

### 3. Cross-stream memory
Promote session notes to a rolling per-channel profile so the ghost remembers previous
streams ("did you ever beat that boss from Tuesday?"). Small effort, outsized realism.

## 2.1+ — pick a lane (co-host / content tool / practice coach)

- **Real Twitch chat awareness** *(read-only, never posts)* — go quiet when chat is
  *active* rather than when viewer count is nonzero; lurker-heavy streams keep their ghost.
- **TTS co-host mode** — ghost messages spoken aloud (local Piper = free/private,
  ElevenLabs = premium quality). Clearly optional; changes the product's vibe.
- **Post-stream recap** — session notes → markdown recap + rough VOD chapter timestamps.
- **Game awareness, part 2** — per-game memory and vocabulary.
- **Overlay customization** — position, size, themes, message fade-out timer, emote images
  instead of emote text.
- **Multi-language, part 2** — UI translation.
- **Code signing / distribution** — kill the SmartScreen warning (cert ~$100+/yr) or
  explore MS Store.

## Principles (unchanged from 1.x)
- Local-only: never touches real Twitch chat, never affects metrics.
- Every message clearly labeled AI; the ghost never pretends to be human.
- The streamer is the show. Features that make the ghost the star are wrong.
- Visual/copy rules live in [DESIGN.md](DESIGN.md) — changes follow the design language.
