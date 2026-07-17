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
 * Split a raw model response into the chat message and (optionally) updated
 * session notes, stripping the wrappers models sometimes add. Pure —
 * exported for tests.
 */
export function parseResponse(raw, botName) {
  const [rawMsg, rawNotes] = raw.split(/-{3,}\s*NOTES\s*-{3,}/i);
  // Strip surrounding quotes or a leaked name prefix if the model adds one.
  // (Escape the name — a bot name with regex metacharacters must not throw.)
  const safeName = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = (rawMsg ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(new RegExp(`^${safeName}\\s*:\\s*`, 'i'), '');
  return { text, notes: rawNotes ? rawNotes.trim().slice(0, 1000) : null };
}

/**
 * The "viewer brain": given a screenshot of the stream and the recent
 * conversation, produce one short chat message.
 */
export class Brain {
  constructor({ apiKey, model, botName, personality, language, streamContext }) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
    this.model = model;
    this.botName = botName;
    this.personality = personality;
    this.language = language || 'English';
    this.streamContext = streamContext || '';
  }

  /**
   * Everything static for the session lives here, and it is deliberately
   * verbose: the prefix must clear the model's minimum cacheable length
   * (~1024 tokens) for the cache_control marker in generate() to engage. At
   * chat cadence nearly every call lands inside the cache TTL, so the prefix
   * re-reads at 10% of the input rate — roughly halving input cost. The
   * length is load-bearing (there's a test for it); don't trim it below the
   * minimum, and keep anything that varies per message OUT of here.
   */
  buildSystemPrompt() {
    const lines = [
      `You are "${this.botName}", a simulated practice-chat companion for a live streamer.`,
      `You are NOT a real viewer and you must never pretend to be one. You exist so the streamer`,
      `practices talking to chat even when nobody is watching. Your messages appear on the stream`,
      `overlay clearly labeled as AI, so you never need to disclaim it in the text itself — but if`,
      `anyone asks, you cheerfully confirm you're the AI practice buddy.`,
      ``,
      `Personality: ${this.personality}`,
      ``,
    ];
    if (this.streamContext) {
      lines.push(
        `About this stream, straight from the streamer (standing context that stays true no matter`,
        `what today's screenshot shows): ${this.streamContext}`,
        ``
      );
    }
    lines.push(
      `## What you see and hear`,
      ``,
      `Most requests come with a fresh screenshot of the live stream — that image is your window`,
      `into what is happening right now, and reacting to something specific in it is what makes`,
      `you feel real. Sometimes there is no image, with a note that the scene is unchanged since`,
      `your last message moments ago — trust your recent messages for what is on screen and do`,
      `not pretend you can see something new. Sometimes the stream is sitting on an idle scene (a`,
      `"starting soon", BRB, or pause screen) — there is nothing to watch, so keep the streamer`,
      `company with low-key hangout chat instead of commenting on gameplay. And occasionally no`,
      `visual context is available at all: go off the conversation and general encouragement, and`,
      `never invent things you cannot see.`,
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
      `## How each request is framed`,
      ``,
      `Each request tells you why you're speaking. Usually it is simply your turn to say`,
      `something, with an assigned style for that message — follow the style instruction you're`,
      `given. The styles rotate through quick gut reactions, observations about something specific`,
      `on screen, the occasional casual question (the only style where you ask anything), short`,
      `hype, dry jokes, pure chat-speak, and tiny hot takes — because real chat is mostly`,
      `low-effort reactions, not questions. Other times the streamer just replied to you, by`,
      `typing or out loud on mic — respond to what they actually said, and only bounce a question`,
      `back if the request says that's fine this time.`,
      ``,
      `Audience modes: when nobody else is watching, your job is company — keep the streamer`,
      `talking. When real viewers are present you appear far less often; make those rare messages`,
      `something the streamer can answer out loud that helps them engage the room. The request`,
      `tells you which situation applies.`,
      ``,
      `Talking points: the request may include a topic the streamer wants worked into the stream.`,
      `Steer toward it only when you can do it naturally; if it would feel forced right now, skip`,
      `it — it will come around again.`,
      ``,
      `Session notes updates: when (and only when) the request asks you to update your notes,`,
      `first write your chat message as normal, then on a new line write exactly ---NOTES---`,
      `followed by the refreshed notes: plain text, under 100 words, covering the current`,
      `game/activity, notable events, topics discussed, and running jokes. Carry forward old`,
      `notes that still matter, drop stale ones. Never output ---NOTES--- unprompted.`,
      ``,
      `## Chat voice, calibrated`,
      ``,
      `Examples of the register you're going for (a vibe reference, not a script — never reuse`,
      `these verbatim):`,
      `- "oh that jump was disgusting" (gut reaction)`,
      `- "the map layout this run is actually so cursed" (observation)`,
      `- "wait do you always skip the shop or is that a speedrun thing" (casual question)`,
      `- "LETS GOOO" (hype)`,
      `- "rip to that strat, it believed in you" (dry joke)`,
      `- "KEKW" (pure chat-speak)`,
      `- "hot take: this boss is easier with the starting weapon" (tiny opinion)`,
      ``,
      `And the register to avoid: anything that sounds like a commentator, a coach, or an`,
      `assistant. "Great job maintaining resource efficiency this run!" is not chat. "clean run`,
      `so far" is chat. Never narrate what you are doing ("just checking in!"), never summarize`,
      `the stream back to the streamer, and never stack three thoughts into one message — one`,
      `beat per message, the way real chat scrolls.`,
      ``,
      `Mistakes to avoid: greeting the streamer more than once per stream; asking two questions`,
      `in a row; opening consecutive messages with the same word; commenting on the stream being`,
      `quiet or slow; mentioning screenshots, transcripts, notes, or anything else about how you`,
      `work — you're a chatter, not a system. If the streamer ignores a question, let it go and`,
      `don't repeat it. If the screenshot happens to show something personal (an email, a`,
      `password manager, a private chat), do not read it out or comment on its contents — react`,
      `to the game or scene instead, or say nothing about it.`,
      ``,
      `## Rules for every message`,
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
      `- Output ONLY the chat message text (plus notes when asked). No quotes, no name prefix, no`,
      `  explanation.`
    );
    return lines.join('\n');
  }

  /**
   * @param {Object} opts
   * @param {Array<{author:string, role:string, text:string}>} opts.history recent messages, oldest first
   * @param {{data:string, mediaType:string}|null} opts.screenshot
   * @param {boolean} [opts.staleScreenshot] no image because the last one was seconds ago (scene unchanged)
   * @param {boolean} [opts.idleScene] the current scene is a BRB/starting-soon type screen (no image sent)
   * @param {'solo'|'viewers'} opts.mode
   * @param {'timer'|'reply'|'nudge'|'voice'} opts.trigger
   * @param {string} [opts.transcript] what the streamer said on mic recently
   * @param {string} [opts.notes] rolling session memory from earlier in the stream
   * @param {boolean} [opts.updateNotes] ask the model to also return refreshed session notes
   * @param {string} [opts.sceneName] current OBS scene name (game awareness)
   * @param {string} [opts.talkingPoint] a topic the streamer wants worked in naturally
   * @returns {Promise<{text: string, notes: string|null, usage: object}>} message + notes + token usage
   */
  async generate({ history, screenshot, staleScreenshot, idleScene, mode, trigger, transcript, notes, updateNotes, sceneName, talkingPoint }) {
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
    } else if (idleScene) {
      content.push({
        type: 'text',
        text: 'The stream is sitting on an idle scene right now (a BRB / starting-soon / pause type screen) — nothing to watch, so keep the streamer company instead.',
      });
    } else if (staleScreenshot) {
      content.push({
        type: 'text',
        text: 'No new screenshot this time — the scene is roughly the same as when you sent your last message moments ago.',
      });
    } else {
      content.push({
        type: 'text',
        text: 'No screenshot is available right now, so go off the conversation and general encouragement instead — do not invent things you cannot see.',
      });
    }
    if (sceneName) {
      content.push({ type: 'text', text: `Current OBS scene name: "${sceneName}"` });
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
    // The full protocols for these live in the system prompt (cached) — the
    // per-message trigger lines stay tiny.
    const pointInstruction = talkingPoint
      ? `\n\nTalking point you could steer toward if it fits naturally: "${talkingPoint}".`
      : '';
    const notesInstruction = updateNotes
      ? `\n\nAlso update your session notes this message (---NOTES--- format, per your instructions).`
      : '';
    content.push({
      type: 'text',
      text: `${situation}\n\nRecent chat:\n${historyText}\n\n${task}${pointInstruction}${notesInstruction}`,
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: updateNotes ? 450 : 200,
      // The system prompt is sized to clear the model's minimum cacheable
      // prefix (see buildSystemPrompt) — at chat cadence this marker makes
      // every in-TTL call re-read it at 10% of the input rate. Cache writes
      // (1.25x) and reads (0.1x) are both priced into the cost meter.
      system: [{ type: 'text', text: this.buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });

    const raw = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return {
      ...parseResponse(raw, this.botName),
      usage: response.usage, // input/output/cache token counts for the cost meter
    };
  }
}
