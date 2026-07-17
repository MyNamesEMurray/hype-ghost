import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecapiValue, parseDecapiViewers, DecApi } from '../src/twitch.js';

// DecAPI speaks plain text and returns errors as sentences with HTTP 200,
// so these parsers are the whole correctness story for the keyless path.

test('a live viewer count parses as a number', () => {
  assert.equal(parseDecapiViewers('5810', 'shroud'), 5810);
  assert.equal(parseDecapiViewers(' 0 ', 'shroud'), 0);
});

test('the offline sentence maps to 0, matching Helix behavior', () => {
  assert.equal(parseDecapiViewers('monstercat is offline', 'monstercat'), 0);
  assert.equal(parseDecapiViewers('MonsterCat Is Offline', 'monstercat'), 0);
});

test('unrecognized viewer responses are unavailable (null), never NaN', () => {
  assert.equal(parseDecapiViewers('User not found: zzqq', 'zzqq'), null);
  assert.equal(parseDecapiViewers('service is down for maintenance', 'shroud'), null);
  assert.equal(parseDecapiViewers('', 'shroud'), null);
  assert.equal(parseDecapiViewers('12 viewers', 'shroud'), null);
});

test('title/game values pass through, including ones that mention offline', () => {
  assert.equal(parseDecapiValue('VALORANT', 'shroud'), 'VALORANT');
  assert.equal(parseDecapiValue('going offline soon! !socials', 'shroud'), 'going offline soon! !socials');
});

test('the user-not-found sentence is an error (null), an unset field is ""', () => {
  assert.equal(parseDecapiValue('User not found: zzqq', 'zzqq'), null);
  assert.equal(parseDecapiValue('user not found: ZZQQ', 'zzqq'), null);
  assert.equal(parseDecapiValue('', 'shroud'), '');
  // a different channel's error text would be a legitimate (if odd) title
  assert.equal(parseDecapiValue('User not found: someoneelse', 'shroud'), 'User not found: someoneelse');
});

test('DecApi is inert without a channel or when disabled', () => {
  assert.equal(new DecApi({ channel: '' }).configured(), false);
  assert.equal(new DecApi({ channel: 'shroud', enabled: false }).configured(), false);
  assert.equal(new DecApi({ channel: '#Shroud' }).channel, 'shroud');
  assert.equal(new DecApi({ channel: 'shroud' }).configured(), true);
});
