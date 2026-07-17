import WebSocket from 'ws';

/**
 * Read-only Twitch chat activity monitor. Connects to Twitch IRC anonymously
 * (justinfan nick — no credentials, cannot send) and counts real chat
 * messages, so the ghost can go quiet when actual chat is ACTIVE rather than
 * when viewers merely exist. Nothing is ever posted; this is a listener.
 */
export class TwitchChat {
  constructor({ channel, onActivity }) {
    this.channel = String(channel || '').toLowerCase().replace(/^#/, '');
    this.onActivity = onActivity || (() => {});
    this.timestamps = []; // arrival times of recent real-chat messages
    this.ws = null;
    this.stopped = false;
  }

  start() {
    if (!this.channel) return;
    this.connect();
    console.log(`[chat] listening (read-only) to #${this.channel}`);
  }

  connect() {
    if (this.stopped) return;
    this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws.on('open', () => {
      // Anonymous read-only nick; Twitch accepts any justinfan<digits>.
      this.ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 80000));
      this.ws.send(`JOIN #${this.channel}`);
    });
    this.ws.on('message', (data) => {
      const text = data.toString();
      if (text.startsWith('PING')) {
        this.ws.send('PONG :tmi.twitch.tv');
        return;
      }
      if (text.includes(' PRIVMSG #')) {
        this.timestamps.push(Date.now());
        this.prune();
        this.onActivity(this.perMinute());
      }
    });
    // Reconnect with a slow backoff — chat awareness is a nicety, not a lifeline.
    this.ws.on('close', () => setTimeout(() => this.connect(), 30_000));
    this.ws.on('error', () => {});
  }

  prune() {
    const cutoff = Date.now() - 120_000;
    while (this.timestamps.length && this.timestamps[0] < cutoff) this.timestamps.shift();
  }

  /** Real chat messages per minute over the last 2 minutes. */
  perMinute() {
    this.prune();
    return this.timestamps.length / 2;
  }

  /** "Chat is carrying the room" — ghost should hang back. */
  isActive() {
    return this.perMinute() >= 2;
  }
}
