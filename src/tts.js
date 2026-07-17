import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Server-side speech synthesis via Windows SAPI (System.Speech through
 * PowerShell), producing WAV audio the deck plays through an <audio>
 * element. This exists because the browser's speechSynthesis cannot route
 * to a chosen output device — audio elements can (setSinkId), but need
 * actual audio data to play. Voices are the local Windows SAPI voices;
 * nothing leaves the machine.
 *
 * The PowerShell scripts are static strings; all variable data (text,
 * voice, rate) travels via environment variables and temp files, so no
 * user input is ever interpolated into executable code.
 */

/**
 * Map the UI's speech-rate multiplier (0.5–2, 1 = normal) onto SAPI's
 * -10..10 scale. Log so 0.5x and 2x are symmetric around 0.
 */
export function mapRateToSapi(mult) {
  const m = Math.max(0.5, Math.min(2, Number(mult) || 1));
  return Math.max(-10, Math.min(10, Math.round(9 * Math.log2(m))));
}

/**
 * Match a saved voice name against the installed SAPI voice list. Saved
 * names may come from the browser engine ("Microsoft David - English
 * (United States)") while SAPI reports "Microsoft David Desktop", so fall
 * back to matching on the distinctive token (the given name). Returns the
 * installed name to select, or '' for the synthesizer default.
 */
export function pickSapiVoice(requested, installed) {
  const want = String(requested || '').toLowerCase().trim();
  if (!want) return '';
  const names = (installed || []).filter(Boolean);
  const exact = names.find((n) => n.toLowerCase() === want);
  if (exact) return exact;
  for (const n of names) {
    const key = n.toLowerCase().replace(/\b(microsoft|desktop|mobile)\b/g, '').trim().split(/\s+/)[0];
    if (key && want.includes(key)) return n;
  }
  return '';
}

const LIST_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }',
  '$s.Dispose()',
].join('\n');

const SPEAK_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:HG_TTS_VOICE) { try { $s.SelectVoice($env:HG_TTS_VOICE) } catch {} }',
  '$s.Rate = [int]$env:HG_TTS_RATE',
  '$text = [IO.File]::ReadAllText($env:HG_TTS_IN, [Text.Encoding]::UTF8)',
  '$s.SetOutputToWaveFile($env:HG_TTS_OUT)',
  '$s.Speak($text)',
  '$s.Dispose()',
].join('\n');

// PowerShell -EncodedCommand takes base64 of UTF-16LE — immune to any
// quoting/escaping concerns.
const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

function runPowershell(script, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
      { env: { ...process.env, ...env }, timeout: timeoutMs, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

export class SapiTts {
  constructor() {
    this.voicesCache = null;
  }

  available() {
    return process.platform === 'win32';
  }

  /** Installed SAPI voice names, cached for the session. [] off-Windows or on failure. */
  async listVoices() {
    if (!this.available()) return [];
    if (this.voicesCache) return this.voicesCache;
    try {
      const out = await runPowershell(LIST_SCRIPT, {}, 10_000);
      this.voicesCache = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } catch (err) {
      console.warn('[tts] listing SAPI voices failed:', err.message);
      this.voicesCache = [];
    }
    return this.voicesCache;
  }

  /**
   * Synthesize text to a WAV buffer with the given voice/rate, or null on
   * failure. Text goes through a temp file; the ~500-char cap keeps a
   * single chat message's synth well under the timeout.
   */
  async synthesize(text, { voice, rate } = {}) {
    if (!this.available()) return null;
    const clean = String(text || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 500).trim();
    if (!clean) return null;
    const dir = mkdtempSync(path.join(tmpdir(), 'hg-tts-'));
    const inPath = path.join(dir, 'in.txt');
    const outPath = path.join(dir, 'out.wav');
    try {
      writeFileSync(inPath, clean, 'utf8');
      const chosen = pickSapiVoice(voice, await this.listVoices());
      await runPowershell(
        SPEAK_SCRIPT,
        { HG_TTS_IN: inPath, HG_TTS_OUT: outPath, HG_TTS_VOICE: chosen, HG_TTS_RATE: String(mapRateToSapi(rate)) },
        20_000
      );
      return readFileSync(outPath);
    } catch (err) {
      console.warn('[tts] synthesis failed:', err.message);
      return null;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}
