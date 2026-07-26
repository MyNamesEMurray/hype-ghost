import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHallucination, compileCorrections, applyCorrections, wordErrorRate,
  deriveCorrections, collectTerms, buildMicCheckScript, normalizeForCompare, similarity,
} from '../src/speech.js';

// ---- hallucination filtering ----

test('drops whisper filler that is the entire line', () => {
  for (const line of ['Thank you.', 'thanks for watching!', 'Please subscribe to my channel', '[Music]', '♪♪♪', 'Bye.', '(upbeat music)']) {
    assert.equal(isHallucination(line), true, `expected filler: ${line}`);
  }
});

// The whole point of matching the entire line: streamers really do say these
// words, just inside sentences. Dropping those would be worse than the bug.
test('keeps real speech that merely contains a filler phrase', () => {
  for (const line of ['thank you for the follow that is so nice', 'okay so the plan is we go left', 'bye bye little guy that was a rough end']) {
    assert.equal(isHallucination(line), false, `expected speech: ${line}`);
  }
});

test('drops decoder repetition loops but keeps ordinary repetition', () => {
  assert.equal(isHallucination('yeah yeah yeah yeah yeah yeah yeah'), true);
  assert.equal(isHallucination('no way no way no way no way'), true);
  assert.equal(isHallucination('go go go we need to move'), false);
});

// ---- correction map ----

test('applies corrections on whole words only, case-insensitively', () => {
  const compiled = compileCorrections([{ from: 'bacon', to: 'Beacon' }]);
  assert.equal(applyCorrections('lol bacon is right', compiled), 'lol Beacon is right');
  assert.equal(applyCorrections('BACON said hi', compiled), 'Beacon said hi');
  // substring must not match, or "baconator" becomes "Beaconator"
  assert.equal(applyCorrections('baconator burger', compiled), 'baconator burger');
});

test('multi-word corrections tolerate different spacing', () => {
  const compiled = compileCorrections([{ from: 'hyped host', to: 'Hype Ghost' }]);
  assert.equal(applyCorrections('welcome to hyped   host', compiled), 'welcome to Hype Ghost');
});

test('a blank target deletes the phrase, and an emptied line collapses to ""', () => {
  const compiled = compileCorrections([{ from: 'uh', to: '' }]);
  assert.equal(applyCorrections('uh okay uh sure', compiled), 'okay sure');
  assert.equal(applyCorrections('uh', compiled), '');
});

test('malformed correction entries are skipped, not thrown', () => {
  const compiled = compileCorrections([null, { from: '', to: 'x' }, { from: 'a'.repeat(500), to: 'y' }, { from: 'ok', to: 'okay' }]);
  assert.equal(compiled.length, 1);
  assert.equal(applyCorrections('ok', compiled), 'okay');
  assert.deepEqual(compileCorrections(undefined), []);
});

test('regex metacharacters in a correction are matched literally', () => {
  const compiled = compileCorrections([{ from: 'c++', to: 'C plus plus' }]);
  assert.equal(applyCorrections('i write c++ daily', compiled), 'i write C plus plus daily');
});

// ---- measurement ----

test('word error rate counts substitutions, deletions and insertions', () => {
  assert.equal(wordErrorRate('hello there chat', 'hello there chat'), 0);
  assert.equal(wordErrorRate('hello there chat', 'hello their chat'), 1 / 3);
  assert.equal(wordErrorRate('hello there chat', 'hello chat'), 1 / 3);
  assert.equal(wordErrorRate('hello there chat', 'hello there my chat'), 1 / 3);
  // punctuation and casing are not errors
  assert.equal(wordErrorRate('Hello, there chat!', 'hello there chat'), 0);
});

// ---- suggestion derivation ----

test('suggests a fix only for mismatches that hit a tracked term', () => {
  const reference = 'okay chat, Beacon is asking about the build again.';
  const heard = 'okay chat bacon is asking about a build again';
  const fixes = deriveCorrections(reference, heard, ['Beacon']);
  assert.deepEqual(fixes, [{ from: 'bacon', to: 'Beacon' }]);
});

test('groups a multi-word mangle into one replacement', () => {
  const fixes = deriveCorrections('shoutout to Hype Ghost tonight', 'shoutout to hyped host tonight', ['Hype Ghost']);
  assert.deepEqual(fixes, [{ from: 'hyped host', to: 'Hype Ghost' }]);
});

// Nothing was heard in place of the name, so there is no text a
// find-and-replace could rewrite — suggesting one would be a no-op.
test('a dropped word yields no suggestion', () => {
  assert.deepEqual(deriveCorrections('hey Wisp you there', 'hey you there', ['Wisp']), []);
});

// A streamer who skips a line or ad-libs collapses the alignment into one
// enormous mismatch. Turning that into a find-and-replace rule would silently
// rewrite real speech for the rest of the stream.
test('a wildly divergent reading produces no suggestions', () => {
  const reference = 'okay chat, Beacon is asking about the build again. shoutout to emurray, thanks for hanging out tonight.';
  const heard = 'uh i totally lost my place there hang on let me find where i was on this thing';
  assert.deepEqual(deriveCorrections(reference, heard, ['Beacon', 'emurray']), []);
});

test('unrelated words dragged together by a misalignment are rejected', () => {
  // "Wisp" and "emurray" look nothing alike — pairing them is an alignment
  // artifact, not a mishear.
  assert.ok(similarity('whisp', 'emurray') < 0.45);
  assert.ok(similarity('bacon', 'Beacon') > 0.7);
  assert.ok(similarity('hollow night', 'Hollow Knight') > 0.7);
});

// "night → Knight" alone would rewrite every "good night" the streamer says.
test('a partly-mangled multi-word name widens to the whole name', () => {
  const fixes = deriveCorrections('okay chat, Hollow Knight is fun', 'okay chat hollow night is fun', ['Hollow Knight']);
  assert.deepEqual(fixes, [{ from: 'hollow night', to: 'Hollow Knight' }]);
});

// Click-to-fix in the deck: the streamer retyped the line, so they are the
// authority — the term gate and the look-alike gate both stand down, or an
// explicit correction of an untracked word would be silently discarded.
test('an explicit correction bypasses the term and similarity gates', () => {
  const opts = { requireTerm: false, minSimilarity: 0 };
  assert.deepEqual(
    deriveCorrections('lets go to the shrine', 'lets go to the shine', [], opts),
    [{ from: 'shine', to: 'shrine' }]
  );
  // Untracked and nothing like each other — still honored when typed by hand.
  assert.deepEqual(
    deriveCorrections('that was a gank', 'that was a gong', [], opts),
    [{ from: 'gong', to: 'gank' }]
  );
  // …but the same pair is rejected on the mic-check path, which must not guess.
  assert.deepEqual(deriveCorrections('that was a gank', 'that was a gong', []), []);
});

test('a clean reading yields no suggestions', () => {
  assert.deepEqual(deriveCorrections('hey Wisp you there', 'hey wisp you there', ['Wisp']), []);
});

test('derived fixes actually repair the transcript when applied', () => {
  const reference = 'alright Beacon, you called it, that was rough.';
  const heard = 'alright bacon you called it that was rough';
  const fixes = deriveCorrections(reference, heard, ['Beacon']);
  const repaired = applyCorrections(heard, compileCorrections(fixes));
  assert.ok(wordErrorRate(reference, repaired) < wordErrorRate(reference, heard));
});

// ---- terms + script ----

test('collectTerms merges cast, channel and custom vocabulary without duplicates', () => {
  const terms = collectTerms({
    cast: [{ name: 'Beacon' }, { name: 'Wisp' }],
    twitchChannel: 'emurray',
    vocabulary: ['Hollow Knight', 'wisp'],
  });
  assert.deepEqual(terms, ['Beacon', 'Wisp', 'emurray', 'Hollow Knight']);
});

test('the mic-check script covers every term and works with none', () => {
  const { lines, terms } = buildMicCheckScript({ terms: ['Beacon', 'Wisp', 'emurray'] });
  const script = normalizeForCompare(lines.join(' '));
  for (const term of terms) assert.ok(script.includes(normalizeForCompare(term)), `${term} missing from script`);
  assert.ok(lines.length >= 3);
  // No cast, no channel, no vocabulary — still a readable baseline script.
  assert.ok(buildMicCheckScript({ terms: [] }).lines.length >= 2);
});
