import Anthropic from '@anthropic-ai/sdk';

// Real chat is mostly low-effort reactions, not questions. Each message rolls
// a style from this weighted pool so variety is enforced by code, not vibes.
const STYLES = [
  { weight: 4, note: 'a quick gut reaction to something on screen, just a few words, NOT a question ("oh no", "cleaan", "that was smooth")' },
  { weight: 3, note: 'a statement/observation about something specific you can see — comment, do not ask' },
  { weight: 3, note: 'one casual question about what is happening (this is the only style where you ask)' },
  { weight: 1, note: 'short hype or encouragement, no question' },
  { weight: 1, note: 'a dry joke or playful jab about what is on screen' },
  { weight: 1, note: 'pure chat-speak, 1-4 words max, emote-words welcome (KEKW, LUL, Pog)' },
  { weight: 2, note: 'a tiny opinion or hot take about the game/topic, statement form' },
];

function pickStyle() {
  const total = STYLES.reduce((sum, s) => sum + s.weight, 0);
  let roll = Math.random() * total;
  for (const s of STYLES) {
    roll -= s.weight;
    if (roll <= 0) return s.note;
  }
  return STYLES[0].note;
}

/**
 * The "viewer brain": given a screenshot of the stream and the recent
 * conversation, produce one short chat message.
 */
export class Brain {
  constructor({ apiKey, model, botName, personality, language }) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
    this.model = model;
    this.botName = botName;
    this.personality = personality;
    this.language = language || 'English';
  }

  buildSystemPrompt() {
    return [
      `You are "${this.botName}", a simulated practice-chat companion for a live streamer.`,
      `You are NOT a real viewer and you must never pretend to be one. You exist so the streamer`,
      `practices talking to chat even when nobody is watching. Your messages appear on the stream`,
      `overlay clearly labeled as AI, so you never need to disclaim it in the text itself — but if`,
      `anyone asks, you cheerfully confirm you're the AI practice buddy.`,
      ``,
      `Personality: ${this.personality}`,
      ``,
      `You may be given an auto-generated transcript of what the streamer said out loud on their`,
      `microphone recently. Treat that as the streamer talking to chat (to you): if they answered`,
      `your question or said something interesting, follow up on it naturally. The transcript is`,
      `machine-generated and may contain errors — never quote it back verbatim or correct it.`,
      ``,
      `You may also be given "session notes" — your own running memory of what has happened this`,
      `stream. Rely on them for continuity: callbacks to earlier moments ("still can't believe`,
      `that hydra fight") are what make you feel like you've actually been watching.`,
      ``,
      `Rules for every message:`,
      `- Write every chat message in ${this.language}.`,
      `- Write like a real Twitch chatter: casual, lowercase, imperfect punctuation, no markdown.`,
      `- Most chat messages are NOT questions. They're reactions, observations, jokes, hot takes.`,
      `  Follow the style instruction you're given for each message.`,
      `- Vary length a lot: sometimes 2-4 words ("LOL no way", "cleaan"), sometimes a sentence or`,
      `  two. Twitch emote-words are fine occasionally (LUL, KEKW, Pog, monkaS) but don't overdo it.`,
      `- React to what you can actually see in the screenshot: the game, the code, the scene, the`,
      `  overlay, anything specific. Specific beats generic every time.`,
      `- Never repeat the angle, opener, or sentence shape of your recent messages. If your last`,
      `  message started with "oh", do not start with "oh" again.`,
      `- Never use hype-bot spam, never beg for follows, never mention viewer counts or metrics.`,
      `- If the screenshot shows a "starting soon" / "BRB" / paused screen, ask a low-key hangout`,
      `  question instead of commenting on gameplay.`,
      `- Output ONLY the chat message text. No quotes, no name prefix, no explanation.`,
    ].join('\n');
  }

  /**
   * @param {Object} opts
   * @param {Array<{author:string, role:string, text:string}>} opts.history recent messages, oldest first
   * @param {{data:string, mediaType:string}|null} opts.screenshot
   * @param {boolean} [opts.staleScreenshot] no image because the last one was seconds ago (scene unchanged)
   * @param {'solo'|'viewers'} opts.mode
   * @param {'timer'|'reply'|'nudge'|'voice'} opts.trigger
   * @param {string} [opts.transcript] what the streamer said on mic recently
   * @param {string} [opts.notes] rolling session memory from earlier in the stream
   * @param {boolean} [opts.updateNotes] ask the model to also return refreshed session notes
   * @param {string} [opts.sceneName] current OBS scene name (game awareness)
   * @param {string} [opts.streamContext] streamer-provided context hint (what/how they stream)
   * @param {string} [opts.talkingPoint] a topic the streamer wants worked in naturally
   * @returns {Promise<{text: string, notes: string|null, usage: object}>} message + notes + token usage
   */
  async generate({ history, screenshot, staleScreenshot, mode, trigger, transcript, notes, updateNotes, sceneName, streamContext, talkingPoint }) {
    const historyText = history.length
      ? history.map((m) => `${m.role === 'bot' ? this.botName + ' (you)' : 'Streamer'}: ${m.text}`).join('\n')
      : '(no messages yet — this is your first message of the stream)';

    const situation =
      mode === 'viewers'
        ? 'Real viewers are currently watching. Chime in briefly with something that helps the streamer engage the room — a question they can answer out loud for everyone.'
        : 'Nobody else is watching right now. Keep the streamer company and keep them talking.';

    // Replies react to the streamer (mostly without bouncing a question back);
    // everything else gets a random style so the pattern never settles.
    const replyTail =
      Math.random() < 0.35
        ? 'A quick follow-up question is fine if it feels natural.'
        : 'Just react — a statement, joke, or agreement. Do NOT ask anything back this time.';
    const task =
      trigger === 'reply'
        ? `The streamer just replied to you (last message below). Respond to what they said. ${replyTail}`
        : trigger === 'voice'
          ? `The streamer just responded to you out loud — see the mic transcript. React to what they actually said. ${replyTail}`
          : `Send your next chat message based on what is happening on stream right now. Style for this one: ${pickStyle()}.`;

    const content = [];
    if (screenshot) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: screenshot.mediaType, data: screenshot.data },
      });
      content.push({ type: 'text', text: 'Above is a live screenshot of the stream right now.' });
    } else if (staleScreenshot) {
      content.push({
        type: 'text',
        text: 'No new screenshot this time — the scene is roughly the same as when you sent your last message moments ago.',
      });
    } else {
      content.push({
        type: 'text',
        text: 'No screenshot is available right now (OBS not reachable), so go off the conversation and general encouragement instead — do not invent things you cannot see.',
      });
    }
    if (sceneName || streamContext) {
      const bits = [];
      if (sceneName) bits.push(`Current OBS scene name: "${sceneName}"`);
      if (streamContext) bits.push(`About this stream (from the streamer): ${streamContext}`);
      content.push({ type: 'text', text: bits.join('\n') });
    }
    if (notes) {
      content.push({
        type: 'text',
        text: `Your session notes (what has happened earlier this stream):\n${notes}`,
      });
    }
    if (transcript) {
      content.push({
        type: 'text',
        text: `Mic transcript — what the streamer said out loud recently (auto-generated, may contain errors):\n"${transcript}"`,
      });
    }
    const pointInstruction = talkingPoint
      ? `\n\nIf you can do it naturally this message, steer toward this topic the streamer wants to cover: "${talkingPoint}". If it would feel forced right now, skip it.`
      : '';
    const notesInstruction = updateNotes
      ? `\n\nThen, after your chat message, on a new line write exactly ---NOTES--- followed by an ` +
        `updated version of your session notes: plain text, under 100 words, covering the current ` +
        `game/activity, notable events, topics discussed, and running jokes. Carry forward old ` +
        `notes that still matter, drop stale ones.`
      : '';
    content.push({
      type: 'text',
      text: `${situation}\n\nRecent chat:\n${historyText}\n\n${task}${pointInstruction}${notesInstruction}`,
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: updateNotes ? 450 : 200,
      system: [{ type: 'text', text: this.buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });

    const raw = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    const [rawMsg, rawNotes] = raw.split(/-{3,}\s*NOTES\s*-{3,}/i);
    // Strip surrounding quotes or a leaked name prefix if the model adds one.
    const text = rawMsg
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(new RegExp(`^${this.botName}\\s*:\\s*`, 'i'), '');
    return {
      text,
      notes: rawNotes ? rawNotes.trim().slice(0, 1000) : null,
      usage: response.usage, // input/output/cache token counts for the cost meter
    };
  }
}
