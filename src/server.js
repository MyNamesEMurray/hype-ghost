import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { OBSWebSocket } from 'obs-websocket-js';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, isPlainObject } from './config.js';
import { MODELS, messageCost } from './models.js';
import { resolveCast, GHOST_COLORS, ARCHETYPES, ACCENT_COLORS } from './cast.js';
import { ObsCapture } from './obs.js';
import { Brain } from './brain.js';
import { TwitchViewers, DecApi } from './twitch.js';
import { TwitchChat } from './twitchchat.js';
import { TranscriptFeed } from './transcript.js';
import { GhostLoop } from './loop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');

/**
 * Start the Hype Ghost server.
 *
 * @param {Object} [opts]
 * @param {string} [opts.configPath]     where the user's config.json lives (writable location)
 * @param {string} [opts.notesPath]      where rolling session notes persist
 * @param {string} [opts.publicDir]      static assets dir
 * @param {() => void} [opts.onConfigSaved]   setup/settings saved config (host should restart)
 * @param {() => void} [opts.onPauseChanged]  pause state changed (host should refresh tray)
 * @param {(err: Error) => void} [opts.onFatal]  unrecoverable server error (e.g. port in use)
 * @param {() => Promise<string|null>} [opts.pickFile]  native file dialog (desktop app only)
 * @returns {{ port: number, pause(): void, resume(): void, isPaused(): boolean }}
 */
export function startServer(opts = {}) {
  const configPath = opts.configPath ?? path.join(packageRoot, 'config.json');
  const notesPath = opts.notesPath ?? path.join(packageRoot, 'session-notes.txt');
  const publicDir = opts.publicDir ?? path.join(packageRoot, 'public');

  // ---------- config (defaults deep-merged from config.example.json) ----------
  const { config, warning } = loadConfig(configPath);
  if (warning) console.warn(`[config] ${warning}`);
  const apiKey = config.anthropic.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const port = config.port;
  const usingAnthropic = config.brain.provider !== 'openai';
  // "Brain is configured" gates the wizard redirect: Anthropic needs a key,
  // an OpenAI-compatible endpoint just needs a model name.
  const brainReady = usingAnthropic ? Boolean(apiKey) : Boolean(config.brain.openaiModel);

  // The cast: 1–4 simulated viewers, resolved from the 3.x `cast` roster (or
  // migrated from a 2.x bot/bot2 config). Each carries a stage color.
  const cast = resolveCast(config);
  const personas = cast.map((c) => ({ name: c.name, personality: c.personality }));
  const castColor = new Map(cast.map((c) => [c.name, c.hex]));

  const obs = new ObsCapture(config.obs.url, config.obs.password, config.obs.screenshotWidth);
  const twitch = new TwitchViewers(config.twitch);
  // Keyless fallback: with only a channel name (no dev-app credentials),
  // stream info + viewer count come from DecAPI instead of Helix.
  const decapi = new DecApi({ channel: config.twitch.channel, enabled: config.twitch.decapi !== false });
  // Helix wins when credentials are set; DecAPI otherwise; null = manual mode.
  const viewerSource = twitch.configured() ? twitch : decapi.configured() ? decapi : null;
  const brain = new Brain({
    brain: config.brain,
    anthropic: config.anthropic,
    personas,
    language: config.bot.language,
  });

  // ---------- state ----------
  const state = {
    paused: false,
    autoPaused: false,
    viewerOverride: 'auto', // 'auto' | 'solo' | 'viewers'
    realViewers: null,
    mode: 'solo',
    obsConnected: false,
    apiKeySet: brainReady,
    twitchConfigured: Boolean(viewerSource), // automatic viewer detection available
    botName: config.bot.name,
    personas: personas.map((p) => p.name),
    cast: cast.map((c) => ({ name: c.name, color: c.hex, colorKey: c.colorKey })),
    energy: Number.isFinite(config.energy) ? config.energy : 55,
    accent: config.theme?.accent || 'violet',
    chatPerMin: null, // real Twitch chat messages/min (null = not listening)
    nextMessageAt: null,
    busy: false,
    transcriptMode: config.transcript.mode,
    lastHeard: null,
    transcript2Mode: config.transcript2?.mode || 'off',
    lastHeardParty: null,
    streamInfo: null, // { title, game, source } — live game/title for ghost context
    costMeter: config.app.costMeter !== false,
    tts: { enabled: config.app.tts === true, voice: config.app.ttsVoice, rate: config.app.ttsRate },
    uiLanguage: config.app.uiLanguage || 'en',
    usage: { messages: 0, inputTokens: 0, outputTokens: 0, cost: 0, costKnown: true },
  };
  const history = []; // {id, author, role: 'bot'|'streamer', text, ts}
  const MAX_HISTORY = 40;
  const highlights = []; // {label, ts} — clip-worthy moments the cast flagged
  const MAX_HIGHLIGHTS = 40;

  // ---------- session persistence ----------
  // Saving config can relaunch the whole app, and moments are the recap's VOD
  // chapters — a mid-stream settings tweak must not wipe them (or the chat
  // log, cost meter, and session clock). Same freshness rule as session
  // notes: a file older than 6h is a previous stream, not this one.
  const sessionPath = opts.sessionPath ?? path.join(path.dirname(notesPath), 'session.json');
  let startedAt = Date.now();
  try {
    if (existsSync(sessionPath) && Date.now() - statSync(sessionPath).mtimeMs < 6 * 3600_000) {
      const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
      if (Number.isFinite(saved.startedAt)) startedAt = saved.startedAt;
      if (Array.isArray(saved.history)) history.push(...saved.history.slice(-MAX_HISTORY));
      if (Array.isArray(saved.highlights)) highlights.push(...saved.highlights.slice(-MAX_HIGHLIGHTS));
      if (saved.usage) Object.assign(state.usage, saved.usage);
      if (history.length || highlights.length) console.log('[session] restored chat + moments from a recent run.');
    }
  } catch {}
  state.startedAt = startedAt; // the deck's clock and moment timestamps key off this
  function saveSession() {
    try {
      writeFileSync(sessionPath, JSON.stringify({ startedAt, history, highlights, usage: state.usage }));
    } catch {}
  }

  function resolveMode() {
    if (state.viewerOverride === 'solo') return 'solo';
    if (state.viewerOverride === 'viewers') return 'viewers';
    // Active real chat is a stronger "hang back" signal than raw viewer
    // count — lurker-heavy streams keep their ghost.
    if (chatMonitor && chatMonitor.isActive()) return 'viewers';
    return state.realViewers && state.realViewers > 0 ? 'viewers' : 'solo';
  }

  // ---------- rolling session memory + long-term profile ----------
  let sessionNotes = '';
  try {
    if (existsSync(notesPath) && Date.now() - statSync(notesPath).mtimeMs < 6 * 3600_000) {
      sessionNotes = readFileSync(notesPath, 'utf8').trim();
      if (sessionNotes) console.log('[memory] restored session notes from a recent run.');
    }
  } catch {}
  // Cross-stream memory: never goes stale — "did you ever beat that boss
  // from Tuesday?" is the whole point.
  const profilePath = opts.profilePath ?? path.join(path.dirname(notesPath), 'profile.md');
  let profile = '';
  try {
    if (existsSync(profilePath)) {
      profile = readFileSync(profilePath, 'utf8').trim();
      if (profile) console.log('[memory] loaded cross-stream profile.');
    }
  } catch {}

  // ---------- web server ----------
  const app = express();
  app.use(express.json());
  // Host allowlist: defends the localhost API (which holds secrets) against
  // DNS-rebinding pages that become "same-origin" with 127.0.0.1.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  app.use((req, res, next) => {
    if (allowedHosts.has(req.headers.host)) return next();
    res.status(403).end('forbidden');
  });
  app.use(express.static(publicDir));
  // First launch (no API key yet) lands on the setup wizard instead of the dashboard.
  app.get('/', (_req, res) => {
    if (!state.apiKeySet) return res.redirect('/setup');
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });
  app.get('/overlay', (_req, res) => res.sendFile(path.join(publicDir, 'overlay.html')));
  app.get('/setup', (_req, res) => res.sendFile(path.join(publicDir, 'setup.html')));
  app.get('/settings', (_req, res) => res.sendFile(path.join(publicDir, 'settings.html')));

  // ---------- config API (localhost only; see Host allowlist above) ----------
  app.get('/api/config', (_req, res) => {
    // Never hand out secrets — the UI only needs to know one is saved.
    const redacted = {
      ...config,
      anthropic: { ...config.anthropic, apiKey: '' },
      brain: { ...config.brain, openaiApiKey: '' },
      twitch: { ...config.twitch, clientSecret: '' },
    };
    res.json({
      config: redacted,
      configPath,
      firstRun: !state.apiKeySet,
      apiKeySaved: Boolean(config.anthropic.apiKey),
      openaiKeySaved: Boolean(config.brain.openaiApiKey),
      twitchSecretSaved: Boolean(config.twitch.clientSecret),
      models: MODELS,
      // The cast editor builds itself from these: the resolved roster (so 2.x
      // configs show their migrated ghosts), the color palette, and archetypes.
      cast: cast.map((c) => ({ name: c.name, personality: c.personality, color: c.colorKey, archetype: c.archetype })),
      palette: GHOST_COLORS,
      archetypes: ARCHETYPES,
      accents: ACCENT_COLORS,
      canRestart: Boolean(opts.onConfigSaved),
    });
  });

  // Settings nothing captures at construction time can apply live — no app
  // relaunch mid-stream. Everything wired at startup (brain, cast, OBS,
  // transcripts, Twitch, port) still restarts.
  const HOT_PATHS = [
    'energy', 'talkingPoints', 'theme.', 'overlay.', 'moments.', 'memory.', 'stream.',
    'app.costMeter', 'app.uiLanguage', 'app.autoPause', 'app.autoPauseMinutes', 'app.autoUpdate',
    'cadence.soloSeconds', 'cadence.quietSeconds', 'cadence.jitter', 'cadence.burstChance',
    'cadence.lullChance', 'cadence.replyDelaySeconds', 'cadence.minVoiceReplyGapSeconds',
    'cadence.minScreenshotGapSeconds', 'cadence.minPartyNudgeGapSeconds',
  ];
  const isHotPath = (p) => HOT_PATHS.some((h) => (h.endsWith('.') ? p.startsWith(h) : p === h));

  function deepEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    if (isPlainObject(a) && isPlainObject(b)) {
      const ka = Object.keys(a).filter((k) => a[k] !== undefined);
      const kb = Object.keys(b).filter((k) => b[k] !== undefined);
      return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
    }
    return false;
  }

  function changedPaths(a, b, prefix = '') {
    const paths = [];
    for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
      const va = a?.[key];
      const vb = b?.[key];
      const p = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(va) && isPlainObject(vb)) paths.push(...changedPaths(va, vb, p));
      else if (!deepEqual(va, vb)) paths.push(p);
    }
    return paths;
  }

  function deepAssign(target, src) {
    for (const [key, value] of Object.entries(src)) {
      if (isPlainObject(value) && isPlainObject(target[key])) deepAssign(target[key], value);
      else target[key] = value;
    }
  }

  function applyHotConfig(next) {
    deepAssign(config, next); // in place — the loop and pushMoment hold this same object
    state.accent = config.theme?.accent || 'violet';
    state.costMeter = config.app.costMeter !== false;
    state.uiLanguage = config.app.uiLanguage || 'en';
    broadcast({ type: 'config' }); // overlay clients re-fetch /api/overlay-config
    broadcastState();
    console.log('[config] saved — applied live, no restart needed.');
  }

  app.post('/api/config', (req, res) => {
    try {
      const next = req.body;
      if (!next || typeof next !== 'object' || !next.anthropic) {
        return res.status(400).json({ ok: false, error: 'invalid config payload' });
      }
      // Blank secrets in the payload mean "keep the saved one" (the UI never sees them).
      if (!next.anthropic.apiKey && config.anthropic.apiKey) {
        next.anthropic.apiKey = config.anthropic.apiKey;
      }
      if (next.brain && !next.brain.openaiApiKey && config.brain.openaiApiKey) {
        next.brain.openaiApiKey = config.brain.openaiApiKey;
      }
      if (next.twitch && !next.twitch.clientSecret && config.twitch.clientSecret) {
        next.twitch.clientSecret = config.twitch.clientSecret;
      }
      writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
      if (changedPaths(config, next).every(isHotPath)) {
        applyHotConfig(next);
        return res.json({ ok: true, applied: true });
      }
      res.json({ ok: true, restarting: Boolean(opts.onConfigSaved) });
      // Give the response time to flush, then let the host app restart to apply.
      setTimeout(() => {
        if (opts.onConfigSaved) opts.onConfigSaved();
        else console.log('[config] saved — restart the server to apply.');
      }, 400);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/test-key', async (req, res) => {
    try {
      if (req.body.provider === 'openai') {
        // Cheap reachability + model-list check for Ollama/LM Studio/etc.
        const base = String(req.body.baseUrl || config.brain.openaiBaseUrl).replace(/\/+$/, '');
        const key = String(req.body.apiKey || '') || config.brain.openaiApiKey;
        const r = await fetch(`${base}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(10_000), // Node fetch never times out on its own
        });
        if (!r.ok) throw new Error(`${base} returned ${r.status}`);
        const data = await r.json().catch(() => null);
        const wanted = String(req.body.model || config.brain.openaiModel);
        const ids = data?.data?.map((m) => m.id) ?? [];
        const found = !ids.length || ids.some((id) => id === wanted || id.startsWith(wanted));
        return res.json({
          ok: true,
          note: found ? undefined : `endpoint reachable, but model "${wanted}" was not in its list`,
        });
      }
      // Blank key tests the saved one (Settings shows the key only as "saved").
      const key = String(req.body.apiKey || '') || config.anthropic.apiKey;
      const client = new Anthropic({ apiKey: key });
      await client.messages.create({
        model: String(req.body.model || config.anthropic.model),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // Overlay reads only what it needs — never the full config (which holds secrets).
  app.get('/api/overlay-config', (_req, res) => {
    res.json({ overlay: config.overlay, personas: state.personas, cast: state.cast, accent: state.accent, accents: ACCENT_COLORS });
  });

  // Post-stream recap: session notes + timestamped chat log as markdown.
  app.get('/api/recap', (_req, res) => {
    const started = new Date(startedAt);
    const mins = Math.round((Date.now() - startedAt) / 60000);
    const fmt = (ts) => {
      const m = Math.floor((ts - startedAt) / 60000);
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    const lines = [
      `# Stream recap — ${started.toLocaleDateString()} ${started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      '',
      `Session: ${mins} min · ${state.usage.messages} ghost messages` +
        (state.costMeter && state.usage.costKnown ? ` · $${state.usage.cost.toFixed(3)}` : ''),
      '',
      '## Session notes',
      '',
      sessionNotes || '_(none yet)_',
      '',
      '## Moments (VOD chapters)',
      '',
      ...(highlights.length
        ? highlights.map((m) => `- \`${fmt(m.ts)}\` ${m.label}`)
        : ['_(no clip-worthy moments flagged this session)_']),
      '',
      '## Chat log',
      '',
      ...history.map((m) => `- \`${fmt(m.ts)}\` **${m.author}**: ${m.text}`),
      '',
      '_Generated by Hype Ghost — all "viewer" messages are simulated AI._',
    ];
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hype-ghost-recap-${started.toISOString().slice(0, 10)}.md"`);
    res.send(lines.join('\n'));
  });

  app.post('/api/test-obs', async (req, res) => {
    const probe = new OBSWebSocket();
    try {
      await probe.connect(String(req.body.url || config.obs.url), req.body.password || undefined);
      const { currentProgramSceneName } = await probe.call('GetCurrentProgramScene');
      res.json({ ok: true, scene: currentProgramSceneName });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    } finally {
      try {
        await probe.disconnect();
      } catch {}
    }
  });

  app.post('/api/install-overlay', async (_req, res) => {
    try {
      const result = await obs.installOverlay(`http://localhost:${port}/overlay`);
      state.obsConnected = obs.connected;
      res.json({ ok: true, ...result });
    } catch (err) {
      res.json({
        ok: false,
        error: 'Could not reach OBS — is it running with the WebSocket server enabled? (' + err.message + ')',
      });
    }
  });

  app.post('/api/pick-file', async (_req, res) => {
    if (!opts.pickFile) {
      return res.json({ ok: false, error: 'File browsing is only available in the desktop app — paste the path instead.' });
    }
    try {
      const picked = await opts.pickFile();
      res.json({ ok: true, path: picked });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  function pushMessage(role, author, text) {
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), role, author, text, ts: Date.now() };
    if (role === 'bot') {
      msg.p = Math.max(0, state.personas.indexOf(author)); // persona index (kept for back-compat)
      msg.color = castColor.get(author) || cast[0]?.hex; // stage color for this ghost
    }
    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    broadcast({ type: 'chat', msg });
    saveSession();
    return msg;
  }

  function pushMoment(label) {
    const moment = { label: String(label).slice(0, 60), ts: Date.now() };
    highlights.push(moment);
    if (highlights.length > MAX_HIGHLIGHTS) highlights.shift();
    broadcast({ type: 'moment', moment });
    console.log('[moment]', moment.label);
    // Moment clipping: if OBS is running a replay buffer, the ✨ becomes an
    // actual clip on disk. Best-effort — a no-op when the buffer is off.
    if (config.moments?.saveReplay !== false) {
      obs.saveReplay().then((saved) => {
        if (saved) console.log('[moment] OBS replay buffer saved.');
      });
    }
    saveSession();
    return moment;
  }

  function broadcastState() {
    state.mode = resolveMode();
    state.obsConnected = obs.connected;
    Object.assign(state, loop.snapshot());
    broadcast({ type: 'state', state });
  }

  // ---------- mic transcript (LocalVocal OBS plugin) ----------
  const transcriptFeed = new TranscriptFeed({
    ...config.transcript,
    windowSeconds: config.cadence.transcriptWindowSeconds,
    obs,
    onSpeech: (line) => {
      state.lastHeard = { text: line, ts: Date.now() };
      broadcastState();
      loop.onSpeech();
    },
  });

  // ---------- party transcript (a SECOND LocalVocal channel for co-op audio) ----------
  // A separate audio device (Discord/party/co-op) transcribed by its own LocalVocal
  // filter. Unlike the streamer's mic, this is OTHER people — it never triggers a
  // "the streamer answered me" reply; it's ambient context the cast can acknowledge.
  const partyFeed = new TranscriptFeed({
    ...config.transcript2,
    windowSeconds: config.cadence.transcriptWindowSeconds,
    obs,
    onSpeech: (line) => {
      state.lastHeardParty = { text: line, ts: Date.now() };
      broadcastState();
      loop.onPartySpeech();
    },
  });

  // ---------- the ghost ----------
  const loop = new GhostLoop({
    config,
    brain,
    obs,
    transcriptFeed,
    partyFeed,
    hooks: {
      getMode: resolveMode,
      getStreamInfo: () => state.streamInfo,
      getHistory: () => history,
      onMessage: (speaker, text) => pushMessage('bot', speaker || state.botName, text),
      onSystem: (text) => broadcast({ type: 'system', text }),
      onState: () => {
        broadcastState();
        if (opts.onPauseChanged) opts.onPauseChanged();
      },
      getNotes: () => sessionNotes,
      setNotes: (notes) => {
        sessionNotes = notes;
        try {
          writeFileSync(notesPath, sessionNotes + '\n');
        } catch {}
        console.log('[memory] session notes updated:', sessionNotes.replace(/\s+/g, ' ').slice(0, 100) + '…');
      },
      onMoment: (label) => pushMoment(label),
      getProfile: () => profile,
      setProfile: (next) => {
        profile = next;
        try {
          writeFileSync(profilePath, profile + '\n');
        } catch {}
        console.log('[memory] cross-stream profile updated.');
      },
      addUsage: (usage) => {
        const cost = messageCost(config.anthropic.model, usage);
        state.usage.messages++;
        state.usage.inputTokens +=
          (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        state.usage.outputTokens += usage.output_tokens || 0;
        if (cost === null) state.usage.costKnown = false;
        else state.usage.cost += cost;
        saveSession();
      },
    },
  });

  // ---------- websocket: dashboard + overlay clients ----------
  wss.on('connection', (ws, req) => {
    // Origin allowlist: browsers always send Origin on ws handshakes, so this
    // blocks any webpage from reading chat/mic-transcript state or injecting
    // messages, while keeping non-browser clients (no Origin) usable.
    const origin = req.headers.origin;
    const originOk = !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
    if (!originOk) {
      ws.close();
      return;
    }
    ws.send(JSON.stringify({ type: 'init', state, history, highlights, accents: ACCENT_COLORS }));
    ws.on('message', (raw) => {
      let cmd;
      try {
        cmd = JSON.parse(raw);
      } catch {
        return;
      }
      switch (cmd.type) {
        case 'streamer_message': {
          const text = String(cmd.text || '').trim();
          if (!text) return;
          pushMessage('streamer', 'Streamer', text);
          loop.onStreamerMessage();
          break;
        }
        case 'pause':
          loop.pause();
          break;
        case 'resume':
          loop.resume();
          break;
        case 'nudge':
          loop.nudge();
          break;
        case 'set_energy':
          loop.setEnergy(cmd.value);
          state.energy = loop.energy;
          broadcastState();
          break;
        case 'override_viewers':
          if (['auto', 'solo', 'viewers'].includes(cmd.value)) {
            state.viewerOverride = cmd.value;
            loop.scheduleNext();
          }
          break;
      }
    });
  });

  // ---------- twitch chat awareness (read-only, anonymous) ----------
  let chatMonitor = null;
  if (config.twitch.channel && config.twitch.chatAwareness !== false) {
    const updateChatActivity = (perMin) => {
      const prevMode = state.mode;
      state.chatPerMin = Math.round(perMin * 10) / 10;
      if (resolveMode() !== prevMode) loop.scheduleNext();
      else broadcastState();
    };
    chatMonitor = new TwitchChat({ channel: config.twitch.channel, onActivity: updateChatActivity });
    chatMonitor.start();
    // onActivity only fires on new messages, so once chat goes quiet the
    // deck's chat orb would freeze at its last reading — let the decay show.
    // (Mode resolution is unaffected: resolveMode() asks isActive() live.)
    setInterval(() => {
      if (state.chatPerMin === null) return; // nothing heard yet — orb stays hidden
      const perMin = chatMonitor.perMinute();
      if (Math.round(perMin * 10) / 10 !== state.chatPerMin) updateChatActivity(perMin);
    }, 30_000);
  }

  // ---------- twitch viewer polling (Helix, or keyless DecAPI) ----------
  if (viewerSource) {
    const poll = async () => {
      const count = await viewerSource.getViewerCount();
      if (count !== null) {
        const prevMode = resolveMode();
        state.realViewers = count;
        const newMode = resolveMode();
        if (prevMode !== newMode) {
          console.log(`[twitch] mode change: ${prevMode} -> ${newMode} (${count} viewers)`);
          loop.scheduleNext();
        } else {
          broadcastState();
        }
      }
    };
    poll();
    setInterval(poll, config.cadence.viewerPollSeconds * 1000);
    console.log(`[twitch] viewer detection via ${viewerSource === twitch ? 'Helix (app credentials)' : 'DecAPI (keyless)'}.`);
  } else {
    console.log('[twitch] no channel configured — use the Solo/Viewers mode on the dashboard.');
  }

  // ---------- live stream info (game + title) for ghost context ----------
  // Twitch is the source of truth for title + category; OBS's Game/Window
  // Capture provides a game fallback when Twitch isn't configured (or has no
  // category set). The result feeds every generation so the cast always knows
  // what's actually being played.
  async function refreshStreamInfo() {
    // Read the flags live — stream.* is hot-applied from Settings without a restart.
    const autoInfo = config.stream?.autoInfo !== false;
    const gameFromObs = config.stream?.gameFromObs !== false;
    let title = '';
    let game = '';
    let source = null;
    // Same tiering as viewer polling: Helix if credentialed, else DecAPI.
    const infoSource = twitch.configured() ? twitch : decapi.configured() ? decapi : null;
    if (autoInfo && infoSource) {
      const info = await infoSource.getChannelInfo();
      if (info) {
        title = info.title || '';
        game = info.game || '';
        source = 'twitch';
      }
    }
    if (!game && gameFromObs) {
      const hint = await obs.getGameHint();
      if (hint) {
        game = hint;
        source = source || 'obs';
      }
    }
    const next = title || game ? { title, game, source } : null;
    if (JSON.stringify(next) !== JSON.stringify(state.streamInfo)) {
      state.streamInfo = next;
      if (next) console.log(`[stream] ${next.game || '(no game)'}${next.title ? ' — "' + next.title + '"' : ''} (${next.source})`);
      broadcastState();
    }
  }
  refreshStreamInfo();
  // Title/category change rarely — a relaxed poll keeps it fresh without cost.
  // Always registered (it's a no-op network-wise with both flags off) so a
  // hot-applied enable starts working without a restart.
  setInterval(refreshStreamInfo, Math.max(60, config.cadence.viewerPollSeconds) * 1000 * 1.5);

  // ---------- mic transcript polling ----------
  if (state.transcriptMode !== 'off') {
    transcriptFeed.start();
  } else {
    console.log('[transcript] off — enable voice awareness in Settings → Voice to let the ghost hear you.');
  }
  if (state.transcript2Mode !== 'off') {
    partyFeed.start();
    console.log('[transcript] party channel on — a second LocalVocal source is being read for co-op audio.');
  }

  // ---------- start ----------
  // listen() failures (port in use) arrive async via 'error' — without this
  // handler they'd bypass the caller's try/catch and hard-crash the app.
  httpServer.on('error', (err) => {
    const friendly =
      err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use — is Hype Ghost already running?`
        : `Server error: ${err.message}`;
    if (opts.onFatal) opts.onFatal(new Error(friendly));
    else {
      console.error(friendly);
      process.exit(1);
    }
  });
  // 127.0.0.1 only: the config API holds secrets — never listen on the LAN.
  // OBS's browser source runs on this machine anyway.
  httpServer.listen(port, '127.0.0.1', () => {
    console.log('');
    console.log(`  Hype Ghost is running (local only)`);
    console.log(`  Dashboard (your chat window): http://localhost:${port}/`);
    console.log(`  OBS Browser Source overlay:   http://localhost:${port}/overlay`);
    console.log('');
    if (!state.apiKeySet) console.warn('  ⚠ No Anthropic API key set — open the dashboard to run the setup wizard.');
    loop.start();
  });

  return {
    port,
    pause: () => loop.pause(),
    resume: () => loop.resume(),
    isPaused: () => loop.isPaused(),
  };
}
