/**
 * LocalVocal configuration doctor.
 *
 * The transcriber is the LocalVocal OBS plugin (whisper.cpp inside OBS), and
 * it is configured entirely by hand in OBS — there is no API we can read its
 * settings through, and no way to fix them from here. But almost every
 * "transcription is bad" complaint is really a misconfigured plugin, and every
 * one of those misconfigurations leaves a fingerprint in the *text* we already
 * ingest: duplicated half-lines, three-word fragments, a flood of silence
 * hallucinations, nothing at all, or the same sentence over and over.
 *
 * So this module watches the lines going past and names the setting to change,
 * in the plugin's own wording, so the UI can quote it back at the streamer.
 *
 * It is deliberately pure — no fs, no network, no timers, no config, clock
 * injected — which makes it directly testable and cheap enough to run for a
 * whole stream on a machine already sharing a GPU with OBS and a game. The
 * observation history is a bounded ring for the same reason: an eight-hour
 * stream must not grow it.
 *
 * Every check reports 'unknown' rather than guessing until it has enough
 * samples. A confident wrong diagnosis sends a streamer to change a setting
 * that was fine, which is worse than saying nothing.
 */

// --- thresholds -------------------------------------------------------------
// Each is paired with the minimum sample below which the check says 'unknown'.

/** Ring capacity. ~300 lines is roughly 20-40 minutes of steady talking. */
const DEFAULT_MAX_OBSERVATIONS = 300;

/** Longest line kept for comparison. Guards the O(n·m) similarity on a pasted wall of text. */
const MAX_COMPARE_CHARS = 300;

/** Partial transcription: share of adjacent line pairs that look like a redraw. */
const PARTIAL_PAIR_RATE = 0.25;
const PARTIAL_MIN_PAIRS = 12;
/**
 * Two distinct lines this alike are the same utterance emitted twice. Set
 * high on purpose: a re-decode differs by a word or two ("shoud"/"should"),
 * while two genuinely different sentences of similar length and vocabulary can
 * still score surprisingly well on raw character distance.
 */
const NEAR_DUP_SIMILARITY = 0.9;

/** Buffer size: median words per line. Whole natural utterances run 8-20 words. */
const SHORT_LINE_MEDIAN_WORDS = 4;
const BUFFER_MIN_LINES = 15;

/**
 * VAD: share of ingested lines the speech layer threw away as hallucination.
 * A healthy mic feed produces the odd one; a quarter of everything means
 * whisper is being handed silence to invent words over.
 */
const HALLUCINATION_DROP_RATE = 0.25;
const DROP_MIN_OBSERVATIONS = 20;

/**
 * Silence: how long with no line at all before we say we are not receiving.
 * Generous on purpose — streamers read chat, watch cutscenes, take breaks, and
 * accusing a quiet streamer of a broken mic is the one false positive that
 * makes the whole feature untrustworthy.
 */
const SILENCE_MS = 10 * 60 * 1000;

/** Decoder stuck: identical consecutive lines. Real speech does not repeat verbatim this often. */
const STUCK_RUN = 4;
const STUCK_MIN_LINES = 10;

// --- tiny local helpers -----------------------------------------------------
// Intentionally not imported from src/speech.js: this module must stay free of
// dependencies so it can never break the transcript path it observes.

/** Lowercase, strip punctuation, collapse whitespace — comparison only. */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Character edit distance over already-capped strings. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
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
function similarity(a, b) {
  const x = a.replace(/\s+/g, '');
  const y = b.replace(/\s+/g, '');
  if (!x || !y) return 0;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

/** Is `short` the opening of `long`, on a word boundary? */
function isWordPrefix(short, long) {
  if (!short || short.length >= long.length) return false;
  return long.startsWith(`${short} `);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (n, places = 3) => Number(n.toFixed(places));

export class VoiceHealth {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] injected clock, so tests are deterministic
   * @param {number} [opts.maxObservations] ring capacity
   * @param {number} [opts.startedAt] when listening began; defaults to now()
   * @param {number} [opts.silenceMs] override the "not receiving" window
   */
  constructor({ now, maxObservations, startedAt, silenceMs } = {}) {
    this.now = typeof now === 'function' ? now : () => Date.now();
    const cap = Number(maxObservations);
    this.maxObservations = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_MAX_OBSERVATIONS;
    const started = Number(startedAt);
    this.startedAt = Number.isFinite(started) ? started : this.now();
    const silence = Number(silenceMs);
    this.silenceMs = Number.isFinite(silence) && silence > 0 ? silence : SILENCE_MS;

    /** @type {{ts:number, norm:string, words:number, dropped:boolean}[]} bounded ring, oldest first */
    this.observations = [];
    // Lifetime counters, so stats survive lines that have aged out of the ring.
    this.totalObserved = 0;
    this.totalDropped = 0;
    this.lastObservedAt = null; // any line arrived — proves the pipeline is wired
    this.lastKeptAt = null; // a line survived the hallucination filter
  }

  /**
   * Record one ingested line.
   * @param {string} text the line as ingested
   * @param {object} [meta]
   * @param {number} [meta.ts] arrival time (defaults to the injected clock)
   * @param {boolean} [meta.dropped] the speech layer discarded it as a hallucination
   */
  observe(text, { ts, dropped } = {}) {
    const at = Number.isFinite(Number(ts)) ? Number(ts) : this.now();
    // Long lines are capped before anything else touches them: the ring holds
    // whole-stream history, and a single pathological paste must not sit in it.
    const norm = normalize(text).slice(0, MAX_COMPARE_CHARS);
    const words = norm ? norm.split(' ').length : 0;
    const wasDropped = dropped === true;

    this.observations.push({ ts: at, norm, words, dropped: wasDropped });
    if (this.observations.length > this.maxObservations) this.observations.shift();

    this.totalObserved++;
    if (wasDropped) this.totalDropped++;
    this.lastObservedAt = at;
    if (!wasDropped) this.lastKeptAt = at;
  }

  /** Lines that reached the cast, i.e. everything not dropped and not blank. */
  kept() {
    return this.observations.filter((o) => !o.dropped && o.norm);
  }

  /**
   * @returns {{checks: {id:string, level:'ok'|'warn'|'unknown', title:string, detail:string, fix:string}[], stats: object}}
   */
  report() {
    const kept = this.kept();
    const now = this.now();
    const checks = [
      this.checkPartial(kept),
      this.checkBuffer(kept),
      this.checkVad(),
      this.checkSilence(now),
      this.checkStuck(kept),
    ];
    const dropRate = this.observations.length
      ? this.observations.filter((o) => o.dropped).length / this.observations.length
      : 0;
    return {
      checks,
      stats: {
        observed: this.observations.length,
        kept: kept.length,
        dropped: this.observations.length - kept.length,
        dropRate: round(dropRate),
        totalObserved: this.totalObserved,
        totalDropped: this.totalDropped,
        medianWords: median(kept.map((o) => o.words)),
        redrawPairRate: round(this.pairStats(kept).rate),
        longestRepeatRun: this.longestRun(kept),
        lastObservedAt: this.lastObservedAt,
        lastKeptAt: this.lastKeptAt,
        startedAt: this.startedAt,
        secondsSinceHeard: this.lastObservedAt === null ? null : Math.max(0, Math.round((now - this.lastObservedAt) / 1000)),
        uptimeSeconds: Math.max(0, Math.round((now - this.startedAt) / 1000)),
        ringCapacity: this.maxObservations,
      },
    };
  }

  // --- individual checks ----------------------------------------------------

  /** Adjacent-pair statistics: how many look like the same utterance re-emitted. */
  pairStats(kept) {
    let pairs = 0;
    let redraws = 0;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i - 1].norm;
      const b = kept[i].norm;
      pairs++;
      if (a === b) continue; // verbatim repeats are the decoder check's business
      if (isWordPrefix(a, b) || isWordPrefix(b, a) || similarity(a, b) >= NEAR_DUP_SIMILARITY) redraws++;
    }
    return { pairs, redraws, rate: pairs ? redraws / pairs : 0 };
  }

  checkPartial(kept) {
    const { pairs, redraws, rate } = this.pairStats(kept);
    const base = {
      id: 'partial_transcription',
      title: 'Partial transcription',
      fix: 'Turn off "Enable Partial Transcription" in the LocalVocal filter settings.',
    };
    if (pairs < PARTIAL_MIN_PAIRS) {
      return { ...base, level: 'unknown', detail: `Only ${pairs} consecutive line pairs seen so far — not enough to tell yet.` };
    }
    if (rate >= PARTIAL_PAIR_RATE) {
      return {
        ...base,
        level: 'warn',
        detail: `${redraws} of ${pairs} lines repeat or extend the line before them. That is partial transcription writing each sentence several times as it forms — the cast reads it as stutter, and it crowds out real speech in the transcript window.`,
      };
    }
    return { ...base, level: 'ok', detail: `Lines arrive as whole utterances (${redraws} of ${pairs} pairs overlap).` };
  }

  checkBuffer(kept) {
    const words = kept.map((o) => o.words);
    const med = median(words);
    const base = {
      id: 'buffer_too_short',
      title: 'Buffer length',
      fix: 'Raise "Buffer size (ms)" in the LocalVocal filter settings (try 3000-10000 ms).',
    };
    if (kept.length < BUFFER_MIN_LINES) {
      return { ...base, level: 'unknown', detail: `Only ${kept.length} lines heard so far — not enough to judge line length.` };
    }
    if (med < SHORT_LINE_MEDIAN_WORDS) {
      return {
        ...base,
        level: 'warn',
        detail: `Half the lines are ${med} words or shorter. Sentences are being cut into fragments before whisper can use the context around them, which costs accuracy and gives the cast nothing to react to.`,
      };
    }
    return { ...base, level: 'ok', detail: `Median line is ${med} words — long enough for whisper to use context.` };
  }

  checkVad() {
    const total = this.observations.length;
    const dropped = this.observations.filter((o) => o.dropped).length;
    const rate = total ? dropped / total : 0;
    const base = {
      id: 'vad_hallucinations',
      title: 'Voice activity detection',
      fix: 'Set "VAD Mode" to active and raise the "VAD Threshold" in the LocalVocal filter settings.',
    };
    if (total < DROP_MIN_OBSERVATIONS) {
      return { ...base, level: 'unknown', detail: `Only ${total} lines seen so far — not enough to measure the hallucination rate.` };
    }
    if (rate >= HALLUCINATION_DROP_RATE) {
      return {
        ...base,
        level: 'warn',
        detail: `${dropped} of ${total} lines were invented filler ("thank you", "please subscribe") and had to be thrown away. Whisper is being handed the silence between sentences — a mic-only track is mostly silence — and writes something anyway.`,
      };
    }
    return { ...base, level: 'ok', detail: `${dropped} of ${total} lines were filler — normal for a live mic.` };
  }

  checkSilence(now) {
    const base = {
      id: 'no_transcript',
      title: 'Transcript arriving',
      fix: 'Check the LocalVocal filter is on the microphone source and that its output file / text source matches Settings → Voice.',
    };
    const since = this.lastObservedAt === null ? now - this.startedAt : now - this.lastObservedAt;
    const minutes = Math.round(since / 60000);
    if (since < this.silenceMs) {
      return this.lastObservedAt === null
        ? { ...base, level: 'unknown', detail: `Nothing yet, but only ${minutes} minute(s) since listening started.` }
        : { ...base, level: 'ok', detail: `Last line arrived ${Math.round(since / 1000)}s ago.` };
    }
    // Deliberately hedged: an empty transcript is equally consistent with a
    // streamer who simply has not spoken, and we cannot tell the two apart.
    return this.lastObservedAt === null
      ? { ...base, level: 'warn', detail: `No transcript line has ever arrived, ${minutes} minutes after listening started. Either LocalVocal is not writing where the app is looking, or nobody has spoken.` }
      : { ...base, level: 'warn', detail: `No transcript line for ${minutes} minutes. Either transcription stopped or the mic has been quiet that whole time.` };
  }

  longestRun(kept) {
    let best = 0;
    let run = 0;
    let prev = null;
    for (const o of kept) {
      run = o.norm === prev ? run + 1 : 1;
      prev = o.norm;
      if (run > best) best = run;
    }
    return best;
  }

  checkStuck(kept) {
    const run = this.longestRun(kept);
    const base = {
      id: 'decoder_stuck',
      title: 'Decoder repetition',
      fix: 'In the LocalVocal advanced settings, raise "Temperature" / reduce "Beam size" (and lower "N context / tokens to keep") so the decoder does not carry a stuck context forward.',
    };
    if (kept.length < STUCK_MIN_LINES) {
      return { ...base, level: 'unknown', detail: `Only ${kept.length} lines heard so far — not enough to spot a stuck decoder.` };
    }
    if (run >= STUCK_RUN) {
      return {
        ...base,
        level: 'warn',
        detail: `The same line arrived ${run} times in a row. That is the decoder looping on its own previous output rather than anything that was said.`,
      };
    }
    return { ...base, level: 'ok', detail: `No line repeated more than ${run} time(s) in a row.` };
  }
}

export const THRESHOLDS = Object.freeze({
  DEFAULT_MAX_OBSERVATIONS,
  MAX_COMPARE_CHARS,
  PARTIAL_PAIR_RATE,
  PARTIAL_MIN_PAIRS,
  NEAR_DUP_SIMILARITY,
  SHORT_LINE_MEDIAN_WORDS,
  BUFFER_MIN_LINES,
  HALLUCINATION_DROP_RATE,
  DROP_MIN_OBSERVATIONS,
  SILENCE_MS,
  STUCK_RUN,
  STUCK_MIN_LINES,
});
