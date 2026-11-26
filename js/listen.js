// Listening trainer: clips voiced by ElevenLabs on first play (with your key),
// cached on this device, played with speed control and optional background noise.
import * as store from './store.js';

let H = {};
export function init(helpers) { H = helpers; }
const esc = (s) => H.esc(s);

const TTS_MODEL = 'eleven_multilingual_v2';
const CLIP_CACHE = 'lhclips-v1'; // separate from the app-shell cache so updates keep clips
const GAP = 0.45; // seconds of silence between dialogue turns

// ---------- content ----------
let data = null, loadErr = null, loadingP = null;
function ready() {
  if (data) return true;
  loadingP ||= fetch(`${H.L().content}clips.json`).then((r) => r.json()).then((d) => { data = d; })
    .catch(() => { loadErr = 'Could not load the clips. Open the app once while online, then reload.'; })
    .finally(() => H.render());
  return false;
}
const chars = (clip) => clip.segments.reduce((a, s) => a + s.text.length, 0);
const speakersOf = (clip) => [...new Set(clip.segments.map((s) => s.voice))].map((v) => data.voices[v]);

// ---------- audio generation + cache ----------
const segUrl = (clip, i) => new URL(`clips-cache/${clip.id}-${i}-${data.voices[clip.segments[i].voice].id}.mp3`, location.href).href;

async function isCached(clip) {
  try {
    const c = await caches.open(CLIP_CACHE);
    const hits = await Promise.all(clip.segments.map((_, i) => c.match(segUrl(clip, i))));
    return hits.every(Boolean);
  } catch (e) { return false; }
}

async function fetchSegment(clip, i) {
  const url = segUrl(clip, i);
  let cache = null;
  try { cache = await caches.open(CLIP_CACHE); const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); } catch (e) { /* no cache */ }
  const key = store.getApiKey();
  if (!key) throw new Error('Add your ElevenLabs API key in Settings to voice new clips.');
  const seg = clip.segments[i];
  let res;
  try {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${data.voices[seg.voice].id}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: seg.text, model_id: TTS_MODEL, voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.25, speed: 1.0 } }),
    });
  } catch (e) { throw new Error('Could not reach ElevenLabs. Check your internet connection.'); }
  if (res.status === 401) throw new Error('ElevenLabs rejected the API key. Check it in Settings.');
  if (res.status === 403) throw new Error('Your API key needs the "Text to Speech" permission for new clips.');
  if (!res.ok) throw new Error(`ElevenLabs couldn't voice this clip (${res.status}).`);
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

function cleanupPlayer() {
  stopNoise();
  if (player) { player.audio.pause(); URL.revokeObjectURL(player.url); player = null; }
}

// ---------- views ----------
export function viewListen(id) {
  if (!ready()) return `<section class="page-head"><h1>🎧 Listening</h1></section><div class="card"><p class="muted">${loadErr || 'Loading…'}</p></div>`;
  if (id) return clipView(id);
  cleanupPlayer();
  const results = store.get().listening || {};
  const hasKey = !!store.getApiKey();
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
  </div>`;
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
  if (a.dictChecked) { const w = missedWords(c.dictation, a.dictation); r.dict = Math.max(r.dict || 0, Math.round((w.filter((x) => x.ok).length / w.length) * 100)); }
  st.listening[c.id] = r;
  store.save();
}

async function ensurePlayer(c) {
  if (player?.clipId === c.id) return player;
  cleanupPlayer();
  const status = document.getElementById('clip-status');
  const cached = await isCached(c);
  if (!cached && status) status.textContent = `Voicing this clip with ElevenLabs (about ${chars(c).toLocaleString('en-GB')} credits, once)…`;
  const buffer = await buildClipBuffer(c, (i, n) => { if (!cached && status && n > 1) status.textContent = `Voicing part ${i} of ${n}…`; });
  const url = URL.createObjectURL(toWav(buffer));
  const audio = new Audio(url);
  audio.preservesPitch = true; audio.playbackRate = prefs.speed;
  player = { clipId: c.id, audio, url, buffer };
  audio.addEventListener('timeupdate', () => updateTime());
  audio.addEventListener('play', () => { if (!store.get().timer) store.startTimer('listen'); if (prefs.distracted) startNoise(prefs.noiseKind, prefs.level, buffer); updatePlayBtn(); });
  audio.addEventListener('pause', () => { stopNoise(); updatePlayBtn(); });
  audio.addEventListener('ended', () => { stopNoise(); updatePlayBtn(); });
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

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !data) return;
  const id = location.hash.split('/')[2];
  const c = data.clips.find((x) => x.id === id);
  const act = btn.dataset.action;
  if (!c || !act.startsWith('clip-') && !act.startsWith('dict-')) return;
  const a = answers[id];
  if (act === 'clip-play') {
    btn.disabled = true;
    try {
      const p = await ensurePlayer(c);
      if (p.audio.paused) { ctx().resume?.(); await p.audio.play(); } else p.audio.pause();
    } catch (err) {
      const s = document.getElementById('clip-status'); if (s) s.textContent = err.message;
    } finally { btn.disabled = false; updatePlayBtn(); }
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
    if (data) data.clips.forEach(async (c) => { const el = document.querySelector(`[data-cost="${c.id}"]`); if (el) el.textContent = (await isCached(c)) ? 'Ready offline' : `New · about ${chars(c).toLocaleString('en-GB')} credits to voice`; });
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
