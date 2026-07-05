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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The "viewer brain": given a screenshot of the stream and the recent
 * conversation, produce the next chat message(s) from one or two simulated
 * viewers ("personas"), plus optional session-notes / long-term-profile
 * updates piggybacked on the same call.
 *
 * Providers: the Anthropic API (default), or any OpenAI-compatible endpoint
 * (Ollama, LM Studio, Groq, Gemini's compat layer, …) for local/free use.
 */
export class Brain {
  /**
   * @param {Object} opts
   * @param {{provider:string, openaiBaseUrl:string, openaiModel:string, openaiApiKey:string}} opts.brain
   * @param {{apiKey:string, model:string}} opts.anthropic
   * @param {Array<{name:string, personality:string}>} opts.personas 1 or 2 entries
   * @param {string} opts.language
   */
  constructor({ brain, anthropic, personas, language }) {
    this.provider = brain.provider === 'openai' ? 'openai' : 'anthropic';
    this.personas = personas;
    this.language = language || 'English';
    if (this.provider === 'anthropic') {
      const apiKey = anthropic.apiKey || process.env.ANTHROPIC_API_KEY || '';
      this.client = new Anthropic(apiKey ? { apiKey } : {});
      this.model = anthropic.model;
    } else {
      this.baseUrl = (brain.openaiBaseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
      this.model = brain.openaiModel;
      this.apiKey = brain.openaiApiKey || '';
    }
  }

  buildSystemPrompt() {
    const [p1, p2] = this.personas;
    const who = p2
      ? [
          `You simulate a tiny practice chat of TWO viewers for a live streamer:`,
          `- ${p1.name}: ${p1.personality}`,
          `- ${p2.name}: ${p2.personality}`,
          `They are distinct people with different voices; they sometimes react to each other,`,
          `but the streamer is always the center of the room — never let the two of them drift`,
          `into a private conversation.`,
        ]
      : [`You are "${p1.name}", a simulated practice-chat companion for a live streamer.`, `Personality: ${p1.personality}`];
    return [
      ...who,
      `These viewers are NOT real and must never pretend to be. They exist so the streamer`,
      `practices talking to chat even when nobody is watching. Messages appear on the stream`,
      `overlay clearly labeled as AI — no need to disclaim it in the text, but if asked,`,
      `cheerfully confirm being the AI practice buddies.`,
      ``,
      `You may be given an auto-generated transcript of what the streamer said out loud on mic.`,
      `Treat it as the streamer talking to chat: follow up naturally, never quote it verbatim`,
      `or correct its errors.`,
      ``,
      `You may be given "session notes" (memory of THIS stream) and a "viewer profile"`,
      `(long-term memory across streams: per-game progress, running jokes, facts about the`,
      `streamer). Use both for continuity — callbacks are what make the chat feel present.`,
      ``,
      `Rules for every message:`,
      `- Write every chat message in ${this.language}.`,
      `- Write like real Twitch chatters: casual, lowercase, imperfect punctuation, no markdown.`,
      `- Most messages are NOT questions — reactions, observations, jokes, hot takes.`,
      `- Vary length a lot: sometimes 2-4 words, sometimes a sentence or two. Emote-words are`,
      `  fine occasionally (LUL, KEKW, Pog) but don't overdo it.`,
      `- React to what is actually visible in the screenshot; specific beats generic.`,
      `- Never repeat the angle, opener, or sentence shape of recent messages.`,
      `- Never hype-bot spam, never beg for follows, never mention viewer counts.`,
      `- If the screenshot shows a "starting soon" / "BRB" / paused screen, keep it to low-key`,
      `  hangout talk.`,
      ``,
      `OUTPUT FORMAT — follow exactly:`,
      `Each message on its own line as "NAME: message text" using the viewer names above.`,
      `No other text, no quotes, no explanations.`,
    ].join('\n');
  }

  /**
   * @returns {Promise<{messages: Array<{speaker:string, text:string}>, notes: string|null, profile: string|null, usage: object}>}
   */
  async generate({
    history, screenshot, staleScreenshot, mode, trigger, transcript, notes, profile,
    updateNotes, updateProfile, sceneName, streamContext, talkingPoint, allowExchange,
  }) {
    const names = this.personas.map((p) => p.name);
    const historyText = history.length
      ? history
          .map((m) => `${m.role === 'bot' ? m.author + (names.includes(m.author) ? '' : ' (you)') : 'Streamer'}: ${m.text}`)
          .join('\n')
      : '(no messages yet — this is the first message of the stream)';

    const situation =
      mode === 'viewers'
        ? 'Real viewers are currently around. Chime in briefly with something that helps the streamer engage the room — do not compete with real chat.'
        : 'Nobody else is watching right now. Keep the streamer company and keep them talking.';

    const replyTail =
      Math.random() < 0.35
        ? 'A quick follow-up question is fine if it feels natural.'
        : 'Just react — a statement, joke, or agreement. Do NOT ask anything back this time.';
    const exchangeNote =
      this.personas.length > 1
        ? allowExchange
          ? ' If the moment invites it, this may be a quick 2-message exchange (both viewers, second one riffing on the first) — but one message is usually right.'
          : ' Exactly ONE message from ONE viewer this time.'
        : '';
    const task =
      trigger === 'reply'
        ? `The streamer just replied in chat (last message below). Respond to what they said. ${replyTail}${exchangeNote}`
        : trigger === 'voice'
          ? `The streamer just responded out loud — see the mic transcript. React to what they actually said. ${replyTail}${exchangeNote}`
          : `Send the next chat message based on what is happening on stream right now. Style for it: ${pickStyle()}.${exchangeNote}`;

    const blocks = [];
    if (screenshot) {
      blocks.push({ image: screenshot });
      blocks.push({ text: 'Above is a live screenshot of the stream right now.' });
    } else if (staleScreenshot) {
      blocks.push({ text: 'No new screenshot this time — the scene is roughly the same as moments ago.' });
    } else {
      blocks.push({ text: 'No screenshot is available (OBS not reachable) — go off the conversation instead; do not invent things you cannot see.' });
    }
    if (sceneName || streamContext) {
      const bits = [];
      if (sceneName) bits.push(`Current OBS scene name: "${sceneName}"`);
      if (streamContext) bits.push(`About this stream (from the streamer): ${streamContext}`);
      blocks.push({ text: bits.join('\n') });
    }
    if (profile) blocks.push({ text: `Viewer profile (long-term memory from previous streams):\n${profile}` });
    if (notes) blocks.push({ text: `Session notes (what has happened earlier this stream):\n${notes}` });
    if (transcript) blocks.push({ text: `Mic transcript — what the streamer said out loud recently (auto-generated, may contain errors):\n"${transcript}"` });

    const pointInstruction = talkingPoint
      ? `\n\nIf it can be done naturally this message, steer toward this topic the streamer wants covered: "${talkingPoint}". If it would feel forced, skip it.`
      : '';
    const notesInstruction = updateNotes
      ? `\n\nAfter the chat message(s), on a new line write exactly ---NOTES--- followed by updated session notes: plain text, under 100 words — current game/activity, notable events, topics discussed, running jokes.`
      : '';
    const profileInstruction = updateProfile
      ? `\n\nThen on a new line write exactly ---PROFILE--- followed by an updated viewer profile: plain text, under 150 words of LONG-TERM memory worth keeping across streams — per-game progress ("Hades: reached heat 16"), recurring jokes, facts about the streamer. Merge with the existing profile; drop stale trivia.`
      : '';
    blocks.push({ text: `${situation}\n\nRecent chat:\n${historyText}\n\n${task}${pointInstruction}${notesInstruction}${profileInstruction}` });

    const maxTokens = 200 + (updateNotes ? 250 : 0) + (updateProfile ? 300 : 0);
    const { raw, usage } =
      this.provider === 'anthropic'
        ? await this.callAnthropic(blocks, maxTokens)
        : await this.callOpenAI(blocks, maxTokens);

    // Split off piggybacked memory blocks, then parse "NAME: text" lines.
    const [msgPart, tail1] = raw.split(/-{3,}\s*NOTES\s*-{3,}/i);
    let newNotes = null;
    let newProfile = null;
    if (tail1 !== undefined) {
      const [n, p] = tail1.split(/-{3,}\s*PROFILE\s*-{3,}/i);
      newNotes = n.trim().slice(0, 1000) || null;
      if (p !== undefined) newProfile = p.trim().slice(0, 1500) || null;
    } else {
      const [m2, p] = msgPart.split(/-{3,}\s*PROFILE\s*-{3,}/i);
      if (p !== undefined) newProfile = p.trim().slice(0, 1500) || null;
      if (p !== undefined) return { messages: this.parseMessages(m2), notes: null, profile: newProfile, usage };
    }
    return { messages: this.parseMessages(msgPart), notes: newNotes, profile: newProfile, usage };
  }

  parseMessages(raw) {
    const names = this.personas.map((p) => p.name);
    const nameRe = new RegExp(`^\\s*(${names.map(escapeRe).join('|')})\\s*:\\s*(.+)$`, 'i');
    const messages = [];
    for (const line of raw.trim().split(/\n+/)) {
      const m = nameRe.exec(line);
      if (m) {
        const speaker = names.find((n) => n.toLowerCase() === m[1].toLowerCase());
        messages.push({ speaker, text: m[2].trim().replace(/^["']|["']$/g, '') });
      }
    }
    // Model didn't follow the NAME: format — treat the whole thing as one
    // message from the primary persona rather than dropping it.
    if (!messages.length) {
      const text = raw.trim().replace(/^["']|["']$/g, '');
      if (text) messages.push({ speaker: names[0], text });
    }
    return messages.slice(0, 2); // hard cap, whatever the model does
  }

  async callAnthropic(blocks, maxTokens) {
    const content = blocks.map((b) =>
      b.image
        ? { type: 'image', source: { type: 'base64', media_type: b.image.mediaType, data: b.image.data } }
        : { type: 'text', text: b.text }
    );
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      // Inert below the model's minimum cacheable prefix; engages automatically
      // (and beneficially, at this cadence) if the prompt ever grows past it.
      system: [{ type: 'text', text: this.buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });
    const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    return { raw, usage: response.usage };
  }

  async callOpenAI(blocks, maxTokens) {
    const content = blocks.map((b) =>
      b.image
        ? { type: 'image_url', image_url: { url: `data:${b.image.mediaType};base64,${b.image.data}` } }
        : { type: 'text', text: b.text }
    );
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: this.buildSystemPrompt() },
          { role: 'user', content },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${this.baseUrl} returned ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    // Normalize usage to the Anthropic field names the cost meter reads.
    const usage = data.usage
      ? { input_tokens: data.usage.prompt_tokens || 0, output_tokens: data.usage.completion_tokens || 0 }
      : null;
    return { raw, usage };
  }
}
