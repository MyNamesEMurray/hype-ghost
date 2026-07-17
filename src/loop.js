/**
 * GhostLoop — the bot's timing state machine, extracted from the server so
 * the hardest-to-reason-about code in the app lives in one testable place:
 * when to speak, with which trigger, and when to stop.
 *
 * Owns: the message timer (with trigger threading), the busy flag, manual
 * and automatic pause, the voice-reply debounce (with rate floor), the
 * screenshot gap/scene tracking, session-notes cadence, the auto-pause
 * dead-man switch that stops API spend when OBS goes away, and the API
 * failure circuit breaker that stops retrying a broken key/account.
 *
 * The host provides context via hooks:
 *   getMode()            -> 'solo' | 'viewers'
 *   getHistory()         -> recent chat messages (oldest first)
 *   onMessage(text)      -> a bot message was generated
 *   onSystem(text)       -> operational notice for the dashboard
 *   onState()            -> loop state changed; host should rebroadcast
 *   getNotes()/setNotes(s) -> rolling session memory persistence
 *   addUsage(usage)      -> token usage for the cost meter
 */

// Scene names that unambiguously mean "nothing is happening on screen", so
// the screenshot (the biggest token cost per message) is skipped entirely.
// Conservative on purpose: a false positive silently blinds the ghost on a
// real scene, so bare words like "pause" or "break" are NOT matched ("no
// pause run", "Breakout") — only clear idle-screen phrases.
const IDLE_SCENE_RE =
  /\bbrb\b|be right back|starting soon|stream starting|ending soon|stream ending|\bintermission\b|\bafk\b|\boffline\b|\bintro\b|\boutro\b/i;

// Consecutive generation failures before the circuit breaker pauses the
// ghost instead of retrying a broken key/account forever.
const FAIL_STREAK_LIMIT = 5;

export class GhostLoop {
  constructor({ config, brain, obs, transcriptFeed, hooks }) {
    this.config = config;
    this.brain = brain;
    this.obs = obs;
    this.feed = transcriptFeed;
    this.hooks = hooks;

    this.paused = false;
    this.autoPaused = false; // paused by the app, not the user
    this.pauseReason = null; // 'obs' | 'api' | 'cost' when autoPaused
    this.busy = false;
    this.nextMessageAt = null;

    this.timer = null;
    this.pendingTrigger = 'timer';
    this.lastShotAt = 0;
    this.lastSceneName = null;
    this.lastGenAt = 0;
    this.botMessageCount = 0;
    this.failStreak = 0; // consecutive generation failures

    this.voiceReplyTimer = null;
    this.voiceRepliedTo = null; // bot message id already answered by voice
    this.lastVoiceReplyAt = 0;
    this.voiceBusyRetries = 0;

    this.obsFailSince = null; // start of the current OBS-unreachable streak
    this.resumeWatcher = null;
  }

  start() {
    this.scheduleNext(15_000); // first message ~15s after startup
  }

  snapshot() {
    return {
      paused: this.paused,
      autoPaused: this.autoPaused,
      pauseReason: this.pauseReason,
      busy: this.busy,
      nextMessageAt: this.nextMessageAt,
    };
  }

  isPaused() {
    return this.paused;
  }

  pause() {
    this.paused = true;
    this.autoPaused = false;
    this.pauseReason = null;
    this.stopResumeWatcher();
    this.scheduleNext();
  }

  resume() {
    this.paused = false;
    this.autoPaused = false;
    this.pauseReason = null;
    this.failStreak = 0; // a manual resume is a fresh chance
    this.stopResumeWatcher();
    this.scheduleNext(3000);
  }

  /**
   * Pause on the app's initiative (dead-man switch, API failure breaker,
   * cost cap) with a reason the dashboard can show and a system notice.
   */
  pauseFor(reason, message) {
    this.paused = true;
    this.autoPaused = true;
    this.pauseReason = reason;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextMessageAt = null;
    this.hooks.onSystem(message);
    this.hooks.onState();
  }

  nudge() {
    clearTimeout(this.timer);
    this.timer = null;
    this.speak('nudge');
  }

  /** The streamer typed a message — answer it soon, with the reply prompt. */
  onStreamerMessage() {
    this.scheduleNext((this.config.cadence.replyDelaySeconds ?? 6) * 1000, 'reply');
  }

  /**
   * The streamer said something on mic. If it lands after the ghost's latest
   * message, treat it as a spoken answer: reply ~8s after they stop talking.
   * Guards: once per bot message, a rate floor so continuous conversation
   * can't run unbounded past the configured cadence, and a busy retry so a
   * reply isn't silently dropped (and marked answered) mid-generation.
   */
  onSpeech() {
    const minGapMs = (this.config.cadence.minVoiceReplyGapSeconds ?? 35) * 1000;
    const last = this.hooks.getHistory().at(-1);
    const answerable =
      last &&
      last.role === 'bot' &&
      last.id !== this.voiceRepliedTo &&
      Date.now() - last.ts < 120_000 &&
      Date.now() - this.lastVoiceReplyAt >= minGapMs;
    if (!answerable || this.paused) return;
    clearTimeout(this.voiceReplyTimer);
    this.voiceBusyRetries = 0;
    this.voiceReplyTimer = setTimeout(() => this.fireVoiceReply(), 8000);
  }

  fireVoiceReply() {
    if (this.paused) return;
    if (this.busy) {
      if (this.voiceBusyRetries++ < 3) {
        this.voiceReplyTimer = setTimeout(() => this.fireVoiceReply(), 4000);
      }
      return;
    }
    // Re-validate the history tail: the 8s debounce window may have seen the
    // streamer type a message — then the typed-reply trigger owns the
    // response, and a voice reply would double up (or mark the wrong id).
    const last = this.hooks.getHistory().at(-1);
    if (!last || last.role !== 'bot' || last.id === this.voiceRepliedTo) return;
    this.voiceRepliedTo = last.id;
    this.lastVoiceReplyAt = Date.now();
    clearTimeout(this.timer);
    this.timer = null;
    this.speak('voice');
  }

  // Real chat rhythm isn't uniform: mostly normal gaps (± jitter), but
  // sometimes a quick burst follow-up, and sometimes a long lull of dead air.
  intervalMs() {
    const c = this.config.cadence;
    const base = this.hooks.getMode() === 'viewers' ? c.quietSeconds : c.soloSeconds;
    const roll = Math.random();
    let factor;
    if (roll < c.burstChance) {
      factor = 0.3 + Math.random() * 0.3; // burst: 0.3–0.6x base
    } else if (roll < c.burstChance + c.lullChance) {
      factor = 1.6 + Math.random() * 1.4; // lull: 1.6–3x base
    } else {
      factor = 1 + (Math.random() * 2 - 1) * c.jitter; // normal: ± jitter
    }
    return Math.max(15, base * factor) * 1000;
  }

  scheduleNext(msOverride, trigger = 'timer') {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.paused) {
      this.nextMessageAt = null;
      this.hooks.onState();
      return;
    }
    const ms = msOverride ?? this.intervalMs();
    this.nextMessageAt = Date.now() + ms;
    this.pendingTrigger = trigger;
    this.hooks.onState();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.speak(this.pendingTrigger);
    }, ms);
  }

  async speak(trigger) {
    if (this.paused || this.busy) return;
    this.busy = true;
    this.hooks.onState();
    try {
      // Screenshot (skipped on rapid follow-ups — the image is the biggest
      // token cost per message and the scene hasn't meaningfully changed).
      const minShotGapMs = (this.config.cadence.minScreenshotGapSeconds ?? 25) * 1000;
      let screenshot = null;
      let staleScreenshot = false;
      let idleScene = false;
      if (Date.now() - this.lastShotAt < minShotGapMs) {
        staleScreenshot = true;
      } else {
        // Scene name first (a cheap local call): it distinguishes "OBS is
        // gone" from a failed screenshot request, and idle scenes (BRB /
        // starting soon) skip the image entirely — nothing on them is worth
        // ~480 image tokens, and they're exactly when streams idle longest.
        const sceneName = await this.obs.getSceneName();
        if (sceneName === null) {
          this.obsFailSince = this.obsFailSince ?? Date.now();
          if (this.maybeAutoPause()) return;
        } else {
          this.obsFailSince = null;
          this.lastSceneName = sceneName;
          if (IDLE_SCENE_RE.test(sceneName)) {
            idleScene = true;
          } else {
            screenshot = await this.obs.screenshot();
            if (screenshot) this.lastShotAt = Date.now();
          }
        }
      }

      // Occasionally steer toward a streamer-provided talking point
      // (never on replies — those belong to the conversation).
      const points = Array.isArray(this.config.talkingPoints)
        ? this.config.talkingPoints.filter(Boolean)
        : [];
      const talkingPoint =
        points.length && (trigger === 'timer' || trigger === 'nudge') && Math.random() < 0.3
          ? points[Math.floor(Math.random() * points.length)]
          : undefined;

      const memory = this.config.memory;
      const updateNotes = memory.enabled && (this.botMessageCount + 1) % memory.updateEvery === 0;

      // Only speech the model hasn't seen yet (15s overlap for continuity).
      const transcript = this.feed.getWindow(this.lastGenAt ? this.lastGenAt - 15_000 : 0);
      this.lastGenAt = Date.now();

      const result = await this.brain.generate({
        history: this.hooks.getHistory().slice(-14),
        screenshot,
        staleScreenshot,
        idleScene,
        mode: this.hooks.getMode(),
        trigger,
        transcript: transcript || undefined,
        notes: this.hooks.getNotes() || undefined,
        updateNotes,
        sceneName: this.lastSceneName || undefined,
        talkingPoint,
      });
      this.failStreak = 0;

      if (result.usage) this.hooks.addUsage(result.usage);
      if (result.text) {
        this.hooks.onMessage(result.text);
        this.botMessageCount++;
      }
      if (result.notes) this.hooks.setNotes(result.notes);
    } catch (err) {
      console.error('[ghost] generation failed:', err.message);
      this.failStreak++;
      this.hooks.onSystem(`Message generation failed: ${err.message}`);
      // Circuit breaker: a revoked key, exhausted credits, or a long outage
      // shouldn't produce an error message every cadence tick forever.
      if (this.failStreak >= FAIL_STREAK_LIMIT) {
        this.pauseFor(
          'api',
          `Message generation has failed ${this.failStreak} times in a row — the ghost paused itself to avoid wasted API calls. Check your API key and credits, then resume from the dashboard.`
        );
      }
    } finally {
      this.busy = false;
      // A reply timer set while this generation was in flight survives —
      // only fall back to the normal cadence if nothing sooner is pending.
      if (this.timer === null && !this.paused) this.scheduleNext();
      this.hooks.onState();
    }
  }

  /**
   * Dead-man switch: OBS unreachable for autoPauseMinutes means the stream
   * rig is off and the app was forgotten in the tray — stop spending money.
   * (OBS merely not broadcasting does NOT pause: offline practice with OBS
   * open is the app's core use case.) A watcher resumes automatically when
   * OBS comes back.
   */
  maybeAutoPause() {
    const app = this.config.app;
    if (!app.autoPause || this.autoPaused) return false;
    const limitMs = (app.autoPauseMinutes ?? 10) * 60_000;
    if (!this.obsFailSince || Date.now() - this.obsFailSince < limitMs) return false;
    this.pauseFor(
      'obs',
      `OBS has been unreachable for ${app.autoPauseMinutes ?? 10} minutes — the ghost auto-paused to save API costs. It resumes when OBS is back (or resume manually).`
    );
    this.resumeWatcher = setInterval(async () => {
      try {
        await this.obs.ensureConnected();
      } catch {
        return;
      }
      this.stopResumeWatcher();
      this.paused = false;
      this.autoPaused = false;
      this.pauseReason = null;
      this.obsFailSince = null;
      this.hooks.onSystem('OBS is back — the ghost resumed.');
      this.scheduleNext(5000);
    }, 60_000);
    return true;
  }

  stopResumeWatcher() {
    clearInterval(this.resumeWatcher);
    this.resumeWatcher = null;
  }
}
