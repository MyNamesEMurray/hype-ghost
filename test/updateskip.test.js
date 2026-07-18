import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cmpVersions, UpdateSkip } from '../src/updateskip.js';

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'hg-skip-')), 'update-skip.json');

test('cmpVersions orders x.y.z numerically, tolerates a v prefix', () => {
  assert.equal(cmpVersions('3.1.0', '3.1.0'), 0);
  assert.equal(cmpVersions('v3.1.0', '3.1.0'), 0);
  assert.equal(cmpVersions('3.1.1', '3.1.0'), 1);
  assert.equal(cmpVersions('3.2.0', '3.1.9'), 1);
  assert.equal(cmpVersions('4.0.0', '3.9.9'), 1);
  assert.equal(cmpVersions('3.0.9', '3.1.0'), -1);
  assert.equal(cmpVersions('3.10.0', '3.9.0'), 1, 'numeric, not lexicographic');
  assert.equal(cmpVersions('3.1', '3.1.0'), 0, 'missing parts are zero');
});

test('cmpVersions refuses garbage instead of guessing', () => {
  assert.ok(Number.isNaN(cmpVersions('3.1.0-beta.1', '3.1.0')));
  assert.ok(Number.isNaN(cmpVersions('next', '3.1.0')));
  assert.ok(Number.isNaN(cmpVersions('', '3.1.0')));
});

test('the user story: skip 3.1.0 -> silent until something newer than 3.1.0', () => {
  const skip = new UpdateSkip(tmpFile());
  assert.equal(skip.isSkipped('3.1.0'), false, 'nothing skipped yet');
  skip.skip('3.1.0');
  assert.equal(skip.isSkipped('3.1.0'), true, 'the skipped version stays quiet');
  assert.equal(skip.isSkipped('3.0.5'), true, 'older than the skip never re-prompts either');
  assert.equal(skip.isSkipped('3.1.1'), false, 'the next patch asks again');
  assert.equal(skip.isSkipped('3.2.0'), false, 'the next minor asks again');
});

test('a later skip overwrites an earlier one', () => {
  const skip = new UpdateSkip(tmpFile());
  skip.skip('3.1.0');
  skip.skip('3.2.0');
  assert.equal(skip.read(), '3.2.0');
  assert.equal(skip.isSkipped('3.2.0'), true);
});

test('unreadable or malformed markers mean "not skipped" (prompt normally)', () => {
  const file = tmpFile();
  const skip = new UpdateSkip(file);
  writeFileSync(file, 'not json{');
  assert.equal(skip.isSkipped('3.1.0'), false);
  writeFileSync(file, JSON.stringify({ version: 'weird-tag' }));
  assert.equal(skip.isSkipped('3.1.0'), false, 'NaN compares are never a skip');
});

test('clearIfNotNewer drops the marker once the app caught up', () => {
  const file = tmpFile();
  const skip = new UpdateSkip(file);
  skip.skip('3.1.0');
  skip.clearIfNotNewer('3.0.0'); // still behind — a 3.1.0 offer must stay silent
  assert.equal(skip.read(), '3.1.0');
  skip.clearIfNotNewer('3.1.0'); // running the skipped version itself
  assert.equal(skip.read(), null);
  assert.ok(!existsSync(file));
});
