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

    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
    });
  }

  async ensureConnected() {
    if (this.connected) return;
    await this.obs.connect(this.url, this.password);
    this.connected = true;
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
      return { data: match[2], mediaType };
    } catch (err) {
      this.connected = false;
      return null;
    }
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
