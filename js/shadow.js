// Shadowing: repeat a clip sentence by sentence, right after the speaker (or along
// with them, on headphones), and compare your rhythm, melody and pace with theirs.
// The analysis is in js/shadowkit.js and runs on the device: it costs nothing.
// "Check words" sends your attempt to ElevenLabs speech to text (your key).
import * as store from './store.js';
import * as listen from './listen.js';
import * as kit from './shadowkit.js';

let H = {};
export function init(helpers) { H = helpers; }
const esc = (s) => H.esc(s);

// ElevenLabs speech to text model for "Check words" / "What did it sound like?".
const STT_MODEL = 'scribe_v1';

// ---------- microphone ----------
let mic = null; // MediaStream, kept open while a shadowing screen is open
let rec = null; // { mr, chunks, timer, resolve }

export async function openMic() {
  if (mic && mic.getAudioTracks().some((t) => t.readyState === 'live')) return mic;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('This browser can\'t record audio.');
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    throw new Error(e?.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it for this site in your browser settings.' : 'Could not open the microphone.');
  }
  return mic;
}
export function closeMic() {
  stopRecording();
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
}

/** Record up to `maxSec` seconds (or until stopRecording). Resolves to { blob, samples, sr, seconds }. */
export async function record(maxSec, onTick) {
  const stream = await openMic();
  stopRecording();
  return new Promise((resolve, reject) => {
    const mr = new MediaRecorder(stream);
    const chunks = [], t0 = Date.now();
    mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    mr.onerror = () => reject(new Error('Recording failed.'));
    mr.onstop = async () => {
      clearInterval(r.tick); clearTimeout(r.timer);
      if (rec === r) rec = null;
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      try {
        const buf = await listen.audioContext().decodeAudioData(await blob.arrayBuffer());
        resolve({ blob, samples: buf.getChannelData(0), sr: buf.sampleRate, seconds: (Date.now() - t0) / 1000 });
      } catch (e) { reject(new Error('Could not read the recording.')); }
    };
    const r = { mr, timer: setTimeout(() => stopRecording(), maxSec * 1000), tick: onTick ? setInterval(() => onTick((Date.now() - t0) / 1000), 100) : 0 };
    rec = r;
    mr.start();
  });
}
export function stopRecording() { if (rec?.mr.state === 'recording') rec.mr.stop(); }
export const recording = () => !!rec;

/** What ElevenLabs speech to text hears in a recording (plain text). */
export async function transcribe(blob) {
  const key = store.getApiKey();
  if (!key) throw new Error('Add your ElevenLabs API key in Settings to check words.');
  const fd = new FormData();
  fd.append('model_id', STT_MODEL);
  fd.append('language_code', store.get().settings.language);
  fd.append('tag_audio_events', 'false');
  fd.append('file', blob, 'attempt.webm');
  let res;
  try { res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: fd }); }
  catch (e) { throw new Error('Could not reach ElevenLabs. Check your internet connection.'); }
  if (res.status === 401 || res.status === 403) throw new Error('Your API key needs the "Speech to Text" permission to check words.');
  if (!res.ok) throw new Error(`ElevenLabs couldn't transcribe it (${res.status}).`);
  const j = await res.json();
  return String(j.text || '').trim();
}

// ---------- shared bits of the attempt panel ----------
export function contourSvg(c) {
  if (!c) return '';
  const all = [...c.model, ...c.you];
  const lo = Math.min(...all, -3), hi = Math.max(...all, 3);
  const pts = (v) => v.map((y, i) => `${((i / (v.length - 1)) * 300).toFixed(1)},${(70 - ((y - lo) / (hi - lo)) * 60).toFixed(1)}`).join(' ');
  return `<svg class="contour" viewBox="0 0 300 80" role="img" aria-label="Melody of the speaker and of your attempt">
    <polyline class="c-model" points="${pts(c.model)}"/><polyline class="c-you" points="${pts(c.you)}"/></svg>
    <p class="legend small"><span class="key-model"></span> Speaker <span class="key-you"></span> You</p>`;
}
function paceText(p) {
  if (p > 1.35) return `much slower (${p.toFixed(1)}×)`;
  if (p > 1.12) return `a bit slower (${p.toFixed(1)}×)`;
  if (p < 0.75) return `much faster (${p.toFixed(1)}×)`;
  if (p < 0.9) return `a bit faster (${p.toFixed(1)}×)`;
  return 'about the same';
}
const score = (v) => (v == null ? '–' : `${v}%`);
export const overall = (r) => {
  const parts = [r.rhythm, r.intonation].filter((x) => x != null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
};

// ---------- clip shadowing view ----------
const prefs = { mode: 'after', speed: 1, showText: false };
let S = null; // { clipId, buffer, sentences: [{ text, start, end }], i, att: { [i]: attempt }, busy, err }
let audio = null; // the HTMLAudioElement playing a model sentence or an attempt
let timerByUs = false;

function stopAudio() { if (audio) { audio.pause(); audio = null; } }
function leave() {
  stopAudio(); closeMic();
  if (S) S.att = {};
  Object.values(urls).forEach(URL.revokeObjectURL); urls = {};
  if (timerByUs && store.get().timer?.skill === 'speak') store.stopTimer();
  timerByUs = false;
}
let urls = {}; // object URLs to revoke on leave

function sentencesFor(c, buffer) {
  const env = kit.envelope(buffer.getChannelData(0), buffer.sampleRate);
  const out = [];
  c.segments.forEach((seg, si) => {
    const [s, e] = buffer.spans?.[si] || [0, buffer.duration];
    const parts = kit.splitSentences(seg.text);
    const frames = kit.sentenceFrames(env, Math.floor(s / kit.FRAME), Math.min(env.length - 1, Math.floor(e / kit.FRAME)), parts);
    parts.forEach((text, k) => out.push({ text, start: frames[k][0] * kit.FRAME, end: frames[k][1] * kit.FRAME, speaker: listen.voiceOf(c, seg).name }));
  });
  return out;
}

/** The model sentence as its own buffer (a little padding either side). */
function sentenceBuffer(i) {
  const b = S.buffer, sr = b.sampleRate, x = S.sentences[i];
  const a = Math.max(0, Math.floor((x.start - 0.05) * sr)), z = Math.min(b.length, Math.ceil((x.end + 0.12) * sr));
  const out = listen.audioContext().createBuffer(1, Math.max(1, z - a), sr);
  out.getChannelData(0).set(b.getChannelData(0).subarray(a, z));
  return out;
}
function modelUrl(i) { return (urls[`m${i}`] ||= URL.createObjectURL(listen.toWav(sentenceBuffer(i)))); }
const modelSeconds = (i) => (S.sentences[i].end - S.sentences[i].start + 0.17) / prefs.speed;

function play(url, rate = 1) {
  stopAudio();
  const a = new Audio(url);
  a.preservesPitch = true; a.playbackRate = rate;
  audio = a;
  return new Promise((resolve) => { a.onended = resolve; a.onpause = resolve; a.play().catch(resolve); });
}

export function viewShadow(id) {
  const data = listen.clips();
  const back = `<a class="back" href="#/listen/${esc(id || '')}">‹ Back to the clip</a>`;
  if (!data) return `${back}<div class="card"><p class="muted">Loading…</p></div>`;
  const c = data.clips.find((x) => x.id === id);
  if (!c) return `<a class="back" href="#/listen">‹ Listening</a><div class="card"><p>Clip not found.</p></div>`;
  if (S?.clipId !== id) { if (S) leave(); S = { clipId: id, buffer: null, sentences: null, i: 0, att: {}, busy: false, err: '' }; }
  const head = `${back}
  <section class="page-head">
    <p class="muted small">Shadowing · ${esc(c.genre)} · ${esc(c.level)}</p>
    <h1 lang="it">${esc(c.title)}</h1>
  </section>`;
  if (!S.sentences) {
    return `${head}<div class="card"><p class="muted" id="sh-status">${S.err ? esc(S.err) : 'Getting the audio ready…'}</p>
      ${S.err ? '<button class="btn btn-ghost" data-action="sh-load">Try again</button>' : ''}</div>`;
  }
  const n = S.sentences.length, x = S.sentences[S.i], at = S.att[S.i];
  const best = store.get().shadowing?.[c.id]?.best || {};
  return `${head}
  <div class="card how">
    <p class="small"><strong>How:</strong> listen once, then say it straight after the speaker, copying the rhythm and melody more than the exact sounds. Start with the text hidden; show it when you get stuck.</p>
    <div class="row chips" role="group" aria-label="Mode">
      <button class="chip ${prefs.mode === 'after' ? 'on' : ''}" data-action="sh-mode" data-mode="after">Repeat after</button>
      <button class="chip ${prefs.mode === 'along' ? 'on' : ''}" data-action="sh-mode" data-mode="along">Along with 🎧</button>
    </div>
    ${prefs.mode === 'along' ? '<p class="muted small">Along with: wear headphones, and speak at the same time as the speaker, half a word behind.</p>' : ''}
    <div class="row chips" role="group" aria-label="Speed">${[0.75, 0.9, 1].map((s) => `
      <button class="chip ${prefs.speed === s ? 'on' : ''}" data-action="sh-speed" data-speed="${s}">${s}×</button>`).join('')}
    </div>
  </div>

  <div class="card shadow-card">
    <div class="row sh-nav">
      <button class="btn btn-ghost" data-action="sh-prev" ${S.i ? '' : 'disabled'} aria-label="Previous sentence">‹</button>
      <span class="muted small">Sentence ${S.i + 1} of ${n} · ${esc(x.speaker)}${best[S.i] != null ? ` · best ${best[S.i]}%` : ''}</span>
      <button class="btn btn-ghost" data-action="sh-next" ${S.i < n - 1 ? '' : 'disabled'} aria-label="Next sentence">›</button>
    </div>
    <p class="sh-text ${prefs.showText ? '' : 'hidden-text'}" lang="it">${prefs.showText ? esc(x.text) : esc(x.text.replace(/[^\s.,!?…'’]/gu, '·'))}</p>
    <div class="row">
      <button class="btn btn-ghost" data-action="sh-listen">▶ Listen</button>
      <button class="btn btn-primary" data-action="sh-go" ${S.busy ? 'disabled' : ''}>${prefs.mode === 'after' ? '🎙 Listen, then repeat' : '🎙 Shadow along'}</button>
      <button class="btn btn-ghost" data-action="sh-text">${prefs.showText ? 'Hide text' : 'Show text'}</button>
    </div>
    <p class="small" id="sh-status" aria-live="polite">${S.err ? esc(S.err) : ''}</p>
    ${at ? attemptHtml(at, x) : ''}
  </div>
  ${n > 1 ? `<p class="muted small">Tip: go through the whole clip once, then come back to the sentences with the lowest scores.</p>` : ''}`;
}

function attemptHtml(at, x) {
  const r = at.result;
  if (r.silent) return `<div class="attempt"><p>I couldn't hear you. Check the microphone and try again, a little closer.</p></div>`;
  return `<div class="attempt">
    <div class="scores">
      <div><span class="muted small">Rhythm</span><strong>${score(r.rhythm)}</strong></div>
      <div><span class="muted small">Melody</span><strong>${score(r.intonation)}</strong></div>
      <div><span class="muted small">Pace</span><strong class="small">${paceText(r.pace)}</strong></div>
    </div>
    ${contourSvg(r.contour)}
    <ul class="tips">${r.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <div class="row">
      <button class="btn btn-ghost" data-action="sh-yours">▶ You</button>
      <button class="btn btn-ghost" data-action="sh-both">▶ Speaker, then you</button>
      ${at.words ? '' : '<button class="btn btn-ghost" data-action="sh-words">Check words</button>'}
    </div>
    ${at.words ? `<p class="dict" lang="it">${at.words.map((w) => (w.ok ? esc(w.w) : `<mark>${esc(w.w)}</mark>`)).join(' ')}</p>
      <p class="muted small">Heard: <span lang="it">“${esc(at.heard || '…')}”</span>. Highlighted words weren't recognised, so they may need clearer sounds.</p>` : ''}
  </div>`;
}

function status(msg) { const el = document.getElementById('sh-status'); if (el) el.textContent = msg; }
const rerender = () => { const y = window.scrollY; H.render(); window.scrollTo(0, y); };

async function load(c) {
  S.err = '';
  try {
    const buffer = await listen.clipAudio(c, (i, n) => status(n > 1 ? `Getting part ${i} of ${n}…` : 'Getting the audio…'));
    S.buffer = buffer;
    S.sentences = sentencesFor(c, buffer);
  } catch (e) { S.err = e.message || 'Could not get the audio.'; }
  if (location.hash.startsWith(`#/shadow/${c.id}`)) rerender();
}

async function attempt(c) {
  const i = S.i;
  S.busy = true; S.err = '';
  const goBtn = document.querySelector('[data-action=sh-go]'); if (goBtn) goBtn.disabled = true;
  try {
    await openMic();
    if (!store.get().timer) { store.startTimer('speak'); timerByUs = true; }
    const len = modelSeconds(i);
    let take;
    if (prefs.mode === 'after') {
      status('Listen…');
      await play(modelUrl(i), prefs.speed);
      status('🔴 Your turn. Tap Done when you finish.');
      showDone(true);
      take = await record(len * 1.6 + 1.2, null);
    } else {
      status('🔴 Recording. Speak along with the speaker.');
      const recP = record(len + 1.5, null);
      await new Promise((r) => setTimeout(r, 150));
      await play(modelUrl(i), prefs.speed);
      setTimeout(stopRecording, 700);
      take = await recP;
    }
    showDone(false);
    const model = kit.analyse(sentenceBuffer(i).getChannelData(0), S.buffer.sampleRate);
    model.seconds /= prefs.speed; // compare against the speed you practised at
    const you = kit.analyse(take.samples, take.sr);
    const result = kit.compare(model, you);
    if (urls[`y${i}`]) URL.revokeObjectURL(urls[`y${i}`]);
    urls[`y${i}`] = URL.createObjectURL(take.blob);
    S.att[i] = { result, blob: take.blob };
    if (!result.silent) {
      store.logShadow(c.id, i, overall(result));
      if (!S.logged) { S.logged = true; store.logEvent({ item: `clip:${c.id}`, topics: c.topics || [], type: 'shadow', w: 0.3 }); }
    }
  } catch (e) { S.err = e.message || 'Something went wrong.'; showDone(false); }
  S.busy = false;
  if (location.hash.startsWith(`#/shadow/${c.id}`)) rerender();
}
function showDone(on) {
  const go = document.querySelector('[data-action=sh-go]');
  if (!go) return;
  go.disabled = !on;
  if (on) { go.textContent = '■ Done'; go.dataset.action = 'sh-done'; }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action^="sh-"]');
  if (!btn || !S) return;
  const data = listen.clips(); const c = data?.clips.find((x) => x.id === S.clipId);
  if (!c) return;
  const act = btn.dataset.action;
  if (act === 'sh-load') { S.err = ''; rerender(); load(c); }
  else if (act === 'sh-mode') { prefs.mode = btn.dataset.mode; rerender(); }
  else if (act === 'sh-speed') { prefs.speed = Number(btn.dataset.speed); rerender(); }
  else if (act === 'sh-text') { prefs.showText = !prefs.showText; rerender(); }
  else if (act === 'sh-prev' || act === 'sh-next') { if (S.busy) return; stopAudio(); S.i = Math.max(0, Math.min(S.sentences.length - 1, S.i + (act === 'sh-next' ? 1 : -1))); S.err = ''; rerender(); }
  else if (act === 'sh-listen') { if (!S.busy) play(modelUrl(S.i), prefs.speed); }
  else if (act === 'sh-go') { if (!S.busy) attempt(c); }
  else if (act === 'sh-done') { stopRecording(); }
  else if (act === 'sh-yours') { if (urls[`y${S.i}`]) play(urls[`y${S.i}`]); }
  else if (act === 'sh-both') { if (urls[`y${S.i}`]) { await play(modelUrl(S.i), prefs.speed); await new Promise((r) => setTimeout(r, 300)); play(urls[`y${S.i}`]); } }
  else if (act === 'sh-words') {
    const at = S.att[S.i]; if (!at) return;
    btn.disabled = true; status('Checking…');
    try { at.heard = await transcribe(at.blob); at.words = kit.wordDiff(S.sentences[S.i].text, at.heard); status(''); rerender(); }
    catch (err) { status(err.message); btn.disabled = false; }
  }
});

export function bind(r, params) {
  if (r !== 'shadow') { if (S || mic) { leave(); S = null; } return; }
  const data = listen.clips();
  const c = data?.clips.find((x) => x.id === params[0]);
  if (c && S && !S.sentences && !S.err && !S.loading) { S.loading = true; load(c).finally(() => { if (S) S.loading = false; }); }
}
