/**
 * Speech-to-text quality layer.
 *
 * LocalVocal (whisper.cpp inside OBS) is the transcriber and stays the
 * transcriber — this module is everything we can do to the *text* it produces
 * without running a second speech model on a machine that is already sharing
 * a GPU with OBS and a game:
 *
 * 1. Drop Whisper's well-known hallucinations ("Thank you.", "Thanks for
 *    watching!", subtitle-credit lines, stuck repetition loops). These are
 *    triggered by near-silence, and a mic-only feed is mostly near-silence —
 *    pauses between sentences, breaths, keyboard clatter, fan and room tone.
 *    Left alone, each one looks like the streamer speaking and can trigger a
 *    voice reply to something nobody said.
 * 2. Apply a per-streamer correction map — Whisper mangles proper nouns worst
 *    (ghost names, channel name, game titles), and those are exactly the words
 *    that matter here.
 * 3. Build that map from evidence instead of guesswork: the "mic check" hands
 *    the streamer a short script to read, so we know the reference text and can
 *    align it against what actually came back.
 *
 * Note what this is NOT: it is not training or fine-tuning. A paragraph of
 * audio is nowhere near enough to adapt an acoustic model, and it never
 * touches the model. It is a measurement, and a lookup table built from it.
 *
 * Everything here is pure — no I/O, no config, no clock — so it is directly
 * testable and safe to call per transcript line.
 */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Word boundaries that behave for unicode letters (\b does not).
const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';

const MAX_CORRECTIONS = 200; // sanity cap; this runs per transcript line
const MAX_FROM_LEN = 120;
const MAX_ALIGN_WORDS = 400; // mic-check scripts are ~60 words; this is a guard
// A real mishear is a short phrase swapped for a short phrase. Anything longer
// means the reading diverged from the script — a skipped line, an ad-lib, a
// dropped chunk — and the "correction" would be garbage. See deriveCorrections.
const MAX_SEGMENT_WORDS = 4;
// How alike the two sides must look. "bacon"/"Beacon" scores ~0.83;
// two unrelated words dragged together by a misalignment score near 0.
const MIN_SIMILARITY = 0.45;

/** Lowercase, strip punctuation, collapse whitespace — for comparison only. */
export function normalizeForCompare(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words as {raw, norm} pairs, so suggestions can quote the original casing. */
export function tokenize(text) {
  const tokens = [];
  for (const raw of String(text ?? '').split(/\s+/)) {
    if (!raw) continue;
    const norm = normalizeForCompare(raw);
    if (norm) tokens.push({ raw, norm });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 1. Hallucination filtering
// ---------------------------------------------------------------------------

/**
 * Whisper's greatest hits when fed silence or mic noise. Matched
 * against the WHOLE normalized line only — never as a substring — because
 * every one of these is also something a streamer might genuinely say inside
 * a longer sentence ("thank you for the follow" must survive; a bare
 * "Thank you." during a silent loading screen almost never is real).
 */
const FILLER_LINES = new Set([
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'thanks for watching and i will see you in the next video',
  'please subscribe',
  'please subscribe to my channel',
  'subscribe to my channel',
  "don't forget to subscribe",
  'like and subscribe',
  'see you next time',
  'see you in the next video',
  'bye',
  'bye bye',
  'you',
  'the end',
  'okay',
  'oh',
  'hmm',
  'subtitles by the amara org community',
  'subtitles by the amara.org community',
  'transcription by castingwords',
  'amara org community',
  'copyright',
  'all rights reserved',
]);

/**
 * A line of only bracketed sound events: "[BLANK_AUDIO]", "[Music]", "♪♪♪".
 * Rarer on a mic-only feed than the filler phrases above, but it costs nothing
 * to catch — a line with no words in it is never speech.
 */
function isSoundEventOnly(text) {
  const stripped = String(text ?? '')
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .replace(/[♪♫*_~-]/g, ' ');
  return !/[\p{L}\p{N}]/u.test(stripped);
}

/**
 * Whisper's decoder can get stuck emitting the same token or short phrase
 * forever ("yeah yeah yeah yeah yeah yeah yeah"). Real speech does repeat,
 * but not this many times in one segment.
 */
function isRepetitionLoop(norms) {
  if (norms.length < 6) return false;
  let run = 1;
  for (let i = 1; i < norms.length; i++) {
    run = norms[i] === norms[i - 1] ? run + 1 : 1;
    if (run >= 6) return true;
  }
  // A 2–3 word phrase tiled across the entire line ("no way no way no way …").
  for (const unit of [2, 3]) {
    if (norms.length < unit * 4 || norms.length % unit !== 0) continue;
    const head = norms.slice(0, unit).join(' ');
    let tiled = true;
    for (let i = unit; i < norms.length; i += unit) {
      if (norms.slice(i, i + unit).join(' ') !== head) { tiled = false; break; }
    }
    if (tiled) return true;
  }
  return false;
}

/** True when a line is almost certainly Whisper filler rather than speech. */
export function isHallucination(text) {
  const norm = normalizeForCompare(text);
  if (!norm) return true;
  if (isSoundEventOnly(text)) return true;
  if (FILLER_LINES.has(norm)) return true;
  if (FILLER_LINES.has(norm.replace(/\s+/g, ' '))) return true;
  return isRepetitionLoop(norm.split(' '));
}

// ---------------------------------------------------------------------------
// 2. Correction map
// ---------------------------------------------------------------------------

/**
 * Turn [{from, to}] into compiled whole-word regexes. Compile once per
 * corrections array (callers cache on array identity) — this is hot code.
 * A blank `to` deletes the phrase, which is the escape hatch for a filler
 * line the built-in hallucination list doesn't know about.
 */
export function compileCorrections(corrections) {
  const compiled = [];
  const list = Array.isArray(corrections) ? corrections.slice(0, MAX_CORRECTIONS) : [];
  for (const entry of list) {
    const from = String(entry?.from ?? '').trim();
    if (!from || from.length > MAX_FROM_LEN) continue;
    const to = String(entry?.to ?? '').trim();
    // Internal whitespace matches loosely so a two-word `from` still hits when
    // the transcriber spaced it differently.
    const body = from.split(/\s+/).map(escapeRe).join('\\s+');
    try {
      compiled.push({ re: new RegExp(`${WORD_START}${body}${WORD_END}`, 'giu'), to });
    } catch {
      // An unrepresentable `from` is skipped rather than breaking the feed.
    }
  }
  return compiled;
}

/** Apply compiled corrections; returns '' if the line was fully deleted. */
export function applyCorrections(text, compiled) {
  let out = String(text ?? '');
  for (const { re, to } of compiled ?? []) {
    re.lastIndex = 0;
    out = out.replace(re, to);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 3. Mic check — reference script, alignment, suggestions
// ---------------------------------------------------------------------------

/**
 * The proper nouns this install cares about getting right. Ordinary words are
 * deliberately excluded: a mishear of "the" costs nothing, a mishear of a
 * ghost's name breaks a voice reply.
 */
export function collectTerms({ cast = [], twitchChannel = '', game = '', vocabulary = [] } = {}) {
  const terms = [];
  const seen = new Set();
  const add = (value) => {
    const term = String(value ?? '').trim();
    if (!term || term.length > 40) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(term);
  };
  for (const member of cast) add(typeof member === 'string' ? member : member?.name);
  add(twitchChannel);
  add(game);
  for (const word of Array.isArray(vocabulary) ? vocabulary : []) add(word);
  return terms.slice(0, 10);
}

// Carrier sentences, written the way a streamer actually talks so the reading
// voice matches the streaming voice. Each %s takes one term.
const ONE_TERM = [
  'okay chat, %s is asking about the build again.',
  'shoutout to %s, thanks for hanging out tonight.',
  'hold on, %s just said something and i missed it.',
  'i swear %s says that every single stream.',
  'alright %s, you called it, that was rough.',
];
const TWO_TERM = [
  '%s and %s, you two are menaces today.',
  'between %s and %s i have no idea who to believe.',
];
// Always included: a term-free line, so a baseline error rate exists even for
// an install with no custom vocabulary at all.
const CONTROL_LINES = [
  'let me check if this thing is actually hearing me at normal talking volume.',
  'that was a clutch play and i genuinely did not think it was going to work.',
];

/**
 * A short script covering this install's proper nouns. Returns the lines to
 * read plus the terms being measured. ~20 seconds of reading.
 */
export function buildMicCheckScript({ terms = [] } = {}) {
  const pool = terms.slice(0, 6);
  const lines = [CONTROL_LINES[0]];
  let i = 0;
  let oneIdx = 0;
  let twoIdx = 0;
  while (i < pool.length) {
    if (pool.length - i >= 2 && twoIdx < TWO_TERM.length) {
      lines.push(TWO_TERM[twoIdx++].replace('%s', pool[i]).replace('%s', pool[i + 1]));
      i += 2;
    } else {
      lines.push(ONE_TERM[oneIdx++ % ONE_TERM.length].replace('%s', pool[i]));
      i += 1;
    }
  }
  lines.push(CONTROL_LINES[1]);
  return { lines, terms: pool };
}

/**
 * Word-level alignment (Levenshtein with backtrace). Returns the edit script
 * as ops: 'equal' | 'sub' | 'del' (in reference, missing from heard) | 'ins'
 * (heard but not in reference).
 */
export function alignWords(refNorms, hypNorms) {
  const a = refNorms.slice(0, MAX_ALIGN_WORDS);
  const b = hypNorms.slice(0, MAX_ALIGN_WORDS);
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j - 1] + cost, d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      ops.push({ op: a[i - 1] === b[j - 1] ? 'equal' : 'sub', ref: i - 1, hyp: j - 1 });
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ op: 'del', ref: i - 1, hyp: -1 });
      i--;
    } else {
      ops.push({ op: 'ins', ref: -1, hyp: j - 1 });
      j--;
    }
  }
  ops.reverse();
  return ops;
}

/** Character edit distance, for judging whether two phrases are plausibly the same one. */
function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j] + 1, row[j - 1] + 1);
    }
    prev = row;
  }
  return prev[b.length];
}

/** 1 = identical, 0 = nothing in common. */
export function similarity(a, b) {
  const x = normalizeForCompare(a).replace(/\s+/g, '');
  const y = normalizeForCompare(b).replace(/\s+/g, '');
  if (!x || !y) return 0;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

/** Standard word error rate: (substitutions + deletions + insertions) / reference words. */
export function wordErrorRate(reference, heard) {
  const ref = tokenize(reference).map((t) => t.norm);
  const hyp = tokenize(heard).map((t) => t.norm);
  if (!ref.length) return hyp.length ? 1 : 0;
  const errors = alignWords(ref, hyp).filter((o) => o.op !== 'equal').length;
  return Math.min(1, errors / ref.length);
}

/**
 * Derive correction candidates by aligning what was read against what came
 * back. Only mismatches whose *reference* side contains a tracked term are
 * offered — the point is fixing "beacon → bacon", not rewriting every filler
 * word the transcriber fumbled. A mismatch the transcriber simply dropped
 * (nothing heard) yields no suggestion: there is no text to rewrite.
 *
 * Two guards keep a sloppy reading from producing sloppy rules. A streamer who
 * skips a line, ad-libs, or reads out of order makes the alignment collapse
 * into one enormous mismatch — so segments past a few words are discarded, and
 * both sides must actually resemble each other. A bad suggestion is worse than
 * a missing one: it silently rewrites real speech for the rest of the stream.
 */
export function deriveCorrections(reference, heard, terms = []) {
  const ref = tokenize(reference);
  const hyp = tokenize(heard);
  const refNorms = ref.map((t) => t.norm);
  const ops = alignWords(refNorms, hyp.map((t) => t.norm));

  const phrases = terms.map((t) => normalizeForCompare(t)).filter(Boolean);
  // Individual words of multi-word terms count as hits too ("Knight" of
  // "Hollow Knight"), minus the short connectives that would match anything.
  const termWords = new Set();
  for (const phrase of phrases) {
    for (const word of phrase.split(' ')) {
      if (word.length >= 4 || phrase.split(' ').length === 1) termWords.add(word);
    }
  }
  // Where a multi-word term sits in the reference, so a mangle of one of its
  // words widens to the whole name: "night → Knight" would rewrite every
  // "good night" all stream, while "hollow night → Hollow Knight" cannot.
  const spans = [];
  for (const phrase of phrases) {
    const words = phrase.split(' ');
    if (words.length < 2) continue;
    for (let s = 0; s + words.length <= refNorms.length; s++) {
      if (words.every((w, k) => refNorms[s + k] === w)) spans.push([s, s + words.length - 1]);
    }
  }
  const refToHyp = new Map();
  for (const o of ops) if (o.ref >= 0 && o.hyp >= 0) refToHyp.set(o.ref, o.hyp);
  const clean = (s) => s.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();

  const suggestions = [];
  const seen = new Set();
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op === 'equal') { k++; continue; }
    // Group the consecutive mismatch into one segment, so a two-word name
    // heard as three words becomes a single replacement.
    const refIdx = [];
    const hypIdx = [];
    while (k < ops.length && ops[k].op !== 'equal') {
      if (ops[k].ref >= 0) refIdx.push(ops[k].ref);
      if (ops[k].hyp >= 0) hypIdx.push(ops[k].hyp);
      k++;
    }
    if (!refIdx.length || !hypIdx.length) continue;
    if (refIdx.length > MAX_SEGMENT_WORDS || hypIdx.length > MAX_SEGMENT_WORDS) continue;

    let refStart = Math.min(...refIdx);
    let refEnd = Math.max(...refIdx);
    const span = spans.find(([s, e]) => refIdx.some((i) => i >= s && i <= e));
    if (span) {
      refStart = Math.min(refStart, span[0]);
      refEnd = Math.max(refEnd, span[1]);
    } else if (!refIdx.some((i) => termWords.has(refNorms[i]))) {
      continue; // nothing worth protecting in this mismatch
    }

    // Widen the heard side to whatever aligned with the widened reference.
    const hypRange = [...hypIdx];
    for (let i = refStart; i <= refEnd; i++) {
      const j = refToHyp.get(i);
      if (j !== undefined) hypRange.push(j);
    }
    const from = clean(hyp.slice(Math.min(...hypRange), Math.max(...hypRange) + 1).map((t) => t.raw).join(' '));
    const to = clean(ref.slice(refStart, refEnd + 1).map((t) => t.raw).join(' '));
    if (!from || !to || normalizeForCompare(from) === normalizeForCompare(to)) continue;
    if (similarity(from, to) < MIN_SIMILARITY) continue;
    const key = `${from.toLowerCase()}→${to.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ from, to });
  }
  return suggestions.slice(0, 12);
}
