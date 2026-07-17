import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { POINTER_FILE, dataFilePaths, resolveDataDir, setDataDir, migrateDataFiles } from '../src/storage.js';
import { FileLog } from '../src/logfile.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'hg-storage-'));

test('resolveDataDir: no pointer -> default', () => {
  const dir = tmp();
  assert.deepEqual(resolveDataDir(dir), { dir, custom: false });
});

test('resolveDataDir: valid pointer -> custom dir', () => {
  const def = tmp();
  const custom = tmp();
  setDataDir(def, custom);
  assert.deepEqual(resolveDataDir(def), { dir: custom, custom: true });
});

test('resolveDataDir: falls back on garbage, relative paths, and missing folders', () => {
  const def = tmp();
  writeFileSync(path.join(def, POINTER_FILE), 'not json{');
  assert.equal(resolveDataDir(def).custom, false, 'bad JSON');
  writeFileSync(path.join(def, POINTER_FILE), JSON.stringify({ dataDir: 'relative/dir' }));
  assert.equal(resolveDataDir(def).custom, false, 'relative path');
  writeFileSync(path.join(def, POINTER_FILE), JSON.stringify({ dataDir: path.join(def, 'gone') }));
  assert.equal(resolveDataDir(def).custom, false, 'folder does not exist (unplugged drive)');
  writeFileSync(path.join(def, POINTER_FILE), JSON.stringify({ dataDir: def }));
  assert.equal(resolveDataDir(def).custom, false, 'pointing at the default is not custom');
});

test('setDataDir(null) clears the pointer', () => {
  const def = tmp();
  const custom = tmp();
  setDataDir(def, custom);
  assert.ok(existsSync(path.join(def, POINTER_FILE)));
  setDataDir(def, null);
  assert.ok(!existsSync(path.join(def, POINTER_FILE)));
  assert.deepEqual(resolveDataDir(def), { dir: def, custom: false });
});

test('migrateDataFiles copies only what exists, overwrites stale copies', () => {
  const from = tmp();
  const to = tmp();
  writeFileSync(path.join(from, 'config.json'), '{"a":1}');
  writeFileSync(path.join(from, 'profile.md'), 'likes speedruns');
  writeFileSync(path.join(to, 'config.json'), '{"stale":true}');
  const copied = migrateDataFiles(from, to);
  assert.deepEqual(copied.sort(), ['config.json', 'profile.md']);
  assert.equal(readFileSync(path.join(to, 'config.json'), 'utf8'), '{"a":1}', 'current state wins');
  assert.ok(!existsSync(path.join(to, 'session.json')), 'absent files are not invented');
  assert.ok(existsSync(path.join(from, 'config.json')), 'copy, not move');
});

test('migrateDataFiles into the same dir is a no-op', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'config.json'), '{}');
  assert.deepEqual(migrateDataFiles(dir, dir), []);
});

test('dataFilePaths covers every file factory reset must delete', () => {
  const p = dataFilePaths('/x');
  for (const key of ['configPath', 'notesPath', 'sessionPath', 'profilePath', 'logPath']) {
    assert.ok(p[key].startsWith(path.resolve('/x')), key);
  }
});

test('FileLog appends formatted lines and rotates past maxBytes', () => {
  const dir = tmp();
  const file = path.join(dir, 'logs', 'hg.log'); // parent dir is created on demand
  const log = new FileLog(file, { maxBytes: 200 });
  log.append('log', ['hello', { a: 1 }, new Error('boom')]);
  const line = readFileSync(file, 'utf8');
  assert.match(line, /^\d{4}-\d{2}-\d{2}T.*log {3}hello {"a":1} Error: boom/);
  for (let i = 0; i < 20; i++) log.append('warn', ['padding line to push the file over the rotation limit']);
  assert.ok(existsSync(file + '.old'), 'rotated generation exists');
  assert.ok(readFileSync(file, 'utf8').length < 500, 'live file restarted small');
});

test('FileLog never throws on unwritable targets', () => {
  const log = new FileLog(path.join(tmp(), 'dir-as-file'));
  mkdirSync(log.file, { recursive: true }); // appendFileSync will fail: target is a directory
  assert.doesNotThrow(() => log.append('error', ['lost line']));
});
