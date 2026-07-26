import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, messageCost, isKnownModel } from '../src/models.js';

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

// No catalog id may be a prefix of another, or messageCost's prefix match would
// bill a custom/dated id at the wrong model's rates.
test('catalog ids do not shadow each other by prefix', () => {
  for (const a of MODELS) {
    for (const b of MODELS) {
      if (a !== b) assert.ok(!a.id.startsWith(b.id), `${a.id} shadowed by ${b.id}`);
    }
  }
});

// Drives the "Custom model ID…" hint: it warns the deck can't show a dollar
// figure only when the id really has no rates.
test('isKnownModel tracks what the cost meter can price', () => {
  assert.equal(isKnownModel('claude-sonnet-5'), true);
  assert.equal(isKnownModel('claude-opus-5-20260101'), true); // dated snapshot
  assert.equal(isKnownModel('claude-opus-4-7'), false);
  assert.equal(isKnownModel(''), false);
  assert.equal(isKnownModel(undefined), false);
});
