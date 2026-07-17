/**
 * Read-only Twitch Helix client used ONLY to check the live viewer count,
 * so the bot can go quiet when real people are watching. It never reads or
 * writes Twitch chat and does not affect stream metrics in any way.
 *
 * Requires an application (client credentials) from dev.twitch.tv/console.
 * Entirely optional twice over: without credentials the keyless DecApi
 * client below covers the same data, and without a channel at all the bot
 * just uses the dashboard's manual override.
 */
export class TwitchViewers {
  constructor({ clientId, clientSecret, channel }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.channel = channel;
    this.token = null;
    this.tokenExpiresAt = 0;
    this._broadcasterId = null; // resolved once from the channel login
  }

  headers() {
    return { 'Client-Id': this.clientId, Authorization: `Bearer ${this.token}` };
  }

  /** Resolve (and cache) the channel's numeric broadcaster id from its login. */
  async getBroadcasterId() {
    if (this._broadcasterId) return this._broadcasterId;
    await this.ensureToken();
    const url = new URL('https://api.twitch.tv/helix/users');
    url.searchParams.set('login', this.channel);
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Helix users request failed: ${res.status}`);
    const data = await res.json();
    this._broadcasterId = data.data?.[0]?.id || null;
    return this._broadcasterId;
  }

  /**
   * Current channel title + game/category, or null. Uses GET Channel
   * Information (Helix), which reflects the streamer's set title/category even
   * when they're offline — so the ghosts always know what's being played.
   * @returns {Promise<{title:string, game:string, tags:string[]}|null>}
   */
  async getChannelInfo() {
    if (!this.configured()) return null;
    try {
      await this.ensureToken();
      const bid = await this.getBroadcasterId();
      if (!bid) return null;
      const url = new URL('https://api.twitch.tv/helix/channels');
      url.searchParams.set('broadcaster_id', bid);
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`Helix channels request failed: ${res.status}`);
      const data = await res.json();
      const c = data.data?.[0];
      if (!c) return null;
      return { title: c.title || '', game: c.game_name || '', tags: c.tags || [] };
    } catch (err) {
      console.warn('[twitch] channel info failed:', err.message);
      return null;
    }
  }

  configured() {
    return Boolean(this.clientId && this.clientSecret && this.channel);
  }

  async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return;
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok) throw new Error(`Twitch token request failed: ${res.status}`);
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
  }

  /** Returns the live viewer count, or null if offline / not configured / error. */
  async getViewerCount() {
    if (!this.configured()) return null;
    try {
      await this.ensureToken();
      const url = new URL('https://api.twitch.tv/helix/streams');
      url.searchParams.set('user_login', this.channel);
      const res = await fetch(url, {
        headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) throw new Error(`Helix streams request failed: ${res.status}`);
      const data = await res.json();
      if (!data.data || data.data.length === 0) return 0; // offline
      return data.data[0].viewer_count ?? 0;
    } catch (err) {
      console.warn('[twitch] viewer check failed:', err.message);
      return null;
    }
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * DecAPI answers in plain text with HTTP 200 even for errors ("User not
 * found: x"), so values are validated by shape rather than status code.
 * Returns the value ('' when the field is simply unset), or null on a
 * recognized error sentence.
 */
export function parseDecapiValue(text, channel) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (new RegExp(`^user not found: ?${escapeRe(channel)}$`, 'i').test(t)) return null;
  return t;
}

/**
 * Viewer count comes back as a bare integer when live and
 * "<channel> is offline" otherwise (which maps to 0, matching Helix's
 * offline behavior). Anything else is an error — null, "unavailable".
 */
export function parseDecapiViewers(text, channel) {
  const t = String(text ?? '').trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (new RegExp(`^${escapeRe(channel)} is offline$`, 'i').test(t)) return 0;
  return null;
}

/**
 * Keyless fallback for stream info + viewer count via DecAPI
 * (https://decapi.me) — a long-running community proxy for the Twitch API,
 * the same one chat-command bots lean on. Needs only the channel name, so
 * the dev-app credentials above become a power-user option instead of a
 * setup requirement. Read-only like everything else that touches Twitch;
 * the only data sent is the (public) channel name, and twitch.decapi:false
 * opts out entirely.
 */
export class DecApi {
  constructor({ channel, enabled }) {
    this.channel = String(channel || '').toLowerCase().replace(/^#/, '');
    this.enabled = enabled !== false;
  }

  configured() {
    return this.enabled && Boolean(this.channel);
  }

  async fetchText(endpoint) {
    const res = await fetch(`https://decapi.me/twitch/${endpoint}/${encodeURIComponent(this.channel)}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'hype-ghost (https://github.com/MyNamesEMurray/hype-ghost)' },
    });
    if (!res.ok) throw new Error(`decapi ${endpoint} returned ${res.status}`);
    return (await res.text()).trim();
  }

  /**
   * Current channel title + game/category, or null. Like Helix's channel
   * info, DecAPI serves the streamer's set title/category even while
   * offline — so the ghosts always know what's being played.
   * @returns {Promise<{title:string, game:string, tags:string[]}|null>}
   */
  async getChannelInfo() {
    if (!this.configured()) return null;
    try {
      const [title, game] = await Promise.all([this.fetchText('title'), this.fetchText('game')]);
      const t = parseDecapiValue(title, this.channel);
      const g = parseDecapiValue(game, this.channel);
      if (t === null && g === null) return null; // channel not found
      return { title: t || '', game: g || '', tags: [] };
    } catch (err) {
      console.warn('[twitch] decapi channel info failed:', err.message);
      return null;
    }
  }

  /** Returns the live viewer count, 0 when offline, or null on error. */
  async getViewerCount() {
    if (!this.configured()) return null;
    try {
      return parseDecapiViewers(await this.fetchText('viewercount'), this.channel);
    } catch (err) {
      console.warn('[twitch] decapi viewer check failed:', err.message);
      return null;
    }
  }
}
