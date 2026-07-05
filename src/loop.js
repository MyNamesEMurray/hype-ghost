/**
 * GhostLoop — the bot's timing state machine, extracted from the server so
 * the hardest-to-reason-about code in the app lives in one testable place:
 * when to speak, with which trigger, and when to stop.
 *
 * Owns: the message timer (with trigger threading), the busy flag, manual
 * and automatic pause, the voice-reply debounce (with rate floor), the
 * screenshot gap/scene tracking, session-notes cadence, and the auto-pause
 * dead-man switch that stops API spend when OBS goes away.
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
export class GhostLoop {
  constructor({ config, brain, obs, transcriptFeed, hooks }) {
    this.config = config;
    this.brain = brain;
    this.obs = obs;
    this.feed = transcriptFeed;
    this.hooks = hooks;

    this.paused = false;
    this.autoPaused = false; // paused by the dead-man switch, not the user
    this.busy = false;
    this.nextMessageAt = null;

    this.timer = null;
    this.pendingTrigger = 'timer';
    this.lastShotAt = 0;
    this.lastSceneName = null;
    this.lastGenAt = 0;
    this.botMessageCount = 0;

    this.voiceReplyTimer = null;
    this.voiceRepliedTo = null; // bot message id already answered by voice
    this.lastVoiceReplyAt = 0;
    this.voiceBusyRetries = 0;

    // Banter cap: a two-message persona exchange is allowed at most once per
    // stretch of streamer activity — the streamer is the show.
    this.lastStreamerActivityAt = Date.now();
    this.lastExchangeAt = 0;

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
    this.stopResumeWatcher();
    this.scheduleNext();
  }

  resume() {
    this.paused = false;
    this.autoPaused = false;
    this.stopResumeWatcher();
    this.scheduleNext(3000);
  }

  nudge() {
    clearTimeout(this.timer);
    this.timer = null;
    this.speak('nudge');
  }

  /** The streamer typed a message — answer it soon, with the reply prompt. */
  onStreamerMessage() {
    this.lastStreamerActivityAt = Date.now();
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
    this.lastStreamerActivityAt = Date.now();
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
    this.voiceRepliedTo = this.hooks.getHistory().at(-1)?.id ?? null;
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
      if (Date.now() - this.lastShotAt < minShotGapMs) {
        staleScreenshot = true;
      } else {
        screenshot = await this.obs.screenshot();
        if (screenshot) {
          this.lastShotAt = Date.now();
          this.lastSceneName = screenshot.sceneName ?? this.lastSceneName;
          this.obsFailSince = null;
        } else {
          this.obsFailSince = this.obsFailSince ?? Date.now();
          if (this.maybeAutoPause()) return;
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
      const updateProfile =
        memory.enabled && (this.botMessageCount + 1) % (memory.profileEvery ?? 12) === 0;
      const allowExchange = this.lastStreamerActivityAt > this.lastExchangeAt;

      // Only speech the model hasn't seen yet (15s overlap for continuity).
      const transcript = this.feed.getWindow(this.lastGenAt ? this.lastGenAt - 15_000 : 0);
      this.lastGenAt = Date.now();

      const result = await this.brain.generate({
        history: this.hooks.getHistory().slice(-14),
        screenshot,
        staleScreenshot,
        mode: this.hooks.getMode(),
        trigger,
        transcript: transcript || undefined,
        notes: this.hooks.getNotes() || undefined,
        profile: this.hooks.getProfile() || undefined,
        updateNotes,
        updateProfile,
        sceneName: this.lastSceneName || undefined,
        streamContext: this.config.stream?.context || undefined,
        talkingPoint,
        allowExchange,
      });

      if (result.usage) this.hooks.addUsage(result.usage);
      const [first, second] = result.messages || [];
      if (first?.text) {
        this.hooks.onMessage(first.speaker, first.text);
        this.botMessageCount++;
      }
      if (second?.text) {
        // A persona exchange: release the riff after a human-ish beat, and
        // spend the banter allowance until the streamer engages again.
        this.lastExchangeAt = Date.now();
        setTimeout(() => {
          if (this.paused) return;
          this.hooks.onMessage(second.speaker, second.text);
          this.botMessageCount++;
        }, 4000 + Math.random() * 5000);
      }
      if (result.notes) this.hooks.setNotes(result.notes);
      if (result.profile) this.hooks.setProfile(result.profile);
    } catch (err) {
      console.error('[ghost] generation failed:', err.message);
      this.hooks.onSystem(`Message generation failed: ${err.message}`);
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
    this.paused = true;
    this.autoPaused = true;
    this.nextMessageAt = null;
    this.hooks.onSystem(
      `OBS has been unreachable for ${app.autoPauseMinutes ?? 10} minutes — the ghost auto-paused to save API costs. It resumes when OBS is back (or resume manually).`
    );
    this.hooks.onState();
    this.resumeWatcher = setInterval(async () => {
      try {
        await this.obs.ensureConnected();
      } catch {
        return;
      }
      this.stopResumeWatcher();
      this.paused = false;
      this.autoPaused = false;
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
