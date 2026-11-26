// Listening trainer: clips voiced by ElevenLabs on first play (with your key),
// cached on this device, played with speed control and optional background noise.
import * as store from './store.js';
import { levelNum } from './recommend.js';
import { ratingCard } from './picks.js';
import * as server from './server.js';

let H = {};
export function init(helpers) { H = helpers; }
const esc = (s) => H.esc(s);

// Text to speech model for clips. eleven_multilingual_v2 sounds most natural and
// costs about 1 credit per character; eleven_flash_v2_5 costs about half (0.5 per
// character) but sounds flatter. Changing it re-voices clips on their next play.
const TTS_MODEL = 'eleven_multilingual_v2';
const CREDITS_PER_CHAR = { eleven_flash_v2_5: 0.5, eleven_turbo_v2_5: 0.5 }[TTS_MODEL] ?? 1;
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.8, style: 0.25, speed: 1.0 };
const CLIP_CACHE = 'lhclips-v1'; // separate from the app-shell cache so updates keep clips
const VOICED_KEY = 'langhub.voiced'; // clip ids voiced on this device (not in the backup)
const GAP = 0.45; // seconds of silence between dialogue turns

// ---------- content ----------
let data = null, loadErr = null, loadingP = null;
function ready() {
  if (data) return true;
  if (loadErr) return false; // retried on 'online' or with the Try again button
  loadingP ||= fetch(`${H.L().content}clips.json`)
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((d) => { data = { ...d, clips: [...server.byKind('clip'), ...d.clips] }; afterLoad(); })
    .catch(() => { loadErr = 'Could not load the clips. Connect to the internet and try again.'; loadingP = null; })
    .finally(() => H.render());
  return false;
}
function retryLoad() {
  if (data || loadingP) return;
  loadErr = null;
  if (location.hash.startsWith('#/listen')) H.render(); // render calls ready(), which fetches again
}
window.addEventListener('online', retryLoad);
/** Forget the loaded clips (new ones arrived from the content server). Not while a clip is open. */
export function reset() { if (player) return false; data = null; loadErr = null; loadingP = null; return true; }

const chars = (clip) => clip.segments.reduce((a, s) => a + s.text.length, 0);
const credits = (n) => Math.round(n * CREDITS_PER_CHAR).toLocaleString('en-GB');
const speakersOf = (clip) => [...new Set(clip.segments.map((s) => s.voice))].map((v) => data.voices[v]);

// ---------- audio generation + cache ----------
/** FNV-1a 32-bit hash as 8 hex digits: short and stable, not for security. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
// The cache URL includes a hash of the text, model and voice settings, so editing a
// clip's text (or the model) voices it again instead of playing the old audio.
const segHash = (seg) => fnv1a(`${seg.text}\u0000${TTS_MODEL}\u0000${JSON.stringify(VOICE_SETTINGS)}`);
const segBase = (clip, i) => `${clip.id}-${i}-${data.voices[clip.segments[i].voice].id}`;
const segUrl = (clip, i) => new URL(`clips-cache/${segBase(clip, i)}-${segHash(clip.segments[i])}.mp3`, location.href).href;

function voicedSet() { try { return new Set(JSON.parse(localStorage.getItem(VOICED_KEY)) || []); } catch (e) { return new Set(); } }
function markVoiced(id) {
  const s = voicedSet(); if (s.has(id)) return;
  s.add(id); try { localStorage.setItem(VOICED_KEY, JSON.stringify([...s])); } catch (e) { /* storage full */ }
}

/** Indexes of the segments that aren't in the cache yet. */
async function missingSegments(clip) {
  try {
    const c = await caches.open(CLIP_CACHE);
    const hits = await Promise.all(clip.segments.map((_, i) => c.match(segUrl(clip, i))));
    return hits.map((h, i) => (h ? -1 : i)).filter((i) => i >= 0);
  } catch (e) { return clip.segments.map((_, i) => i); }
}

/**
 * Once after the clips load (when idle): move audio cached under the old key format
 * (no hash; clips.json hasn't changed since then, so it matches the current text)
 * to the new key, and delete audio that no longer matches any current segment.
 * Entries whose clip id isn't in this language's clips are left alone.
 */
async function cleanClipCache() {
  try {
    const c = await caches.open(CLIP_CACHE);
    const current = new Map(); // base -> hashed url
    data.clips.forEach((clip) => clip.segments.forEach((_, i) => current.set(segBase(clip, i), segUrl(clip, i))));
    const ids = new Set(data.clips.map((x) => x.id));
    const wanted = new Set(current.values());
    for (const req of await c.keys()) {
      if (wanted.has(req.url)) continue;
      const m = req.url.match(/\/clips-cache\/(.+)-(\d+)-([A-Za-z0-9]+)(?:-([0-9a-f]{8}))?\.mp3$/);
      if (!m || !ids.has(m[1])) continue;
      const base = `${m[1]}-${m[2]}-${m[3]}`;
      if (!m[4] && current.has(base) && !(await c.match(current.get(base)))) {
        await c.put(current.get(base), await c.match(req)); // legacy key -> hashed key
        markVoiced(m[1]);
      }
      await c.delete(req);
    }
  } catch (e) { /* no Cache Storage */ }
}
function afterLoad() {
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
  idle(() => cleanClipCache());
}

/** Readable message for an ElevenLabs error response (detail.status says why). */
async function ttsError(res, clip) {
  let code = '', msg = '';
  try {
    const j = await res.json();
    const d = j?.detail;
    if (d && typeof d === 'object') { code = d.status || d.code || ''; msg = d.message || ''; } else if (typeof d === 'string') msg = d;
  } catch (e) { /* not JSON */ }
  if (code === 'quota_exceeded') return `Not enough ElevenLabs credits left this month to voice this clip (about ${credits(chars(clip))} needed).`;
  if (code === 'invalid_api_key') return 'ElevenLabs rejected the API key. Check it in Settings.';
  if (code === 'missing_permissions' || res.status === 403) return 'Your API key needs the "Text to Speech" permission for new clips.';
  if (res.status === 429 || code === 'too_many_concurrent_requests' || code === 'system_busy') return 'ElevenLabs is busy right now (too many requests). Wait a moment and try again.';
  if (res.status === 401) return `ElevenLabs refused the request${msg ? `: ${msg}` : '. Check your key in Settings.'}`;
  return `ElevenLabs couldn't voice this clip (${res.status}${msg ? `: ${msg}` : ''}).`;
}

async function isCached(clip) {
  const ok = (await missingSegments(clip)).length === 0;
  if (ok) markVoiced(clip.id);
  return ok;
}

async function fetchSegment(clip, i) {
  const url = segUrl(clip, i);
  let cache = null;
  try { cache = await caches.open(CLIP_CACHE); const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); } catch (e) { /* no cache */ }
  if (server.enabled()) {
    // Voiced once on your content server and shared by all your devices.
    const buf = await server.segmentAudio(clip.id, i);
    try { await cache?.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'audio/mpeg' } })); } catch (e) { /* storage full */ }
    return buf;
  }
  const key = store.getApiKey();
  if (!key) throw new Error('Add your ElevenLabs API key in Settings to voice new clips.');
  const seg = clip.segments[i];
  let res;
  try {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${data.voices[seg.voice].id}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: seg.text, model_id: TTS_MODEL, voice_settings: VOICE_SETTINGS }),
    });
  } catch (e) { throw new Error('Could not reach ElevenLabs. Check your internet connection.'); }
  if (!res.ok) throw new Error(await ttsError(res, clip));
  const buf = await res.arrayBuffer();
  try { await cache?.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': 'audio/mpeg' } })); } catch (e) { /* storage full */ }
  return buf;
}

let actx = null;
const ctx = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());

/** Decode all segments and join them (with short gaps) into one AudioBuffer. */
async function buildClipBuffer(clip, onProgress) {
  const raw = [];
  for (let i = 0; i < clip.segments.length; i++) { raw.push(await fetchSegment(clip, i)); onProgress?.(i + 1, clip.segments.length); }
  const decoded = await Promise.all(raw.map((b) => ctx().decodeAudioData(b)));
  const sr = decoded[0].sampleRate;
  const gap = Math.round(GAP * sr);
  const len = decoded.reduce((a, b) => a + b.length, 0) + gap * (decoded.length - 1);
  const out = ctx().createBuffer(1, len, sr);
  const o = out.getChannelData(0);
  let pos = 0;
  decoded.forEach((b, i) => { o.set(b.getChannelData(0), pos); pos += b.length + (i < decoded.length - 1 ? gap : 0); });
  return out;
}

function toWav(buffer) {
  const d = buffer.getChannelData(0), sr = buffer.sampleRate, n = d.length;
  const ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, d[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([ab], { type: 'audio/wav' });
}

// ---------- background noise (all synthesised, no credits) ----------
function noiseBuffer(type, seconds = 4) {
  const sr = ctx().sampleRate, b = ctx().createBuffer(1, sr * seconds, sr), d = b.getChannelData(0);
  let last = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else { b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11; }
  }
  return b;
}
function reversed(buf) {
  const r = ctx().createBuffer(1, buf.length, buf.sampleRate);
  const s = buf.getChannelData(0), t = r.getChannelData(0);
  for (let i = 0; i < s.length; i++) t[i] = s[s.length - 1 - i];
  return r;
}

let noise = null; // { nodes, master, timers }
function startNoise(kind, level, clipBuffer) {
  stopNoise();
  const c = ctx();
  c.resume?.();
  const master = c.createGain(); master.gain.value = level; master.connect(c.destination);
  const nodes = [], timers = [];
  const loop = (buf, gain, filter) => {
    const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = c.createGain(); g.gain.value = gain;
    let node = src;
    if (filter) { const f = c.createBiquadFilter(); Object.assign(f, { type: filter.type }); f.frequency.value = filter.f; f.Q.value = filter.q || 0.7; node.connect(f); node = f; }
    node.connect(g); g.connect(master); src.start(0, Math.random() * buf.duration); nodes.push(src);
  };
  // Babble: the clip itself, reversed, so it sounds like speech but can't be understood.
  const babble = clipBuffer ? reversed(clipBuffer) : null;
  if (kind === 'cafe') {
    loop(noiseBuffer('pink'), 0.35, { type: 'lowpass', f: 2500 });
    if (babble) { loop(babble, 0.45, { type: 'lowpass', f: 1800 }); loop(babble, 0.3, { type: 'bandpass', f: 900, q: 0.5 }); }
    const clink = () => {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 2800 + Math.random() * 2500; g.gain.setValueAtTime(0.12, c.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.35);
      o.connect(g); g.connect(master); o.start(); o.stop(c.currentTime + 0.4);
      timers.push(setTimeout(clink, 1200 + Math.random() * 4000));
    };
    timers.push(setTimeout(clink, 800));
  } else if (kind === 'street') {
    loop(noiseBuffer('brown'), 0.9, { type: 'lowpass', f: 500 });
    const car = () => {
      const src = c.createBufferSource(); src.buffer = noiseBuffer('pink', 4);
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
      const g = c.createGain(); const t = c.currentTime;
      f.frequency.setValueAtTime(300, t); f.frequency.linearRampToValueAtTime(900, t + 1.5); f.frequency.linearRampToValueAtTime(250, t + 3.5);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1.4, t + 1.6); g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
      src.connect(f); f.connect(g); g.connect(master); src.start(); src.stop(t + 3.8);
      timers.push(setTimeout(car, 2500 + Math.random() * 6000));
    };
    timers.push(setTimeout(car, 1000));
  } else if (kind === 'tv') {
    if (babble) loop(babble, 0.7, { type: 'bandpass', f: 1500, q: 0.9 });
    loop(noiseBuffer('pink'), 0.12, { type: 'highpass', f: 3000 });
  }
  noise = { nodes, master, timers };
}
function stopNoise() {
  if (!noise) return;
  noise.timers.forEach(clearTimeout);
  noise.nodes.forEach((n) => { try { n.stop(); } catch (e) { /* already stopped */ } });
  noise.master.disconnect();
  noise = null;
}

// ---------- state ----------
const prefs = { speed: 1, distracted: false, noiseKind: 'cafe', level: 0.5 };
let player = null; // { clipId, audio, url, buffer }
let answers = {};  // per-clip in-progress answers { picks: {}, checked, dictation, dictChecked }

/** What the app knows about a clip for personal picks. */
const itemOf = (c) => ({ key: `clip:${c.id}`, topics: c.topics || [], d: levelNum(c.level), skill: 'listen' });
const logClip = (c, e) => store.logEvent({ item: `clip:${c.id}`, topics: c.topics || [], ...e });

function cleanupPlayer() {
  stopNoise();
  if (player) {
    // Started but left before the end, without answering: a weak sign it didn't grab you.
    const c = data?.clips.find((x) => x.id === player.clipId);
    if (c && player.started && !player.ended && !answers[c.id]?.checked) logClip(c, { type: 'abandon', w: -0.3 }); player.audio.pause(); URL.revokeObjectURL(player.url); player = null; }
}

// ---------- views ----------
export function viewListen(id) {
  if (!ready()) return `<section class="page-head"><h1>🎧 Listening</h1></section><div class="card"><p class="muted">${loadErr || 'Loading…'}</p>${loadErr ? '<button class="btn btn-ghost" data-action="clips-retry">Try again</button>' : ''}</div>`;
  if (id) return clipView(id);
  cleanupPlayer();
  const results = store.get().listening || {};
  const hasKey = !!store.getApiKey() || server.enabled();
  return `
  <section class="page-head">
    <p class="eyebrow">${H.L().name}</p>
    <h1>🎧 Listening</h1>
    <p class="muted">Real-life situations in different voices and accents. Listen, answer, write down one sentence, and only then read the transcript.</p>
  </section>
  ${hasKey ? '' : `<div class="card notice"><p>New clips are voiced by ElevenLabs the first time you play them, so they need your API key. Clips you've played before also work offline.</p><a class="btn btn-primary" href="#/settings">Add key in Settings</a></div>`}
  <div class="article-list">${data.clips.map((c) => {
    const r = results[c.id];
    const sp = speakersOf(c);
    return `<a class="card article-row" href="#/listen/${c.id}">
      ${c.generated && !r ? '<span class="pill pill-new">New for you</span>' : ''}
      <span class="muted small">${esc(c.genre)} · ${esc(c.level)} · ${sp.map((v) => `${esc(v.name)} (${esc(v.accent)})`).join(', ')}</span>
      <strong lang="it">${esc(c.title)}</strong>
      ${r ? `<span class="small done">Best: ${r.best}/${c.questions.length}${r.dict != null ? ` · dictation ${r.dict}%` : ''}</span>` : `<span class="muted small" data-cost="${c.id}"></span>`}
    </a>`;
  }).join('')}</div>
  <h2 class="section-title">Your own listening</h2>
  ${H.blockCard('listen', { compact: true })}
  <p class="muted small">Watching a series or a podcast? Run the timer. Clips here count automatically while you work on them.</p>`;
}

function clipView(id) {
  const c = data.clips.find((x) => x.id === id);
  if (!c) return `<div class="card"><p>Clip not found.</p><a href="#/listen">Back</a></div>`;
  answers[id] ||= { picks: {}, checked: false, dictation: '', dictChecked: false };
  const a = answers[id];
  const sp = speakersOf(c);
  const score = c.questions.filter((q, i) => a.picks[i] === q.answer).length;
  const unlocked = a.checked;
  return `
  <a class="back" href="#/listen">‹ Listening</a>
  <section class="page-head">
    <p class="muted small">${esc(c.genre)} · ${esc(c.level)}</p>
    <h1 lang="it">${esc(c.title)}</h1>
    <p class="muted small">${sp.map((v) => `🎙 ${esc(v.name)}, ${esc(v.accent)}`).join(' · ')}</p>
  </section>

  <div class="card player" id="player">
    <div class="row player-main">
      <button class="btn btn-primary play-btn" data-action="clip-play" aria-label="Play">▶ Play</button>
      <button class="btn btn-ghost" data-action="clip-back" aria-label="Back 5 seconds">↺ 5s</button>
      <span class="muted small" id="clip-time">–:–</span>
    </div>
    <input type="range" id="clip-seek" min="0" max="1000" value="0" aria-label="Position" disabled>
    <p class="muted small" id="clip-status">${'' /* filled by bind */}</p>
    <div class="row chips" role="group" aria-label="Speed">${[0.75, 1, 1.25].map((s) => `
      <button class="chip ${prefs.speed === s ? 'on' : ''}" data-action="clip-speed" data-speed="${s}">${s}×</button>`).join('')}
    </div>
    <label class="toggle"><input type="checkbox" id="distracted" ${prefs.distracted ? 'checked' : ''}> <span><strong>Distracted mode</strong> <span class="muted small">background noise, like real life</span></span></label>
    <div id="noise-opts" ${prefs.distracted ? '' : 'hidden'}>
      <div class="row chips" role="group" aria-label="Noise">${[['cafe', '☕ Café'], ['street', '🚗 Street'], ['tv', '📺 TV on']].map(([k, l]) => `
        <button class="chip ${prefs.noiseKind === k ? 'on' : ''}" data-action="clip-noise" data-kind="${k}">${l}</button>`).join('')}
      </div>
      <label class="stack small"><span>Noise level</span><input type="range" id="noise-level" min="0.1" max="1.2" step="0.05" value="${prefs.level}"></label>
    </div>
  </div>

  <div class="card">
    <h3>Questions</h3>
    ${c.questions.map((q, i) => `
      <fieldset class="q">
        <legend lang="it">${i + 1}. ${esc(q.q)}</legend>
        ${q.options.map((o, j) => {
          const cls = a.checked ? (j === q.answer ? 'right' : a.picks[i] === j ? 'wrong' : '') : '';
          return `<label class="opt ${cls}"><input type="radio" name="q${i}" value="${j}" ${a.picks[i] === j ? 'checked' : ''} ${a.checked ? 'disabled' : ''}><span lang="it">${esc(o)}</span></label>`;
        }).join('')}
      </fieldset>`).join('')}
    ${a.checked ? `<p><strong>${score} of ${c.questions.length}</strong> right. ${score === c.questions.length ? 'Perfetto!' : 'Listen again to the parts you missed.'}</p>
      <button class="btn btn-ghost" data-action="clip-retry">Try again</button>`
      : `<button class="btn btn-primary" data-action="clip-check" ${Object.keys(a.picks).length === c.questions.length ? '' : 'disabled'}>Check answers</button>`}
  </div>

  <div class="card">
    <h3>Dictation</h3>
    <p class="muted small">Write down the sentence that starts with <em lang="it">"${esc(c.dictation.split(' ').slice(0, 3).join(' '))}…"</em></p>
    <textarea id="dict" rows="3" lang="it" spellcheck="false" autocapitalize="off" ${a.dictChecked ? 'disabled' : ''}>${esc(a.dictation)}</textarea>
    ${a.dictChecked ? dictResult(c, a) : '<button class="btn btn-primary" data-action="dict-check">Check</button>'}
  </div>

  <div class="card">
    <h3>Transcript</h3>
    ${unlocked ? transcript(c, a) : '<p class="muted">Unlocks once you\'ve checked your answers.</p>'}
  </div>
  ${unlocked ? ratingCard(itemOf(c)) : ''}`;
}

const norm = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9']/g, '');
function missedWords(target, typed) {
  const t = target.split(/\s+/), have = typed.split(/\s+/).map(norm).filter(Boolean);
  const pool = [...have];
  return t.map((w) => { const k = norm(w); const i = pool.indexOf(k); if (i >= 0) { pool.splice(i, 1); return { w, ok: true }; } return { w, ok: !k }; });
}
function dictResult(c, a) {
  const words = missedWords(c.dictation, a.dictation);
  const pct = Math.round((words.filter((x) => x.ok).length / words.length) * 100);
  return `<p class="dict" lang="it">${words.map((x) => (x.ok ? esc(x.w) : `<mark>${esc(x.w)}</mark>`)).join(' ')}</p>
    <p><strong>${pct}%</strong> of the words right. Highlighted words are the ones you missed.</p>
    <button class="btn btn-ghost" data-action="dict-retry">Try again</button>`;
}
function transcript(c, a) {
  const dictMiss = a.dictChecked ? new Set(missedWords(c.dictation, a.dictation).filter((x) => !x.ok).map((x) => norm(x.w))) : new Set();
  return c.segments.map((s) => {
    const v = data.voices[s.voice];
    let html = esc(s.text);
    if (a.dictChecked && s.text.includes(c.dictation)) {
      const marked = c.dictation.split(' ').map((w) => (dictMiss.has(norm(w)) ? `<mark>${esc(w)}</mark>` : esc(w))).join(' ');
      html = esc(s.text).replace(esc(c.dictation), `<u>${marked}</u>`);
    }
    return `<p lang="it"><strong>${esc(v.name)}:</strong> ${html}</p>`;
  }).join('');
}

// ---------- binding ----------
function saveResult(c, a) {
  const st = store.get();
  st.listening ||= {};
  const r = st.listening[c.id] || { best: 0, dict: null, tries: 0 };
  const score = c.questions.filter((q, i) => a.picks[i] === q.answer).length;
  r.best = Math.max(r.best, score); r.tries++; r.last = Date.now();
  let dict = null;
  if (a.dictChecked) { const w = missedWords(c.dictation, a.dictation); dict = Math.round((w.filter((x) => x.ok).length / w.length) * 100); r.dict = Math.max(r.dict || 0, dict); }
  // How well it went, for the listening level estimate (quiz and dictation averaged).
  const parts = [score / c.questions.length, ...(dict != null ? [dict / 100] : [])];
  logClip(c, { type: 'result', skill: 'listen', d: levelNum(c.level), perf: parts.reduce((x, y) => x + y, 0) / parts.length });
  st.listening[c.id] = r;
  store.save();
}

async function ensurePlayer(c) {
  if (player?.clipId === c.id) return player;
  cleanupPlayer();
  const status = document.getElementById('clip-status');
  const cached = await isCached(c);
  if (!cached && status) status.textContent = server.enabled() ? 'Getting the audio from your content server…' : `Voicing this clip with ElevenLabs (about ${credits(chars(c))} credits, once)…`;
  const buffer = await buildClipBuffer(c, (i, n) => { if (!cached && status && n > 1) status.textContent = `Voicing part ${i} of ${n}…`; });
  markVoiced(c.id);
  const url = URL.createObjectURL(toWav(buffer));
  const audio = new Audio(url);
  audio.preservesPitch = true; audio.playbackRate = prefs.speed;
  const p = { clipId: c.id, audio, url, buffer, started: false, ended: false, replays: 0 };
  player = p;
  audio.addEventListener('timeupdate', () => updateTime());
  audio.addEventListener('play', () => {
    if (!store.get().timer) store.startTimer('listen');
    if (prefs.distracted) startNoise(prefs.noiseKind, prefs.level, buffer);
    // Playing it again after the end: you wanted more of it (counted twice at most).
    if (p.ended && p.replays < 2) { p.replays++; logClip(c, { type: 'replay', w: 0.3 }); }
    p.started = true;
    updatePlayBtn();
  });
  audio.addEventListener('pause', () => { stopNoise(); updatePlayBtn(); });
  audio.addEventListener('ended', () => {
    stopNoise(); updatePlayBtn();
    if (!p.ended) logClip(c, { type: 'finish', w: 0.4 });
    p.ended = true;
  });
  if (status) status.textContent = '';
  return player;
}

function updatePlayBtn() {
  const b = document.querySelector('[data-action=clip-play]');
  if (b && player) b.textContent = player.audio.paused ? '▶ Play' : '❚❚ Pause';
}
function updateTime() {
  const el = document.getElementById('clip-time'), seek = document.getElementById('clip-seek');
  if (!player || !el) return;
  const { currentTime: t, duration: d } = player.audio;
  el.textContent = `${H.mmss(Math.floor(t))} / ${isFinite(d) ? H.mmss(Math.floor(d)) : '–:–'}`;
  if (seek && isFinite(d)) { seek.disabled = false; seek.value = Math.round((t / d) * 1000); }
}

const revoiceOk = new Set(); // clips the user agreed to voice again this session

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn?.dataset.action === 'clips-retry') { retryLoad(); return; }
  if (!btn || !data) return;
  const id = location.hash.split('/')[2];
  const c = data.clips.find((x) => x.id === id);
  const act = btn.dataset.action;
  if (!c || !act.startsWith('clip-') && !act.startsWith('dict-')) return;
  const a = answers[id];
  if (act === 'clip-cancel') {
    const s = document.getElementById('clip-status'); if (s) s.textContent = '';
  } else if (act === 'clip-play' || act === 'clip-revoice') {
    if (act === 'clip-revoice') revoiceOk.add(c.id);
    const playBtn = document.querySelector('[data-action=clip-play]');
    // Audio voiced before but cleared from this device (storage pressure, site data
    // cleared): ask before spending credits on it again.
    if (player?.clipId !== c.id && !revoiceOk.has(c.id) && !server.enabled() && voicedSet().has(c.id)) {
      const miss = await missingSegments(c);
      if (miss.length) {
        const n = miss.reduce((a, i) => a + c.segments[i].text.length, 0);
        const s = document.getElementById('clip-status');
        if (s) s.innerHTML = `This clip's audio was cleared from this device. Voicing it again costs about ${credits(n)} credits.
          <span class="row"><button class="btn btn-primary" data-action="clip-revoice">Voice it again</button> <button class="btn btn-ghost" data-action="clip-cancel">Cancel</button></span>`;
        return;
      }
    }
    if (playBtn) playBtn.disabled = true;
    try {
      const p = await ensurePlayer(c);
      if (p.audio.paused) { ctx().resume?.(); await p.audio.play(); } else p.audio.pause();
    } catch (err) {
      const s = document.getElementById('clip-status'); if (s) s.textContent = err.message;
    } finally { if (playBtn) playBtn.disabled = false; updatePlayBtn(); }
  } else if (act === 'clip-back' && player) {
    player.audio.currentTime = Math.max(0, player.audio.currentTime - 5);
  } else if (act === 'clip-speed') {
    prefs.speed = Number(btn.dataset.speed);
    if (player) player.audio.playbackRate = prefs.speed;
    document.querySelectorAll('[data-action=clip-speed]').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === prefs.speed));
  } else if (act === 'clip-noise') {
    prefs.noiseKind = btn.dataset.kind;
    document.querySelectorAll('[data-action=clip-noise]').forEach((b) => b.classList.toggle('on', b.dataset.kind === prefs.noiseKind));
    if (player && !player.audio.paused) startNoise(prefs.noiseKind, prefs.level, player.buffer);
  } else if (act === 'clip-check') {
    a.checked = true; saveResult(c, a); rerenderKeepingPlayer();
  } else if (act === 'clip-retry') {
    a.checked = false; a.picks = {}; rerenderKeepingPlayer();
  } else if (act === 'dict-check') {
    a.dictation = document.getElementById('dict').value; a.dictChecked = true; saveResult(c, a); rerenderKeepingPlayer();
  } else if (act === 'dict-retry') {
    a.dictChecked = false; a.dictation = ''; rerenderKeepingPlayer();
  }
});

// Re-render the page without throwing away the loaded audio.
let keepPlayer = false;
function rerenderKeepingPlayer() { keepPlayer = true; const y = window.scrollY; H.render(); window.scrollTo(0, y); keepPlayer = false; }

export function bind(r, params) {
  if (r !== 'listen') { if (player) { cleanupPlayer(); if (store.get().timer?.skill === 'listen') store.stopTimer(); } return; }
  if (!params[0]) {
    if (data) data.clips.forEach(async (c) => { const el = document.querySelector(`[data-cost="${c.id}"]`); if (el) el.textContent = (await isCached(c)) ? 'Ready offline' : server.enabled() ? 'Not downloaded yet' : `New · about ${credits(chars(c))} credits to voice`; });
    return;
  }
  if (player && player.clipId !== params[0] && !keepPlayer) cleanupPlayer();
  updatePlayBtn(); updateTime();
  const id = params[0], a = answers[id];
  document.querySelectorAll('.q input[type=radio]').forEach((inp) => inp.addEventListener('change', () => {
    a.picks[Number(inp.name.slice(1))] = Number(inp.value);
    const c = data.clips.find((x) => x.id === id);
    const b = document.querySelector('[data-action=clip-check]'); if (b) b.disabled = Object.keys(a.picks).length !== c.questions.length;
  }));
  document.getElementById('dict')?.addEventListener('input', (e) => { a.dictation = e.target.value; });
  document.getElementById('clip-seek')?.addEventListener('input', (e) => { if (player && isFinite(player.audio.duration)) player.audio.currentTime = (e.target.value / 1000) * player.audio.duration; });
  document.getElementById('distracted')?.addEventListener('change', (e) => {
    prefs.distracted = e.target.checked;
    document.getElementById('noise-opts').hidden = !prefs.distracted;
    if (player && !player.audio.paused) (prefs.distracted ? startNoise(prefs.noiseKind, prefs.level, player.buffer) : stopNoise());
  });
  document.getElementById('noise-level')?.addEventListener('input', (e) => { prefs.level = Number(e.target.value); if (noise) noise.master.gain.value = prefs.level; });
}
