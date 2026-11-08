import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../src/server.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'hg-server-'));
const configPath = path.join(dir, 'config.json');
const port = 38000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;

const post = (url, body, headers = {}) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const getConfig = async () => (await (await fetch(base + '/api/config')).json()).config;

before(async () => {
  writeFileSync(configPath, JSON.stringify({ port }));
  startServer({
    configPath,
    notesPath: path.join(dir, 'session-notes.txt'),
    sessionPath: path.join(dir, 'session.json'),
    profilePath: path.join(dir, 'profile.md'),
    gameInfoPath: path.join(dir, 'game-notes.json'),
    micCheckPath: path.join(dir, 'miccheck.json'),
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base + '/api/config');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});

// startServer has no stop(): intervals and sockets stay open.
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));

test('POST /api/config: hot-path change applies live', async () => {
  const cfg = await getConfig();
  cfg.energy = 77;
  const res = await post('/api/config', cfg);
  assert.deepEqual(await res.json(), { ok: true, applied: true });
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).energy, 77);
  assert.equal(existsSync(`${configPath}.tmp`), false);
});

test('POST /api/config: cold change reports restarting, not applied', async () => {
  const cfg = await getConfig();
  cfg.obs.url = 'ws://127.0.0.1:1';
  const body = await (await post('/api/config', cfg)).json();
  assert.equal(body.ok, true);
  assert.equal(body.restarting, false);
  assert.equal('applied' in body, false);
});

test('POST /api/factory-reset: cross-site Origin is refused', async () => {
  const res = await post('/api/factory-reset', undefined, { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(existsSync(configPath), true);
});

test('POST /api/factory-reset: allowed Origin or none deletes the config', async () => {
  const withOrigin = await post('/api/factory-reset', undefined, { Origin: base });
  assert.equal(withOrigin.status, 200);
  assert.equal(existsSync(configPath), false);

  writeFileSync(configPath, '{}');
  const noOrigin = await post('/api/factory-reset');
  assert.equal(noOrigin.status, 200);
  assert.equal(existsSync(configPath), false);
});
