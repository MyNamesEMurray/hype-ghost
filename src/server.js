import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { OBSWebSocket } from 'obs-websocket-js';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ObsCapture } from './obs.js';
import { Brain } from './brain.js';
import { TwitchViewers } from './twitch.js';
import { TranscriptFeed } from './transcript.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');

/**
 * Start the Hype Ghost server.
 *
 * @param {Object} [opts]
 * @param {string} [opts.configPath]  where the user's config.json lives (writable location)
 * @param {string} [opts.notesPath]   where rolling session notes persist
 * @param {string} [opts.publicDir]   static assets dir
 * @param {() => void} [opts.onConfigSaved]  called after the setup wizard saves config (host should restart)
 * @returns {{ port: number, pause(): void, resume(): void, isPaused(): boolean }}
 */
export function startServer(opts = {}) {
  const configPath = opts.configPath ?? path.join(packageRoot, 'config.json');
  const examplePath = path.join(packageRoot, 'config.example.json');
  const notesPath = opts.notesPath ?? path.join(packageRoot, 'session-notes.txt');
  const publicDir = opts.publicDir ?? path.join(packageRoot, 'public');

  // ---------- config ----------
  if (!existsSync(configPath)) {
    console.warn(`[config] ${configPath} not found — using defaults from config.example.json.`);
  }
  const config = JSON.parse(readFileSync(existsSync(configPath) ? configPath : examplePath, 'utf8'));
  const apiKey = config.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY || '';

  const obs = new ObsCapture(config.obs.url, config.obs.password, config.obs.screenshotWidth);
  const twitch = new TwitchViewers(config.twitch || {});
  const brain = new Brain({
    apiKey,
    model: config.anthropic?.model || 'claude-sonnet-5',
    botName: config.bot?.name || 'Beacon',
    personality: config.bot?.personality || 'friendly and curious',
  });

  // ---------- state ----------
  const state = {
    paused: false,
    viewerOverride: 'auto', // 'auto' | 'solo' | 'viewers'
    realViewers: null,
    mode: 'solo',
    obsConnected: false,
    apiKeySet: Boolean(apiKey),
    twitchConfigured: twitch.configured(),
    botName: config.bot?.name || 'Beacon',
    nextMessageAt: null,
    busy: false,
    transcriptMode: config.transcript?.mode || 'off',
    lastHeard: null,
  };

  const history = []; // {id, author, role: 'bot'|'streamer', text, ts}
  const MAX_HISTORY = 40;

  function resolveMode() {
    if (state.viewerOverride === 'solo') return 'solo';
    if (state.viewerOverride === 'viewers') return 'viewers';
    return state.realViewers && state.realViewers > 0 ? 'viewers' : 'solo';
  }

  // ---------- rolling session memory ----------
  const memoryEnabled = config.memory?.enabled ?? true;
  const memoryUpdateEvery = config.memory?.updateEvery ?? 4;
  let sessionNotes = '';
  let botMessageCount = 0;
  try {
    if (existsSync(notesPath) && Date.now() - statSync(notesPath).mtimeMs < 6 * 3600_000) {
      sessionNotes = readFileSync(notesPath, 'utf8').trim();
      if (sessionNotes) console.log('[memory] restored session notes from a recent run.');
    }
  } catch {}

  // ---------- web server ----------
  const app = express();
  app.use(express.json());
  app.use(express.static(publicDir));
  // First launch (no API key yet) lands on the setup wizard instead of the dashboard.
  app.get('/', (_req, res) => {
    if (!state.apiKeySet) return res.redirect('/setup');
    res.sendFile(path.join(publicDir, 'dashboard.html'));
  });
  app.get('/overlay', (_req, res) => res.sendFile(path.join(publicDir, 'overlay.html')));
  app.get('/setup', (_req, res) => res.sendFile(path.join(publicDir, 'setup.html')));
  app.get('/settings', (_req, res) => res.sendFile(path.join(publicDir, 'settings.html')));

  // ---------- setup wizard API (localhost only — server binds 127.0.0.1) ----------
  app.get('/api/config', (_req, res) => {
    res.json({ config, configPath, firstRun: !state.apiKeySet });
  });

  app.post('/api/config', (req, res) => {
    try {
      const next = req.body;
      if (!next || typeof next !== 'object' || !next.anthropic) {
        return res.status(400).json({ ok: false, error: 'invalid config payload' });
      }
      writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
      res.json({ ok: true });
      // Give the response time to flush, then let the host app restart to apply.
      setTimeout(() => {
        if (opts.onConfigSaved) opts.onConfigSaved();
        else console.log('[config] saved — restart to apply changes.');
      }, 400);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/test-key', async (req, res) => {
    try {
      const client = new Anthropic({ apiKey: String(req.body.apiKey || '') });
      await client.messages.create({
        model: String(req.body.model || 'claude-sonnet-5'),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: err.message });
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

  app.post('/api/test-obs', async (req, res) => {
    const probe = new OBSWebSocket();
    try {
      await probe.connect(String(req.body.url || 'ws://127.0.0.1:4455'), req.body.password || undefined);
      const { currentProgramSceneName } = await probe.call('GetCurrentProgramScene');
      res.json({ ok: true, scene: currentProgramSceneName });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    } finally {
      try { await probe.disconnect(); } catch {}
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
    broadcast({ type: 'state', state });
  }

  // ---------- mic transcript (LocalVocal OBS plugin) ----------
  let voiceReplyTimer = null;
  let voiceRepliedTo = null;

  const transcriptFeed = new TranscriptFeed({
    ...(config.transcript || {}),
    windowSeconds: config.cadence.transcriptWindowSeconds ?? 120,
    obs,
    onSpeech: (line) => {
      state.lastHeard = { text: line, ts: Date.now() };
      broadcastState();
      const last = history[history.length - 1];
      const answerable =
        last && last.role === 'bot' && last.id !== voiceRepliedTo && Date.now() - last.ts < 120_000;
      if (answerable && !state.paused && !state.busy) {
        clearTimeout(voiceReplyTimer);
        voiceReplyTimer = setTimeout(() => {
          voiceRepliedTo = history[history.length - 1]?.id ?? null;
          clearTimeout(timer);
          speak('voice');
        }, 8000);
      }
    },
  });

  // ---------- bot loop ----------
  let timer = null;
  let lastShotAt = 0;

  // Real chat rhythm isn't uniform: mostly normal gaps (± jitter), but sometimes
  // a quick burst follow-up, and sometimes a long lull of dead air.
  function intervalMs() {
    const base = state.mode === 'viewers' ? config.cadence.quietSeconds : config.cadence.soloSeconds;
    const jitter = config.cadence.jitter ?? 0.35;
    const burstChance = config.cadence.burstChance ?? 0.15;
    const lullChance = config.cadence.lullChance ?? 0.15;
    const roll = Math.random();
    let factor;
    if (roll < burstChance) {
      factor = 0.3 + Math.random() * 0.3; // burst: 0.3–0.6x base
    } else if (roll < burstChance + lullChance) {
      factor = 1.6 + Math.random() * 1.4; // lull: 1.6–3x base
    } else {
      factor = 1 + (Math.random() * 2 - 1) * jitter; // normal: ± jitter
    }
    return Math.max(15, base * factor) * 1000;
  }

  function scheduleNext(msOverride) {
    clearTimeout(timer);
    if (state.paused) {
      state.nextMessageAt = null;
      broadcastState();
      return;
    }
    const ms = msOverride ?? intervalMs();
    state.nextMessageAt = Date.now() + ms;
    broadcastState();
    timer = setTimeout(() => speak('timer'), ms);
  }

  async function speak(trigger) {
    if (state.paused || state.busy) return;
    if (!state.apiKeySet) {
      broadcast({ type: 'system', text: 'No Anthropic API key configured — set it in config.json (tray menu → Edit Config).' });
      scheduleNext();
      return;
    }
    state.busy = true;
    broadcastState();
    try {
      // Skip the screenshot on rapid follow-ups — the scene hasn't meaningfully
      // changed, and the image is by far the biggest token cost per message.
      const minShotGapMs = (config.cadence.minScreenshotGapSeconds ?? 25) * 1000;
      let screenshot = null;
      let staleScreenshot = false;
      if (Date.now() - lastShotAt < minShotGapMs) {
        staleScreenshot = true;
      } else {
        screenshot = await obs.screenshot();
        state.obsConnected = obs.connected;
        if (screenshot) lastShotAt = Date.now();
      }
      const updateNotes = memoryEnabled && (botMessageCount + 1) % memoryUpdateEvery === 0;
      const result = await brain.generate({
        history: history.slice(-14),
        screenshot,
        staleScreenshot,
        mode: resolveMode(),
        trigger,
        transcript: transcriptFeed.getWindow() || undefined,
        notes: sessionNotes || undefined,
        updateNotes,
      });
      if (result.text) {
        pushMessage('bot', state.botName, result.text);
        botMessageCount++;
      }
      if (result.notes) {
        sessionNotes = result.notes;
        try { writeFileSync(notesPath, sessionNotes + '\n'); } catch {}
        console.log('[memory] session notes updated:', sessionNotes.replace(/\s+/g, ' ').slice(0, 100) + '…');
      }
    } catch (err) {
      console.error('[bot] generation failed:', err.message);
      broadcast({ type: 'system', text: `Message generation failed: ${err.message}` });
    } finally {
      state.busy = false;
      scheduleNext();
    }
  }

  // ---------- websocket commands from dashboard ----------
  wss.on('connection', (ws) => {
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
          scheduleNext((config.cadence.replyDelaySeconds ?? 6) * 1000);
          break;
        }
        case 'pause':
          state.paused = true;
          scheduleNext();
          break;
        case 'resume':
          state.paused = false;
          scheduleNext(3000);
          break;
        case 'nudge':
          clearTimeout(timer);
          speak('nudge');
          break;
        case 'override_viewers':
          if (['auto', 'solo', 'viewers'].includes(cmd.value)) {
            state.viewerOverride = cmd.value;
            scheduleNext();
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
          scheduleNext();
        } else {
          broadcastState();
        }
      }
    };
    poll();
    setInterval(poll, (config.cadence.viewerPollSeconds ?? 60) * 1000);
  } else {
    console.log('[twitch] not configured — use the Solo/Viewers override on the dashboard.');
  }

  // ---------- mic transcript polling ----------
  if (state.transcriptMode !== 'off') {
    transcriptFeed.start();
  } else {
    console.log('[transcript] off — enable it in config.json ("transcript") to let the ghost hear you.');
  }

  // ---------- start ----------
  const port = config.port ?? 3777;
  // 127.0.0.1 only: the wizard API exposes config (incl. the API key), so
  // never listen on the LAN. OBS's browser source is on this machine anyway.
  httpServer.listen(port, '127.0.0.1', () => {
    console.log('');
    console.log(`  Hype Ghost is running (local only)`);
    console.log(`  Dashboard (your chat window): http://localhost:${port}/`);
    console.log(`  OBS Browser Source overlay:   http://localhost:${port}/overlay`);
    console.log('');
    if (!state.apiKeySet) console.warn('  ⚠ No Anthropic API key set — the ghost cannot generate messages yet.');
    scheduleNext(15_000);
  });

  return {
    port,
    pause() {
      state.paused = true;
      scheduleNext();
    },
    resume() {
      state.paused = false;
      scheduleNext(3000);
    },
    isPaused() {
      return state.paused;
    },
  };
}
