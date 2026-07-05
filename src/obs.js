import { OBSWebSocket } from 'obs-websocket-js';

/**
 * Thin wrapper around obs-websocket for grabbing screenshots of whatever
 * is currently live (the program scene). Requires OBS 28+ with the
 * WebSocket server enabled (Tools -> WebSocket Server Settings).
 */
export class ObsCapture {
  constructor(url, password, screenshotWidth) {
    this.url = url;
    this.password = password || undefined;
    // Image tokens scale with pixel count (w*h/750), not JPEG quality —
    // 800px wide is ~480 tokens vs ~1230 at 1280px, with the same full frame.
    this.screenshotWidth = screenshotWidth ?? 800;
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.connectPromise = null; // dedupes concurrent connect attempts
    this.nextAttemptAt = 0; // reconnect backoff while OBS is closed

    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
    });
  }

  async ensureConnected() {
    if (this.connected) return;
    // Concurrent callers (screenshot loop + transcript poll) share one
    // attempt instead of racing connects on the same socket.
    if (this.connectPromise) return this.connectPromise;
    if (Date.now() < this.nextAttemptAt) throw new Error('OBS not reachable (retrying shortly)');
    this.connectPromise = this.obs
      .connect(this.url, this.password)
      .then(() => {
        this.connected = true;
        this.nextAttemptAt = 0;
      })
      .catch((err) => {
        // Back off so a closed OBS isn't hammered with a TCP connect every
        // 2s poll — one attempt per 30s is plenty to notice it coming back.
        this.nextAttemptAt = Date.now() + 30_000;
        throw err;
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  /**
   * Returns { data, mediaType } where data is raw base64 (no data: prefix),
   * or null if OBS is unreachable.
   */
  async screenshot() {
    try {
      await this.ensureConnected();
      const { currentProgramSceneName } = await this.obs.call('GetCurrentProgramScene');
      const { imageData } = await this.obs.call('GetSourceScreenshot', {
        sourceName: currentProgramSceneName,
        imageFormat: 'jpg',
        imageWidth: this.screenshotWidth,
        imageCompressionQuality: 70,
      });
      // imageData looks like "data:image/jpg;base64,AAAA..."
      const match = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(imageData);
      if (!match) return null;
      const mediaType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
      return { data: match[2], mediaType, sceneName: currentProgramSceneName };
    } catch (err) {
      this.connected = false;
      return null;
    }
  }

  /**
   * One-click overlay: create (or repoint) a browser source named
   * "Hype Ghost Overlay" in the current program scene.
   */
  async installOverlay(url) {
    await this.ensureConnected();
    const NAME = 'Hype Ghost Overlay';
    const { inputs } = await this.obs.call('GetInputList');
    if (inputs.some((i) => i.inputName === NAME)) {
      await this.obs.call('SetInputSettings', { inputName: NAME, inputSettings: { url } });
      return { created: false };
    }
    const { currentProgramSceneName } = await this.obs.call('GetCurrentProgramScene');
    await this.obs.call('CreateInput', {
      sceneName: currentProgramSceneName,
      inputName: NAME,
      inputKind: 'browser_source',
      inputSettings: { url, width: 460, height: 600 },
    });
    return { created: true, scene: currentProgramSceneName };
  }

  /**
   * Current text of an OBS text source (used to read LocalVocal's caption
   * output). Returns null if OBS is unreachable or the source doesn't exist.
   */
  async getTextSourceText(inputName) {
    try {
      await this.ensureConnected();
    } catch {
      this.connected = false;
      return null;
    }
    try {
      const { inputSettings } = await this.obs.call('GetInputSettings', { inputName });
      return typeof inputSettings.text === 'string' ? inputSettings.text : null;
    } catch {
      // Request-level error (e.g. wrong source name) — connection is still fine.
      return null;
    }
  }
}
