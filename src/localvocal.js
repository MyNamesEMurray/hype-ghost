/**
 * The LocalVocal settings that decide whether the transcript is usable.
 *
 * LocalVocal ships tuned for on-screen captions: a small model, a short
 * buffer, partial lines on. That is the right target for subtitles and the
 * wrong one for us — the cast speaks on a cadence of minutes, so latency is
 * nearly free and every one of those defaults trades away accuracy we need.
 *
 * Kept as data rather than prose in the README so the app can hand the
 * streamer the list in the plugin's own wording (Settings → Voice), next to
 * the initial prompt it generates for them. `setting` strings are quoted from
 * LocalVocal's own labels on purpose: a streamer reading this has the plugin
 * open, and a paraphrase would send them hunting.
 */
export const LOCALVOCAL_PRESET = [
  {
    setting: 'Model',
    value: 'small.en (medium.en on a strong PC)',
    why: 'The default tiny.en is the single biggest source of mishears, and at equal size the English-only models beat the multilingual ones. Step up until OBS starts struggling, then back off one.',
  },
  {
    setting: 'Initial prompt',
    value: 'the line above',
    why: 'Whisper conditions on it, and names are what it fumbles. This is free accuracy on exactly the words the cast runs on.',
  },
  {
    setting: 'Buffer size (ms)',
    value: '3000 or more',
    why: 'More audio per chunk means more context to decode against. Captions need this short; the cast does not, so the latency costs you nothing.',
  },
  {
    setting: 'Enable Partial Transcription',
    value: 'off',
    why: 'Partials write half-finished duplicate lines, which reach the cast as stutter and crowd out real speech in the transcript window.',
  },
  {
    setting: 'VAD Mode',
    value: 'Active VAD',
    why: 'A mic-only track is mostly silence, and Whisper invents filler when it is fed silence. Gating it at the source beats filtering the filler afterwards.',
  },
  {
    setting: 'Suppress non-speech tokens',
    value: 'on',
    why: 'Stops "[BLANK_AUDIO]", "[Music]" and similar sound events from being written as if they were something you said.',
  },
  {
    setting: 'Whisper Sampling Strategy',
    value: 'Beam Search, beam size 5',
    why: 'Greedy decoding is the cheap default; beam search recovers proper nouns a greedy pass drops. Worth it if your CPU has the headroom.',
  },
  {
    setting: 'Save to File',
    value: 'on, with "Truncate file on new sentence" off',
    why: 'Append-only output is what file mode tails most cheaply — it reads only the newly written bytes.',
  },
];
