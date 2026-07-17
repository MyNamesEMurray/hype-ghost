import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { OBSWebSocket } from 'obs-websocket-js';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './config.js';
import { MODELS, messageCost } from './models.js';
import { ObsCapture } from './obs.js';
import { Brain } from './brain.js';
import { TwitchViewers } from './twitch.js';
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

  const obs = new ObsCapture(config.obs.url, config.obs.password, config.obs.screenshotWidth);
  const twitch = new TwitchViewers(config.twitch);
  const brain = new Brain({
    apiKey,
    model: config.anthropic.model,
    botName: config.bot.name,
    personality: config.bot.personality,
    language: config.bot.language,
    streamContext: config.stream?.context || '',
  });

  // ---------- state ----------
  const state = {
    paused: false,
    autoPaused: false,
    pauseReason: null,
    viewerOverride: 'auto', // 'auto' | 'solo' | 'viewers'
    realViewers: null,
    mode: 'solo',
    obsConnected: false,
    apiKeySet: Boolean(apiKey),
    twitchConfigured: twitch.configured(),
    botName: config.bot.name,
    nextMessageAt: null,
    busy: false,
    transcriptMode: config.transcript.mode,
    lastHeard: null,
    costMeter: config.app.costMeter !== false,
    usage: { messages: 0, inputTokens: 0, outputTokens: 0, cost: 0, costKnown: true },
  };

  const history = []; // {id, author, role: 'bot'|'streamer', text, ts}
  const MAX_HISTORY = 40;

  function resolveMode() {
    if (state.viewerOverride === 'solo') return 'solo';
    if (state.viewerOverride === 'viewers') return 'viewers';
    return state.realViewers && state.realViewers > 0 ? 'viewers' : 'solo';
  }

  // ---------- rolling session memory ----------
  let sessionNotes = '';
  try {
    if (existsSync(notesPath) && Date.now() - statSync(notesPath).mtimeMs < 6 * 3600_000) {
      sessionNotes = readFileSync(notesPath, 'utf8').trim();
      if (sessionNotes) console.log('[memory] restored session notes from a recent run.');
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
    // Never hand out secrets — the UI only needs to know they're saved.
    const redacted = {
      ...config,
      anthropic: { ...config.anthropic, apiKey: '' },
      obs: { ...config.obs, password: '' },
      twitch: { ...config.twitch, clientSecret: '' },
    };
    res.json({
      config: redacted,
      configPath,
      firstRun: !state.apiKeySet,
      apiKeySaved: Boolean(config.anthropic.apiKey),
      obsPasswordSaved: Boolean(config.obs.password),
      twitchSecretSaved: Boolean(config.twitch.clientSecret),
      models: MODELS,
      canRestart: Boolean(opts.onConfigSaved),
    });
  });

  app.post('/api/config', (req, res) => {
    try {
      const next = req.body;
      if (!next || typeof next !== 'object' || !next.anthropic) {
        return res.status(400).json({ ok: false, error: 'invalid config payload' });
      }
      // A blank secret in the payload means "keep the saved one" (the UI
      // never sees saved secrets — GET /api/config redacts them).
      if (!next.anthropic.apiKey && config.anthropic.apiKey) {
        next.anthropic.apiKey = config.anthropic.apiKey;
      }
      if (next.obs && !next.obs.password && config.obs.password) {
        next.obs.password = config.obs.password;
      }
      if (next.twitch && !next.twitch.clientSecret && config.twitch.clientSecret) {
        next.twitch.clientSecret = config.twitch.clientSecret;
      }
      writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
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

  app.post('/api/test-obs', async (req, res) => {
    const probe = new OBSWebSocket();
    try {
      // Blank password tests the saved one (mirrors the test-key contract —
      // the UI only ever sees "saved", never the secret itself).
      const password = String(req.body.password ?? '') || config.obs.password || undefined;
      await probe.connect(String(req.body.url || config.obs.url), password);
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
    history.push(msg);
    if (history.length > MAX_HISTORY) history.shift();
    broadcast({ type: 'chat', msg });
    return msg;
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

  // ---------- the ghost ----------
  const loop = new GhostLoop({
    config,
    brain,
    obs,
    transcriptFeed,
    hooks: {
      getMode: resolveMode,
      getHistory: () => history,
      onMessage: (text) => pushMessage('bot', state.botName, text),
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
      addUsage: (usage) => {
        const cost = messageCost(config.anthropic.model, usage);
        state.usage.messages++;
        state.usage.inputTokens +=
          (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        state.usage.outputTokens += usage.output_tokens || 0;
        if (cost === null) {
          state.usage.costKnown = false;
          return;
        }
        const before = state.usage.cost;
        state.usage.cost += cost;
        // Soft cost cap: pause once, when the session spend crosses the
        // line. Resuming is an explicit override — it won't re-trigger.
        const cap = Number(config.app.costCapDollars) || 0;
        if (cap > 0 && state.usage.costKnown && before < cap && state.usage.cost >= cap) {
          loop.pauseFor(
            'cost',
            `Session cost reached the $${cap.toFixed(2)} cap — the ghost paused itself. Raise the cap in Settings → App, or resume from the dashboard to keep going.`
          );
        }
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
    ws.send(JSON.stringify({ type: 'init', state, history }));
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
        case 'override_viewers':
          if (['auto', 'solo', 'viewers'].includes(cmd.value)) {
            state.viewerOverride = cmd.value;
            loop.scheduleNext();
          }
          break;
      }
    });
  });

  // ---------- twitch viewer polling ----------
  if (twitch.configured()) {
    const poll = async () => {
      const count = await twitch.getViewerCount();
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
  } else {
    console.log('[twitch] not configured — use the Solo/Viewers mode on the dashboard.');
  }

  // ---------- mic transcript polling ----------
  if (state.transcriptMode !== 'off') {
    transcriptFeed.start();
  } else {
    console.log('[transcript] off — enable voice awareness in Settings → Voice to let the ghost hear you.');
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
    // No key = no brain: start paused instead of failing a generation every
    // cadence tick while the user is still in the setup wizard.
    if (state.apiKeySet) {
      loop.start();
    } else {
      console.warn('  ⚠ No Anthropic API key set — open the dashboard to run the setup wizard.');
      loop.pause();
    }
  });

  return {
    port,
    pause: () => loop.pause(),
    resume: () => loop.resume(),
    isPaused: () => loop.isPaused(),
  };
}
