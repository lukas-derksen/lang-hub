// YouTube embeds without loading YouTube's script: the player inside the iframe
// speaks the IFrame API's postMessage protocol, so we send it commands and read
// its time and state from the messages it posts back. That keeps the app's CSP
// at one frame-src (youtube-nocookie.com) and no third-party script.

export const YT_ORIGIN = 'https://www.youtube-nocookie.com';

/** Video id from a YouTube link (watch, youtu.be, shorts, embed, live) or a bare id. */
export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch (e) { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/) || [])[1];
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** Start time in seconds from a link's t= / start= parameter (e.g. 90, 1m30s), or 0. */
export function parseStart(input) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch (e) { return 0; }
  const t = u.searchParams.get('t') || u.searchParams.get('start') || '';
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) : 0;
}

export function embedUrl(id, { start = 0, captions = false, lang = 'it' } = {}) {
  const p = new URLSearchParams({
    enablejsapi: '1', origin: location.origin, playsinline: '1', rel: '0', modestbranding: '1',
    hl: lang, cc_lang_pref: lang, cc_load_policy: captions ? '1' : '0', iv_load_policy: '3',
  });
  if (start > 0) p.set('start', String(Math.floor(start)));
  return `${YT_ORIGIN}/embed/${encodeURIComponent(id)}?${p}`;
}

export const thumbUrl = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
export const watchUrl = (id, t = 0) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${t > 0 ? `&t=${Math.floor(t)}s` : ''}`;

// Player states, as in the IFrame API.
export const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
const ERRORS = {
  2: 'This video link isn\'t valid.',
  5: 'This video can\'t play in the embedded player.',
  100: 'This video was removed or made private.',
  101: 'The owner doesn\'t allow this video to be played in other apps.',
  150: 'The owner doesn\'t allow this video to be played in other apps.',
  153: 'YouTube refused to play this embed. Open it on YouTube instead.',
};

/**
 * Controller for one embedded player. `onChange()` is called when its state,
 * time or readiness changes. `time()` interpolates between YouTube's updates,
 * so a phrase can stop within ~50 ms of its end.
 */
export class Player {
  constructor(iframe, onChange) {
    this.iframe = iframe; this.onChange = onChange;
    this.ready = false; this.state = STATE.UNSTARTED; this.rate = 1; this.duration = 0; this.error = '';
    this._t = 0; this._at = performance.now(); this._stopAt = null; this._watch = 0;
    this._onMsg = (e) => this._message(e);
    window.addEventListener('message', this._onMsg);
    // Keep saying "listening" until the player answers (as YouTube's own script does).
    const hello = () => this.iframe.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN);
    iframe.addEventListener('load', hello);
    this._hello = setInterval(() => { if (this.ready) clearInterval(this._hello); else hello(); }, 250);
    this._giveUp = setTimeout(() => { if (!this.ready && !this.error) { this.error = 'The video player didn\'t load. Check your connection, or open the video on YouTube.'; this.onChange?.(); } }, 15000);
  }
  _message(e) {
    if (e.origin !== YT_ORIGIN || e.source !== this.iframe.contentWindow) return;
    let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    if (!d || typeof d !== 'object') return;
    if (d.event === 'onReady' || (d.event === 'initialDelivery' && !this.ready)) { this.ready = true; clearTimeout(this._giveUp); }
    if (d.event === 'onError') { this.error = ERRORS[d.info] || `YouTube couldn't play this video (error ${d.info}).`; }
    const info = d.event === 'onStateChange' ? { playerState: d.info } : d.info;
    if (info && typeof info === 'object') {
      if (typeof info.currentTime === 'number') { this._t = info.currentTime; this._at = performance.now(); }
      if (typeof info.playerState === 'number') { if (info.playerState === STATE.PLAYING && this.state !== STATE.PLAYING) this._at = performance.now(); this.state = info.playerState; }
      if (typeof info.playbackRate === 'number') this.rate = info.playbackRate;
      if (typeof info.duration === 'number' && info.duration > 0) this.duration = info.duration;
    }
    this.onChange?.();
  }
  cmd(func, args = []) { this.iframe.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), YT_ORIGIN); }
  time() { return this.state === STATE.PLAYING ? this._t + ((performance.now() - this._at) / 1000) * this.rate : this._t; }
  get playing() { return this.state === STATE.PLAYING || this.state === STATE.BUFFERING; }
  play() { this.cmd('playVideo'); }
  pause() { this._stopAt = null; this.cmd('pauseVideo'); }
  seek(t) { this._t = t; this._at = performance.now(); this.cmd('seekTo', [t, true]); }
  setRate(r) { this.rate = r; this.cmd('setPlaybackRate', [r]); }
  /** Play from `a` to `b` seconds; resolves when it reaches b (or is paused or stopped). */
  playRange(a, b) {
    this.seek(a); this.play();
    this._stopAt = b;
    clearInterval(this._watch);
    return new Promise((resolve) => {
      const started = performance.now();
      this._watch = setInterval(() => {
        const t = this.time();
        const stalled = performance.now() - started > ((b - a) / this.rate + 8) * 1000;
        if (this._stopAt == null || t >= b || stalled || (this.state === STATE.PAUSED && performance.now() - started > 800)) {
          clearInterval(this._watch);
          if (this._stopAt != null) { this._stopAt = null; this.cmd('pauseVideo'); }
          resolve();
        }
      }, 40);
    });
  }
  destroy() {
    clearInterval(this._hello); clearInterval(this._watch); clearTimeout(this._giveUp);
    window.removeEventListener('message', this._onMsg);
  }
}
