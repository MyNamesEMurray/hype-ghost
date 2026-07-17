import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, examplePath } from '../src/config.js';

const defaults = () => JSON.parse(readFileSync(examplePath, 'utf8'));

function withConfig(t, contents) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hg-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'config.json');
  if (contents !== undefined) writeFileSync(p, contents);
  return p;
}

test('missing file degrades to defaults with a warning', (t) => {
  const { config, warning } = loadConfig(withConfig(t));
  assert.ok(warning.includes('not found'));
  assert.equal(config.cadence.soloSeconds, defaults().cadence.soloSeconds);
});

test('invalid JSON degrades to defaults with a warning', (t) => {
  const { config, warning } = loadConfig(withConfig(t, '{ nope'));
  assert.ok(warning.includes('not valid JSON'));
  assert.equal(config.port, defaults().port);
});

test('user values win, missing keys fall back per-key', (t) => {
  const { config, warning } = loadConfig(withConfig(t, JSON.stringify({ bot: { name: 'Wisp' }, cadence: { soloSeconds: 60 } })));
  assert.equal(warning, null);
  assert.equal(config.bot.name, 'Wisp');
  assert.equal(config.bot.language, defaults().bot.language); // untouched sibling
  assert.equal(config.cadence.soloSeconds, 60);
  assert.equal(config.cadence.jitter, defaults().cadence.jitter); // missing key defaulted
});

test('a non-numeric cadence value falls back to the default (no NaN timers)', (t) => {
  const { config, warning } = loadConfig(withConfig(t, JSON.stringify({ cadence: { soloSeconds: 'abc' } })));
  assert.equal(config.cadence.soloSeconds, defaults().cadence.soloSeconds);
  assert.ok(warning.includes('cadence.soloSeconds'));
});

test('numeric strings from hand edits are accepted', (t) => {
  const { config } = loadConfig(withConfig(t, JSON.stringify({ cadence: { soloSeconds: '90' } })));
  assert.equal(config.cadence.soloSeconds, 90);
});

test('out-of-range numbers are clamped', (t) => {
  const { config, warning } = loadConfig(
    withConfig(t, JSON.stringify({ cadence: { soloSeconds: 5, jitter: 3 }, port: 80 }))
  );
  assert.equal(config.cadence.soloSeconds, 20);
  assert.equal(config.cadence.jitter, 1);
  assert.equal(config.port, 1024);
  assert.ok(warning.includes('clamped'));
});

test('a config section replaced by a scalar is restored wholesale', (t) => {
  const { config, warning } = loadConfig(withConfig(t, JSON.stringify({ cadence: 5 })));
  assert.deepEqual(config.cadence, defaults().cadence);
  assert.ok(warning.includes('"cadence"'));
});

test('null and empty-string numerics fall back instead of coercing to 0', (t) => {
  const { config } = loadConfig(withConfig(t, JSON.stringify({ app: { autoPauseMinutes: null }, cadence: { quietSeconds: '' } })));
  assert.equal(config.app.autoPauseMinutes, defaults().app.autoPauseMinutes);
  assert.equal(config.cadence.quietSeconds, defaults().cadence.quietSeconds);
});

test('the example config passes sanitization untouched (it IS the schema)', (t) => {
  const { config, warning } = loadConfig(withConfig(t, readFileSync(examplePath, 'utf8')));
  assert.equal(warning, null);
  assert.deepEqual(config, defaults());
});
