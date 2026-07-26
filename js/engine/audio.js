/**
 * Minimal WebAudio manager: decodes OGG files once and plays them with
 * per-call volume / playback-rate jitter. The AudioContext is created in the
 * constructor but only resumes on unlock() (call from a user gesture).
 *
 * Sound files are CC0 (Kenney.nl), vendored under assets/sounds/.
 */
export class AudioManager {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {Map<string, AudioBuffer>} */
    this.buffers = new Map();
    /** Master volume multiplier applied to every play(). */
    this.master = 0.8;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.ctx = null; // no WebAudio — every call becomes a no-op
    }
  }

  /**
   * Preload and decode a named sound. Safe to fire-and-forget; failures are
   * silent (the game works without audio).
   * @param {string} name
   * @param {string} url
   */
  async load(name, url) {
    if (!this.ctx) return;
    try {
      const res = await fetch(url);
      const data = await res.arrayBuffer();
      this.buffers.set(name, await this.ctx.decodeAudioData(data));
    } catch {
      // missing/undecodable file — skip silently
    }
  }

  /**
   * Preload a { name: url } map in parallel.
   * @param {Record<string, string>} manifest
   */
  loadAll(manifest) {
    return Promise.all(Object.entries(manifest).map(([n, u]) => this.load(n, u)));
  }

  /** Resume the context — must be called from a user gesture at least once. */
  unlock() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /**
   * Play a loaded sound.
   * @param {string} name
   * @param {{ volume?: number, rate?: number, jitter?: number }} [opts]
   *   volume: 0..1 (multiplied by master). rate: playback rate (pitch).
   *   jitter: random ± rate variation (e.g. 0.08 for gunshots).
   */
  play(name, opts = {}) {
    const buf = this.buffers.get(name);
    if (!this.ctx || !buf || this.ctx.state !== 'running') return;
    const { volume = 1, rate = 1, jitter = 0 } = opts;
    if (volume <= 0.001) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate + (jitter ? (Math.random() * 2 - 1) * jitter : 0);
    const gain = this.ctx.createGain();
    gain.gain.value = Math.min(1, Math.max(0, volume * this.master));
    src.connect(gain).connect(this.ctx.destination);
    src.start();
  }
}
