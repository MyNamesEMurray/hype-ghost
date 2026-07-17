import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, messageCost } from '../src/models.js';

test('plain input/output tokens bill at the listed rates', () => {
  // Sonnet: $3/MTok in, $15/MTok out
  const cost = messageCost('claude-sonnet-5', { input_tokens: 1000, output_tokens: 1000 });
  assert.equal(cost, (1000 * 3 + 1000 * 15) / 1_000_000);
});

test('cache reads bill at 10% of the input rate, cache writes at 125%', () => {
  const read = messageCost('claude-sonnet-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 });
  assert.ok(Math.abs(read - 0.3) < 1e-9); // $3/MTok * 10%
  const write = messageCost('claude-sonnet-5', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 });
  assert.ok(Math.abs(write - 3.75) < 1e-9); // $3/MTok * 125%
});

test('dated model ids match by prefix', () => {
  assert.notEqual(messageCost('claude-sonnet-5-20260101', { input_tokens: 100, output_tokens: 10 }), null);
});

test('unknown models and missing usage return null (cost meter shows tokens instead)', () => {
  assert.equal(messageCost('some-future-model', { input_tokens: 1 }), null);
  assert.equal(messageCost('claude-sonnet-5', undefined), null);
  assert.equal(messageCost(undefined, { input_tokens: 1 }), null);
});

test('every catalog entry has the fields the UI and cost meter need', () => {
  for (const m of MODELS) {
    assert.ok(m.id && m.label, `model missing id/label`);
    assert.equal(typeof m.inRate, 'number');
    assert.equal(typeof m.outRate, 'number');
  }
});
