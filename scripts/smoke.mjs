#!/usr/bin/env node
/**
 * Headless smoke test — boots the server (no Electron window/tray) and asserts
 * it serves its pages. No OBS / Twitch / API key required, so it runs anywhere
 * (CI or local: `npm run smoke`). Exit 0 = healthy, 1 = something is broken.
 *
 * This is the automated version of the boot check done by hand during 3.x
 * development: catch a broken import, a syntax error, or a dead route before it
 * reaches a PR.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = 3777; // src/cli.js uses config.port; with no config.json that's the default
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['src/cli.js'], { stdio: 'inherit' });
server.on('error', (err) => {
  console.error('failed to launch server:', err.message);
  process.exit(1);
});

const get = async (path) => (await fetch(base + path, { redirect: 'manual' })).status;

let failed = true;
try {
  // Wait (up to ~20s) for the port to accept connections.
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await get('/setup'); up = true; break; } catch {}
  }
  if (!up) throw new Error('server did not start listening in time');

  // [path, acceptable status codes]. `/` is 302→/setup until a brain is set up.
  const checks = [
    ['/setup', [200]],
    ['/settings', [200]],
    ['/overlay', [200]],
    ['/api/config', [200]],
    ['/api/overlay-config', [200]],
    ['/', [200, 302]],
  ];
  failed = false;
  for (const [path, ok] of checks) {
    const code = await get(path);
    const good = ok.includes(code);
    console.log(`${good ? 'ok  ' : 'FAIL'} GET ${path} -> ${code}`);
    if (!good) failed = true;
  }

  // The deck and overlay live on the WebSocket — assert a client gets the
  // init snapshot (state + history) on connect.
  const wsOk = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 5000);
    const finish = (ok) => { clearTimeout(timer); try { ws.close(); } catch {} resolve(ok); };
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        finish(msg.type === 'init' && Boolean(msg.state) && Array.isArray(msg.history));
      } catch { finish(false); }
    });
    ws.on('error', () => finish(false));
  });
  console.log(`${wsOk ? 'ok  ' : 'FAIL'} WS   connect -> init snapshot`);
  if (!wsOk) failed = true;
} catch (err) {
  console.error('smoke error:', err.message);
  failed = true;
} finally {
  server.kill('SIGTERM');
}
console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE OK');
process.exit(failed ? 1 : 0);
