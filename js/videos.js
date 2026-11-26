// Real Italian: YouTube videos (including RAI's channels) in an embedded player.
// Nothing is downloaded or rehosted. You mark the phrases you want to work on
// while you watch, then loop them, slow them down and shadow them.
import * as store from './store.js';
import * as listen from './listen.js';
import * as shadow from './shadow.js';
import * as kit from './shadowkit.js';
import * as yt from './yt.js';

let H = {};
export function init(helpers) { H = helpers; }
const esc = (s) => H.esc(s);

// ---------- content ----------
let data = null, loadErr = null, loadingP = null;
function ready() {
  if (data) return true;
  if (loadErr) return false;
  loadingP ||= fetch(`${H.L().content}videos.json`)
    .then((r) => { if (r.status === 404) return { videos: [], channels: [] }; if (!r.ok) throw new Error(); return r.json(); })
    .then((d) => { data = { videos: Array.isArray(d.videos) ? d.videos : [], channels: Array.isArray(d.channels) ? d.channels : [] }; })
    .catch(() => { loadErr = 'Could not load the video list.'; loadingP = null; })
    .finally(() => { if (location.hash.startsWith('#/listen')) H.render(); else if (V) fillTitle(); });
  return false;
}
function fillTitle() {
  const v = findVideo(V.id), h = document.getElementById('vid-title'), m = document.getElementById('vid-meta');
  if (h) { h.textContent = v.title; if (!v.mine) h.lang = 'it'; }
  if (m) m.textContent = [v.kind, v.channel, v.level].filter(Boolean).join(' · ');
}
window.addEventListener('online', () => { if (loadErr) { loadErr = null; } });

function allVideos() {
  const mine = (store.get().videos || []).map((v) => ({ ...v, title: v.title || 'Your video', channel: 'Added by you', mine: true }));
  const ids = new Set(mine.map((v) => v.id));
  return [...mine, ...(data?.videos || []).filter((v) => !ids.has(v.id))];
}
const findVideo = (id) => allVideos().find((v) => v.id === id) || { id, title: 'YouTube video', channel: '', mine: false };

// ---------- list (on the Listening page) ----------
export function videosSection() {
  ready();
  const vids = data ? allVideos() : [];
  const marked = store.get().phrases || {};
  return `
  <h2 class="section-title">Real Italian</h2>
  <p class="muted small">Real speech from YouTube and RAI, at native speed. Mark the phrases you want to work on as you watch, then loop them and shadow them.</p>
  <div class="article-list">${vids.map((v) => `
    <a class="card article-row video-row" href="#/video/${esc(v.id)}">
      <img class="thumb" src="${yt.thumbUrl(v.id)}" alt="" loading="lazy" width="120" height="68">
      <span class="video-meta">
        <span class="muted small">${esc([v.kind, v.channel, v.level].filter(Boolean).join(' · '))}</span>
        <strong ${v.mine ? '' : 'lang="it"'}>${esc(v.title)}</strong>
        ${marked[v.id]?.length ? `<span class="small done">${marked[v.id].length} phrase${marked[v.id].length === 1 ? '' : 's'} marked</span>` : ''}
      </span>
    </a>`).join('')}
    ${!data ? `<div class="card"><p class="muted">${loadErr || 'Loading…'}</p></div>` : ''}
  </div>
  <form class="card add-video" id="add-video">
    <label class="stack"><span><strong>Add a video</strong> <span class="muted small">paste a YouTube link (RaiPlay itself can't be embedded; RAI's YouTube channels can)</span></span>
      <input type="url" id="video-url" inputmode="url" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off" required></label>
    <label class="stack"><span class="small">Name <span class="muted">(optional)</span></span><input type="text" id="video-name" maxlength="80" autocomplete="off"></label>
    <button class="btn btn-primary" type="submit">Add</button>
  </form>
  ${data?.channels?.length ? `<p class="muted small">Good channels to find more: ${data.channels.map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>`).join(', ')}.</p>` : ''}`;
}

// ---------- the video screen ----------
const prefs = { speed: 1, captions: false, mode: 'after', distracted: false, noiseKind: 'cafe' };
let V = null; // { id, player, sel, att: { [i]: { url, blob, heard, mine, theirs } }, busy, err, loop, timerByUs }

const phrasesOf = (id) => (store.get().phrases?.[id] || []).slice();
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}${t % 1 >= 0.05 ? `.${Math.floor((t % 1) * 10)}` : ''}`;

export function viewVideo(id) {
  if (!id || !yt.parseVideoId(id)) return '<a class="back" href="#/listen">‹ Listening</a><div class="card"><p>Video not found.</p></div>';
  ready();
  const v = findVideo(id);
  if (V?.id !== id) { teardown(); V = { id, player: null, sel: -1, att: {}, busy: false, err: '', loop: false }; }
  const ph = phrasesOf(id);
  return `
  <a class="back" href="#/listen">‹ Listening</a>
  <section class="page-head">
    <p class="muted small" id="vid-meta">${esc([v.kind, v.channel, v.level].filter(Boolean).join(' · '))}</p>
    <h1 id="vid-title" ${v.mine ? '' : 'lang="it"'}>${esc(v.title)}</h1>
  </section>
  <div class="card video-card">
    <div class="video-frame" id="video-frame"></div>
    <p class="small video-error" id="video-error" ${V.player?.error ? '' : 'hidden'}>${esc(V.player?.error || '')} <a href="${yt.watchUrl(id)}" target="_blank" rel="noopener">Open on YouTube</a></p>
    <div class="row">
      <button class="btn btn-ghost" data-action="vid-back" aria-label="Back 5 seconds">↺ 5s</button>
      <button class="btn btn-primary" data-action="vid-mark" title="Saves the bit since your last mark as a phrase">✂ Mark phrase</button>
      <span class="muted small" id="vid-time"></span>
    </div>
    <div class="row chips" role="group" aria-label="Speed">${[0.75, 1, 1.25].map((s) => `
      <button class="chip ${prefs.speed === s ? 'on' : ''}" data-action="vid-speed" data-speed="${s}">${s}×</button>`).join('')}
      <button class="chip ${prefs.captions ? 'on' : ''}" data-action="vid-cc" aria-pressed="${prefs.captions}">Italian captions</button>
    </div>
    <label class="toggle"><input type="checkbox" id="vid-distracted" ${prefs.distracted ? 'checked' : ''}> <span><strong>Distracted mode</strong> <span class="muted small">background noise on top</span></span></label>
    <div id="vid-noise" ${prefs.distracted ? '' : 'hidden'}><div class="row chips">${[['cafe', '☕ Café'], ['street', '🚗 Street']].map(([k, l]) => `
      <button class="chip ${prefs.noiseKind === k ? 'on' : ''}" data-action="vid-noise" data-kind="${k}">${l}</button>`).join('')}
    </div></div>
    <p class="muted small">Tip: watch a minute without captions first, then once with them, then mark the phrases you'd like to be able to say.</p>
  </div>

  <div class="card" id="vid-phrases">${phrasesCard(ph)}</div>
  <div id="vid-panel">${panelHtml(ph)}</div>
  ${v.mine ? `<button class="btn btn-ghost" data-action="vid-remove">Remove this video</button>` : ''}`;
}

function phrasesCard(ph) {
  return `<h3>Phrases to practise</h3>
    ${ph.length ? '' : '<p class="muted small">While it plays, tap <strong>✂ Mark phrase</strong> at the end of a phrase you want to practise. It saves the bit since your previous mark (up to 8 seconds back), and you can nudge both ends.</p>'}
    <ol class="phrases">${ph.map((p, i) => phraseRow(p, i)).join('')}</ol>
    ${ph.length ? `<label class="toggle"><input type="checkbox" id="vid-loop" ${V.loop ? 'checked' : ''}> <span>Loop the phrase when I play it</span></label>` : ''}`;
}
const panelHtml = (ph) => (V.sel >= 0 && ph[V.sel] ? shadowPanel(ph[V.sel], V.sel) : '');

function phraseRow(p, i) {
  const r = ['Not yet', 'Close', 'Got it'][p.rating];
  return `<li class="phrase ${V.sel === i ? 'sel' : ''}">
    <div class="row">
      <button class="btn btn-ghost" data-action="vid-pplay" data-i="${i}" aria-label="Play phrase ${i + 1}">▶</button>
      <span class="small">${fmt(p.start)}–${fmt(p.end)}${r ? ` · <span class="muted">${r}</span>` : ''}</span>
      <button class="btn ${V.sel === i ? 'btn-primary' : 'btn-ghost'}" data-action="vid-sel" data-i="${i}">🗣 Shadow</button>
    </div>
    <div class="row nudge small" role="group" aria-label="Adjust phrase ${i + 1}">
      <span class="muted">Start</span><button class="chip" data-action="vid-nudge" data-i="${i}" data-edge="start" data-d="-0.5">−½s</button><button class="chip" data-action="vid-nudge" data-i="${i}" data-edge="start" data-d="0.5">+½s</button>
      <span class="muted">End</span><button class="chip" data-action="vid-nudge" data-i="${i}" data-edge="end" data-d="-0.5">−½s</button><button class="chip" data-action="vid-nudge" data-i="${i}" data-edge="end" data-d="0.5">+½s</button>
      <button class="chip" data-action="vid-del" data-i="${i}" aria-label="Delete phrase ${i + 1}">✕</button>
    </div>
  </li>`;
}

function shadowPanel(p, i) {
  const at = V.att[i];
  return `<div class="card shadow-card" id="vid-shadow">
    <h3>Shadow phrase ${i + 1}</h3>
    <div class="row chips" role="group" aria-label="Mode">
      <button class="chip ${prefs.mode === 'after' ? 'on' : ''}" data-action="vid-mode" data-mode="after">Repeat after</button>
      <button class="chip ${prefs.mode === 'along' ? 'on' : ''}" data-action="vid-mode" data-mode="along">Along with 🎧</button>
    </div>
    <p class="muted small">${prefs.mode === 'after' ? 'The phrase plays, then it\'s your turn. Copy the rhythm and melody first, the sounds second.' : 'Wear headphones and speak at the same time, half a word behind.'}</p>
    <div class="row">
      <button class="btn btn-primary" data-action="vid-go" ${V.busy ? 'disabled' : ''}>${prefs.mode === 'after' ? '🎙 Listen, then repeat' : '🎙 Shadow along'}</button>
    </div>
    <p class="small" id="vid-status" aria-live="polite">${esc(V.err || '')}</p>
    ${at ? `<div class="attempt">
      ${at.silent ? '<p>I couldn\'t hear you. Check the microphone and try again.</p>' : `
      <p class="small">You took <strong>${at.mine.toFixed(1)} s</strong> of speech; the phrase is <strong>${at.theirs.toFixed(1)} s</strong> at this speed, pauses included.</p>
      <div class="row">
        <button class="btn btn-ghost" data-action="vid-yours">▶ You</button>
        <button class="btn btn-ghost" data-action="vid-both">▶ Them, then you</button>
        ${at.heard == null ? '<button class="btn btn-ghost" data-action="vid-heard">What did I sound like?</button>' : ''}
      </div>
      ${at.heard != null ? `<p class="small">Speech recognition heard: <span lang="it">“${esc(at.heard || '…')}”</span>. Compare it with the captions: words it got wrong are the ones to say more clearly.</p>` : ''}
      <p class="small"><strong>How close was it?</strong> Listen to both, then be honest:</p>
      <div class="row chips" role="group" aria-label="Rate this attempt">${['Not yet', 'Close', 'Got it'].map((l, k) => `
        <button class="chip ${p.rating === k ? 'on' : ''}" data-action="vid-rate" data-r="${k}">${l}</button>`).join('')}</div>`}
    </div>` : ''}
    <p class="muted small">Full rhythm and melody scores only work on the app's own clips: the browser can't read the sound inside a YouTube player.</p>
  </div>`;
}

// ---------- player wiring ----------
function teardown() {
  if (!V) return;
  V.player?.destroy();
  listen.stopNoise();
  shadow.closeMic();
  Object.values(V.att).forEach((a) => a.url && URL.revokeObjectURL(a.url));
  if (V.timerByUs && store.get().timer?.skill === 'listen') store.stopTimer();
  V = null;
}

function mountPlayer(start = 0) {
  const box = document.getElementById('video-frame');
  if (!box || !V) return;
  if (V.player && box.firstChild === V.player.iframe) return;
  if (V.player) { if (V.player.ready) start = V.player.time(); V.player.destroy(); } // the app re-rendered the page
  const f = document.createElement('iframe');
  f.src = yt.embedUrl(V.id, { start, captions: prefs.captions, lang: store.get().settings.language });
  f.title = 'YouTube video player';
  f.allow = 'autoplay; encrypted-media; picture-in-picture';
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.allowFullscreen = true;
  box.replaceChildren(f);
  let wasPlaying = false;
  V.player = new yt.Player(f, () => {
    const p = V?.player; if (!p) return;
    if (p.ready && !p._rateSet) { p._rateSet = true; if (prefs.speed !== 1) p.setRate(prefs.speed); }
    const err = document.getElementById('video-error');
    if (err && p.error) { err.hidden = false; err.firstChild.textContent = `${p.error} `; }
    if (p.playing !== wasPlaying) {
      wasPlaying = p.playing;
      if (p.playing) {
        if (!store.get().timer) { store.startTimer('listen'); V.timerByUs = true; }
        if (prefs.distracted) listen.startNoise(prefs.noiseKind, 0.5, null);
      } else listen.stopNoise();
    }
  });
}
// The time display ticks on its own (YouTube only reports a few times a second).
setInterval(() => {
  const el = document.getElementById('vid-time');
  if (el && V?.player?.ready) el.textContent = `${fmt(V.player.time())}${V.player.duration ? ` / ${fmt(V.player.duration)}` : ''}`;
}, 250);

function savePhrases(list) { store.setPhrases(V.id, list.sort((a, b) => a.start - b.start)); }
function status(msg) { const el = document.getElementById('vid-status'); if (el) el.textContent = msg; }
// Update the phrase list and shadowing panel in place: a full render would
// replace the iframe, and a moved or re-created iframe reloads the video.
function rerender() {
  const a = document.getElementById('vid-phrases'), b = document.getElementById('vid-panel');
  if (!V || !a || !b) { H.render(); return; }
  const ph = phrasesOf(V.id);
  a.innerHTML = phrasesCard(ph);
  b.innerHTML = panelHtml(ph);
}

async function playPhrase(p) {
  const pl = V.player;
  do { await pl.playRange(p.start, p.end); } while (V?.loop && V.player === pl && !V.busy && V.looping);
}

async function attempt(i) {
  const p = phrasesOf(V.id)[i], pl = V.player;
  if (!p || !pl?.ready) { V.err = pl?.error || 'The player isn\'t ready yet.'; rerender(); return; }
  V.busy = true; V.err = ''; V.looping = false;
  const go = document.querySelector('[data-action=vid-go]'); if (go) go.disabled = true;
  const theirs = (p.end - p.start) / prefs.speed;
  try {
    let take;
    if (prefs.mode === 'after') {
      status('Listen…');
      await shadow.openMic(); // ask for the microphone before the phrase plays
      await pl.playRange(p.start, p.end);
      status('🔴 Your turn. Tap Done when you finish.');
      if (go) { go.disabled = false; go.textContent = '■ Done'; go.dataset.action = 'vid-done'; }
      take = await shadow.record(theirs * 1.6 + 1.2);
    } else {
      status('🔴 Recording. Speak along.');
      const recP = shadow.record(theirs + 2);
      await new Promise((r) => setTimeout(r, 150));
      await pl.playRange(p.start, p.end);
      setTimeout(shadow.stopRecording, 700);
      take = await recP;
    }
    const a = kit.analyse(take.samples, take.sr);
    if (V.att[i]?.url) URL.revokeObjectURL(V.att[i].url);
    V.att[i] = a.silent ? { silent: true } : { url: URL.createObjectURL(take.blob), blob: take.blob, mine: a.seconds, theirs, heard: null };
    if (!a.silent) store.logShadow(`yt:${V.id}`, i, null);
  } catch (e) { V.err = e.message || 'Something went wrong.'; }
  if (V) V.busy = false;
  if (location.hash.startsWith(`#/video/${V?.id}`)) rerender();
}

function playBlob(url) { const a = new Audio(url); return new Promise((r) => { a.onended = r; a.onpause = r; a.play().catch(r); }); }

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'add-video') return;
  e.preventDefault();
  const raw = document.getElementById('video-url').value;
  const id = yt.parseVideoId(raw);
  if (!id) { H.toast('That doesn\'t look like a YouTube link.'); return; }
  const name = document.getElementById('video-name').value.trim();
  store.addVideo({ id, title: name });
  const start = yt.parseStart(raw);
  location.hash = `#/video/${id}${start ? `?t=${start}` : ''}`;
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action^="vid-"]');
  if (!btn || !V) return;
  const act = btn.dataset.action, pl = V.player, i = Number(btn.dataset.i);
  const ph = phrasesOf(V.id);
  if (act === 'vid-back') { if (pl?.ready) pl.seek(Math.max(0, pl.time() - 5)); }
  else if (act === 'vid-speed') {
    prefs.speed = Number(btn.dataset.speed); pl?.setRate(prefs.speed);
    document.querySelectorAll('[data-action=vid-speed]').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === prefs.speed));
  } else if (act === 'vid-cc') {
    prefs.captions = !prefs.captions;
    const t = pl?.ready ? pl.time() : 0;
    btn.classList.toggle('on', prefs.captions); btn.setAttribute('aria-pressed', String(prefs.captions));
    V.player?.destroy(); V.player = null;
    mountPlayer(t);
  } else if (act === 'vid-noise') {
    prefs.noiseKind = btn.dataset.kind;
    document.querySelectorAll('[data-action=vid-noise]').forEach((b) => b.classList.toggle('on', b.dataset.kind === prefs.noiseKind));
    if (pl?.playing && prefs.distracted) listen.startNoise(prefs.noiseKind, 0.5, null);
  } else if (act === 'vid-mark') {
    if (!pl?.ready) { H.toast('Start the video first.'); return; }
    const end = Math.round(pl.time() * 10) / 10;
    const prev = ph.filter((p) => p.end <= end + 0.05).sort((a, b) => b.end - a.end)[0];
    const start = Math.round(Math.max(0, prev && end - prev.end <= 8 && end - prev.end >= 1 ? prev.end : end - 6) * 10) / 10;
    if (end - start < 0.8) { H.toast('Let it play a little longer first.'); return; }
    savePhrases([...ph, { start, end }]);
    H.toast(`Phrase marked: ${fmt(start)}–${fmt(end)}`);
    rerender();
  } else if (act === 'vid-pplay') {
    if (!pl?.ready || V.busy) return;
    V.looping = true; playPhrase(ph[i]);
  } else if (act === 'vid-nudge') {
    const p = ph[i]; if (!p) return;
    p[btn.dataset.edge] = Math.max(0, Math.round((p[btn.dataset.edge] + Number(btn.dataset.d)) * 10) / 10);
    if (p.end - p.start < 0.5) return;
    savePhrases(ph); rerender();
    if (pl?.ready && !V.busy) { V.looping = false; pl.playRange(btn.dataset.edge === 'end' ? Math.max(p.start, p.end - 2) : p.start, btn.dataset.edge === 'end' ? p.end : Math.min(p.end, p.start + 2)); }
  } else if (act === 'vid-del') {
    ph.splice(i, 1); savePhrases(ph);
    if (V.sel === i) V.sel = -1; else if (V.sel > i) V.sel--;
    V.att = {}; rerender();
  } else if (act === 'vid-sel') { V.sel = V.sel === i ? -1 : i; V.err = ''; rerender(); document.getElementById('vid-shadow')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  else if (act === 'vid-mode') { prefs.mode = btn.dataset.mode; rerender(); }
  else if (act === 'vid-go') { if (!V.busy && V.sel >= 0) attempt(V.sel); }
  else if (act === 'vid-done') { shadow.stopRecording(); }
  else if (act === 'vid-yours') { const a = V.att[V.sel]; if (a?.url) playBlob(a.url); }
  else if (act === 'vid-both') {
    const a = V.att[V.sel], p = ph[V.sel];
    if (a?.url && p && pl?.ready) { V.looping = false; await pl.playRange(p.start, p.end); await new Promise((r) => setTimeout(r, 300)); playBlob(a.url); }
  } else if (act === 'vid-heard') {
    const a = V.att[V.sel]; if (!a?.blob) return;
    btn.disabled = true; status('Listening to you…');
    try { a.heard = await shadow.transcribe(a.blob); status(''); rerender(); } catch (err) { status(err.message); btn.disabled = false; }
  } else if (act === 'vid-rate') {
    const p = ph[V.sel]; if (!p) return;
    p.rating = Number(btn.dataset.r); savePhrases(ph);
    store.logShadow(`yt:${V.id}`, V.sel, [30, 65, 95][p.rating]);
    rerender();
  } else if (act === 'vid-remove') {
    store.removeVideo(V.id); teardown(); location.hash = '#/listen';
  }
});

document.addEventListener('change', (e) => {
  if (!V) return;
  if (e.target.id === 'vid-distracted') {
    prefs.distracted = e.target.checked;
    const n = document.getElementById('vid-noise'); if (n) n.hidden = !prefs.distracted;
    if (V.player?.playing) (prefs.distracted ? listen.startNoise(prefs.noiseKind, 0.5, null) : listen.stopNoise());
  } else if (e.target.id === 'vid-loop') { V.loop = e.target.checked; }
});

export function bind(r, params) {
  if (r !== 'video') { teardown(); return; }
  const start = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('t')) || 0;
  mountPlayer(start);
}
