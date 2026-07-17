import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapRateToSapi, pickSapiVoice, SapiTts } from '../src/tts.js';

test('rate multiplier maps to SAPI -10..10, symmetric around normal', () => {
  assert.equal(mapRateToSapi(1), 0);
  assert.equal(mapRateToSapi(2), 9);
  assert.equal(mapRateToSapi(0.5), -9);
  assert.equal(mapRateToSapi(99), 9); // clamped
  assert.equal(mapRateToSapi('nonsense'), 0); // NaN -> normal, never NaN out
});

test('exact voice names match case-insensitively', () => {
  const installed = ['Microsoft David Desktop', 'Microsoft Zira Desktop'];
  assert.equal(pickSapiVoice('microsoft zira desktop', installed), 'Microsoft Zira Desktop');
});

test('browser-engine voice names match their SAPI counterpart by given name', () => {
  const installed = ['Microsoft David Desktop', 'Microsoft Zira Desktop'];
  assert.equal(pickSapiVoice('Microsoft David - English (United States)', installed), 'Microsoft David Desktop');
  assert.equal(pickSapiVoice('Microsoft Zira - English (United States)', installed), 'Microsoft Zira Desktop');
});

test('no request or no match falls back to the synthesizer default', () => {
  const installed = ['Microsoft David Desktop'];
  assert.equal(pickSapiVoice('', installed), '');
  assert.equal(pickSapiVoice('Google 日本語', installed), '');
  assert.equal(pickSapiVoice('anything', []), '');
});

test('SapiTts is inert off-Windows', { skip: process.platform === 'win32' }, async () => {
  const tts = new SapiTts();
  assert.equal(tts.available(), false);
  assert.deepEqual(await tts.listVoices(), []);
  assert.equal(await tts.synthesize('hello'), null);
});

// On a real Windows machine (and windows-latest CI runners), exercise the
// actual PowerShell → SAPI → WAV pipeline end to end.
test('SAPI synthesis produces a playable WAV on Windows', { skip: process.platform !== 'win32' }, async () => {
  const tts = new SapiTts();
  const voices = await tts.listVoices();
  assert.ok(voices.length > 0, 'expected at least one installed SAPI voice');
  const wav = await tts.synthesize('mic check from the cast', { voice: voices[0], rate: 1 });
  assert.ok(wav && wav.length > 1000, 'expected non-trivial WAV output');
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
});
