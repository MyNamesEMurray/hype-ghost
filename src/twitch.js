/**
 * Read-only Twitch Helix client used ONLY to check the live viewer count,
 * so the bot can go quiet when real people are watching. It never reads or
 * writes Twitch chat and does not affect stream metrics in any way.
 *
 * Requires an application (client credentials) from dev.twitch.tv/console.
 * Entirely optional — without credentials the bot just uses manual override.
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
