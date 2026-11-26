// Speak, Read, Review, conversation cards, live call and recap screens.
import * as store from './store.js';
import * as coach from './coach.js';
import * as rec from './recommend.js';
import { ratingCard } from './picks.js';

let H = {}; // helpers from app.js: render, toast, blockCard, sectionPage, L, esc, mmss
export function init(helpers) { H = helpers; }
let R = null; // review module (drills, categories)
export function setReview(r) { R = r; }

const esc = (s) => H.esc(s);
// ---------- coach voice ----------
const voices = () => H.L().coach.voices || [];
const voiceSetting = () => store.get().settings.coachVoice || voices()[0]?.key;
let lastVoiceKey = null;
/** The voice for the next call: the chosen one, or a different one each call when rotating. */
function pickVoice() {
  const all = voices();
  if (voiceSetting() !== 'rotate') return all.find((v) => v.key === voiceSetting()) || all[0];
  const pool = all.filter((v) => v.key !== lastVoiceKey);
  return pool[Math.floor(Math.random() * pool.length)] || all[0];
}
// During a call: that call's coach. Otherwise: the chosen coach, or "your coach" when rotating.
const coachName = () => call?.voice?.name
  || (voiceSetting() === 'rotate' ? 'your coach' : (voices().find((v) => v.key === voiceSetting())?.name || H.L().coach.name));

// ---------- content ----------
const content = { scenes: null, cards: null, articles: null, error: null };
let contentPromise = null;
function loadContent() {
  contentPromise ||= Promise.all(['scenes', 'cards', 'articles'].map((n) =>
    fetch(`${H.L().content}${n}.json`).then((r) => { if (!r.ok) throw new Error(n); return r.json(); })))
    .then(([scenes, cards, articles]) => { Object.assign(content, { scenes, cards, articles, error: null }); })
    .catch(() => {
      // Forget the failed attempt so "Try again" (or coming back online) can retry.
      contentPromise = null;
      content.error = 'Could not load the exercises. Check your connection and try again.';
    })
    .finally(() => H.render());
  return contentPromise;
}
function ready() {
  if (content.scenes) return true;
  if (!content.error) loadContent(); // after a failure, wait for a retry instead of looping
  return false;
}
function retryContent() {
  if (content.scenes) return;
  content.error = null;
  loadContent();
  H.render();
}
window.addEventListener('online', () => { if (content.error) retryContent(); });
const loading = () => (content.error
  ? `<div class="card"><p class="muted">${esc(content.error)}</p><button class="btn btn-ghost" data-action="retry-content">Try again</button></div>`
  : '<div class="card"><p class="muted">Loading…</p></div>');

// ---------- shared bits ----------
function keyMissingCard() {
  return `<div class="card notice">
    <h3>Connect your coach</h3>
    <p>Live calls with ${coachName()} need your ElevenLabs API key. It's stored only on this device.</p>
    <a class="btn btn-primary" href="#/settings">Add key in Settings</a>
  </div>`;
}

// Daily coach budget (Settings → Coach minutes per day). 0 = no limit.
function budget() {
  const limit = store.coachDailyMinutes();
  const used = store.callSecondsToday();
  return { limit, usedMin: Math.round(used / 60), reached: limit > 0 && used >= limit * 60, near: limit > 0 && used >= limit * 60 * 0.8 };
}
function budgetCard() {
  const b = budget();
  if (b.reached) return `<div class="card notice warn">
    <h3>Coach time used up for today</h3>
    <p>You've had ${b.usedMin} of your ${b.limit} coach minutes today. New calls are possible again tomorrow, or raise the limit in <a href="#/settings">Settings</a>.</p>
  </div>`;
  if (b.near) return `<p class="pill">${b.usedMin} of ${b.limit} coach minutes used today</p>`;
  return '';
}
/** Whether a new call may start (key present and daily budget left). */
const canCall = () => !!store.getApiKey() && !budget().reached;

export function usageCard() {
  const min = Math.round(store.callSecondsThisMonth() / 60);
  return `<div class="card" id="usage-card">
    <h3>Coach usage this month</h3>
    <p><strong>${min}</strong> min of live calls on this device.</p>
    <div id="credit-meter">${store.getApiKey() ? '<p class="muted small">Checking ElevenLabs credits…</p>' : '<p class="muted small">Add your API key in Settings to see your ElevenLabs credits.</p>'}</div>
  </div>`;
}

let usageCache = null;
const LOW_CREDITS = 5000;
/** Credits left from the last credit reading, or null if there is none. */
const creditsLeft = () => (usageCache?.u ? Math.max(0, usageCache.u.limit - usageCache.u.used) : null);

export async function fillUsage(force = false) {
  const el = document.getElementById('credit-meter');
  if (!el || !store.getApiKey()) return;
  try {
    if (force || !usageCache || Date.now() - usageCache.t > 60000) usageCache = { t: Date.now(), u: await coach.usage() };
    const u = usageCache.u;
    const left = Math.max(0, u.limit - u.used);
    const pct = u.limit ? Math.min(1, u.used / u.limit) : 0;
    el.innerHTML = `
      <div class="bar meter ${pct > 0.85 ? 'warn' : ''}"><span style="width:${pct * 100}%"></span></div>
      <p class="small"><strong>${left.toLocaleString('en-GB')}</strong> of ${u.limit.toLocaleString('en-GB')} ElevenLabs credits left${u.resetsAt ? `, resets ${u.resetsAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}.</p>`;
  } catch (e) {
    usageCache = null;
    const msg = e.code === 'missing_permissions' ? 'Add User: read to your API key to see your ElevenLabs credits here.' : e.message;
    el.innerHTML = `<p class="muted small">${esc(msg)}</p>`;
  }
}

// ---------- Speak ----------
export function viewSpeak() {
  const hasKey = !!store.getApiKey();
  const ok = canCall();
  return `
  <section class="page-head">
    <p class="eyebrow">${H.L().name}</p>
    <h1>🗣 Speaking</h1>
    <p class="muted">Talk out loud with ${coachName()}. They keep the conversation going and quietly notes your mistakes for the recap.</p>
  </section>
  ${hasKey ? budgetCard() : keyMissingCard()}
  ${!ready() ? loading() : `
  <h2 class="section-title">Pick a conversation</h2>
  <div class="scene-grid">${content.scenes.map((sc) => `
    <button class="scene card" data-action="call-scene" data-id="${sc.id}" ${ok ? '' : 'disabled'}>
      <span class="scene-ico" aria-hidden="true">${sc.icon}</span>
      <strong>${esc(sc.title)}</strong>
      <span class="muted small">${esc(sc.subtitle)}</span>
      <span class="muted small">up to ${Math.min(sc.minutes, coach.MAX_CALL_MINUTES)} min</span>
    </button>`).join('')}
  </div>
  <a class="card extra-row" href="#/cards">
    <span class="scene-ico" aria-hidden="true">🃏</span>
    <span><strong>Conversation cards</strong><br><span class="muted small">Extra · 10 to 20 questions and topics, like with your tutor</span></span>
    <span aria-hidden="true">›</span>
  </a>`}
  <h2 class="section-title">Without the coach</h2>
  ${H.blockCard('speak', { compact: true })}
  <p class="muted small">Calls with ${coachName()} count towards your speaking time automatically. Use the timer for other practice, like shadowing a podcast out loud.</p>`;
}

// ---------- Conversation cards ----------
let cardCount = 15;
export function viewCards() {
  const hasKey = !!store.getApiKey();
  return `
  <section class="page-head">
    <p class="eyebrow">Extra</p>
    <h1>🃏 Conversation cards</h1>
    <p class="muted">${coachName()} reads a card, you answer. Quick cards need a sentence or two; "talk about it" cards get follow-up questions. Tap <em>Next card</em> when you're ready to move on.</p>
  </section>
  ${hasKey ? budgetCard() : keyMissingCard()}
  <div class="card">
    <h3>How many cards?</h3>
    <div class="days" role="radiogroup" aria-label="Number of cards">${[10, 15, 20].map((n) => `
      <label class="day-chip"><input type="radio" name="cardcount" value="${n}" ${n === cardCount ? 'checked' : ''}><span>${n}</span></label>`).join('')}
    </div>
    <p class="muted small">About ${cardMinutes()} min of conversation. Calls stop automatically after ${cardLimit()} min${cardMinutes() > cardLimit() - 2 ? ' (the longest call), so you may not get through every card' : ''}.</p>
    <div id="credit-meter">${hasKey ? '<p class="muted small">Checking ElevenLabs credits…</p>' : ''}</div>
    <button class="btn btn-primary" data-action="call-cards" ${canCall() && ready() ? '' : 'disabled'}>Start with ${cardCount} cards</button>
  </div>`;
}
const cardMinutes = () => Math.round(cardCount * 1.2);
// About 1.5 min per card plus a bit, never longer than the longest call.
const cardLimit = () => Math.min(coach.MAX_CALL_MINUTES, Math.round(cardCount * 1.5) + 2);

function drawCards(n) {
  // Topics you enjoy come up a little more often (see recommend.weightedOrder).
  const events = store.get().events;
  const quick = rec.weightedOrder(content.cards.filter((c) => c.type === 'quick'), events);
  const deep = rec.weightedOrder(content.cards.filter((c) => c.type === 'deep'), events);
  // Roughly 60% quick, 40% in depth, mixed so it never gets monotonous.
  const nDeep = Math.round(n * 0.4);
  return shuffle([...deep.slice(0, nDeep), ...quick.slice(0, n - nDeep)]);
}
function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------- Read ----------
export function viewRead(id) {
  if (!ready()) return `<section class="page-head"><h1>📖 Reading</h1></section>${loading()}`;
  if (id) return articleView(id);
  const hasKey = !!store.getApiKey();
  const readDay = store.isReadDay();
  return `
  <section class="page-head">
    <p class="eyebrow">${H.L().name}</p>
    <h1>📖 Reading</h1>
    <p class="muted">Read an article with some depth, then talk it through with ${coachName()} to check you understood the meaning, not just the words.</p>
  </section>
  ${readDay ? '<p class="pill">Today is a reading day: this replaces your speaking block.</p>' : ''}
  ${hasKey ? budgetCard() : keyMissingCard()}
  <div class="article-list">${content.articles.map((a) => {
    const done = store.get().calls.some((c) => c.mode === 'read' && c.ref === a.id);
    return `<a class="card article-row" href="#/read/${a.id}">
      <span class="muted small">${esc(a.topic)} · ${esc(a.level)} · ${a.minutes} min read${done ? ' · discussed ✓' : ''}</span>
      <strong>${esc(a.title)}</strong>
    </a>`;
  }).join('')}</div>
  <h2 class="section-title">Your own reading</h2>
  ${H.blockCard('read', { compact: true })}
  <p class="muted small">Reading something else? Run the timer, then summarise it out loud in two minutes without looking.</p>`;
}

function articleView(id) {
  const a = content.articles.find((x) => x.id === id);
  if (!a) return `<div class="card"><p>Article not found.</p><a href="#/read">Back</a></div>`;
  const hasKey = !!store.getApiKey();
  return `
  <a class="back" href="#/read">‹ Reading</a>
  <article class="reader card">
    <p class="muted small">${esc(a.topic)} · ${esc(a.level)} · ${a.minutes} min read</p>
    <h1 lang="it">${esc(a.title)}</h1>
    ${a.paragraphs.map((p) => `<p lang="it">${esc(p)}</p>`).join('')}
  </article>
  <details class="card glossary">
    <summary><strong>Key words</strong> <span class="muted small">(try without first)</span></summary>
    <dl>${a.glossary.map(([w, m]) => `<div><dt lang="it">${esc(w)}</dt><dd>${esc(m)}</dd></div>`).join('')}</dl>
  </details>
  <div class="card notice">
    <h3>Now talk about it</h3>
    <p>${coachName()} will ask you to sum it up, check the main points and ask what you think. Try not to look back at the text.</p>
    ${!hasKey ? '<a class="btn btn-primary" href="#/settings">Add API key to discuss</a>'
    : canCall() ? `<button class="btn btn-primary" data-action="call-read" data-id="${a.id}">Discuss with ${coachName()}</button>`
    : '<p class="muted small">Your coach minutes for today are used up. Raise the limit in <a href="#/settings">Settings</a>, or come back tomorrow.</p>'}
  </div>`;
}

// ---------- Review (mistake log; drills come in step 4) ----------
export function viewReview() {
  const ms = store.get().mistakes;
  const byCat = {};
  ms.forEach((m) => { byCat[m.category] = (byCat[m.category] || 0) + 1; });
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return `
  <section class="page-head">
    <p class="eyebrow">${H.L().name}</p>
    <h1>✎ Review</h1>
    <p class="muted">Every mistake ${coachName()} notices ends up here. Read them out loud in the correct form, it's the fastest way to make them stick.</p>
  </section>
  ${(() => { const due = R.dueCount(); return ms.length ? `<div class="card notice"><h3>${due ? `${due} card${due === 1 ? '' : 's'} to practise` : 'All caught up'}</h3>
    <p class="muted">${due ? 'Fix your own mistakes, out loud. Cards you find hard come back sooner.' : 'Nothing is due right now. New mistakes from conversations are added automatically.'}</p>
    ${due ? '<a class="btn btn-primary" href="#/drill">Start drills</a>' : ''}</div>` : ''; })()}
  ${H.blockCard('review', { compact: true })}
  ${top.length ? `<div class="card"><h3>What you get wrong most</h3>
    ${top.map(([c, n]) => `<div class="skill-row"><span>${esc(R.CATEGORY[c]?.it || c)}</span><div class="bar"><span style="width:${(n / top[0][1]) * 100}%"></span></div><span class="muted">${n}</span></div>`).join('')}
  </div>` : ''}
  <h2 class="section-title">Mistake log ${ms.length ? `<span class="muted small">(${ms.length})</span>` : ''}</h2>
  ${ms.length ? `<div class="mistakes">${ms.slice(0, 100).map(mistakeRow).join('')}</div>`
    : `<div class="card"><p class="muted">No mistakes yet. Have a conversation with ${coachName()} and they'll show up here.</p></div>`}
  <a class="card extra-row" href="#/report"><span class="scene-ico" aria-hidden="true">📝</span><span><strong>Report for your tutor</strong><br><span class="muted small">Your recurring mistakes and how they're changing</span></span><span aria-hidden="true">›</span></a>`;
}

function mistakeRow(m) {
  return `<div class="mistake card">
    <p class="said" lang="it"><s>${esc(m.said)}</s></p>
    <p class="correct" lang="it">${esc(m.correct)}</p>
    ${m.explanation ? `<p class="muted small">${esc(m.explanation)}</p>` : ''}
    <p class="muted small">${esc(m.category)} · ${new Date(m.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${m.source ? ` · ${esc(m.source)}` : ''}
      <button class="link-btn" data-action="del-mistake" data-id="${m.id}" aria-label="Remove">Remove</button></p>
  </div>`;
}

// ---------- live call ----------
let call = null;     // { mode, title, ref, ctrl, status, aiMode, started, messages, mistakes, cards, cardIndex, subtitles }
let lastRecap = null;

function buildPrompt(activity) {
  return `${H.L().coach.persona}\n\nACTIVITY FOR THIS CALL:\n${activity}`;
}
function personaFor(v, prompt) {
  return prompt.replace('{name}', v.name).replace('{city}', v.city).replace('{gender}', v.gender === 'male' ? 'a man' : 'a woman');
}

const routeName = () => (location.hash.replace(/^#\/?/, '') || 'today').split(/[/?]/)[0];
const isAppText = (t) => /^\s*\[APP\]/.test(t || ''); // our own instructions to the coach, never shown

async function startCall(opts) {
  if (call) return;
  if (budget().reached) { H.toast('You\'ve used your coach minutes for today. You can change the limit in Settings.'); return; }
  const left = creditsLeft();
  if (!opts.confirmed && left !== null && left < LOW_CREDITS) { askLowCredits(opts, left); return; }
  const { mode, title, ref, skill, cards, item } = opts;
  let { prompt, firstMessage } = opts;
  const maxMinutes = Math.min(opts.maxMinutes, coach.MAX_CALL_MINUTES);
  store.stopTimer(); // calls log their own time
  const voice = pickVoice();
  lastVoiceKey = voice?.key;
  if (voice) { prompt = personaFor(voice, prompt); firstMessage = firstMessage.replace(/\bElena\b/g, voice.name); }
  const me = { voice, item, mode, title, ref, skill, status: 'starting', aiMode: 'listening', started: null, messages: [], mistakes: [], cards, cardIndex: 0, subtitles: false, maxMinutes, abort: new AbortController() };
  call = me;
  // Callbacks only act while this call is still the current one (not cancelled or replaced).
  const live = () => call === me;
  location.hash = '#/call';
  try {
    const ctrl = await coach.startCall({
      agentId: H.L().coach.agentId,
      prompt, firstMessage, voiceId: voice?.id,
      maxSeconds: maxMinutes * 60,
      wrapUp: H.L().coach.wrapUp,
      signal: me.abort.signal,
      onStatus: (st) => { if (!live()) return; me.status = st; if (st === 'connected' && !me.started) me.started = Date.now(); updateCall(); updateBar(); },
      onMode: (m) => { if (!live()) return; me.aiMode = m; updateCall(); },
      onMessage: (m) => { if (!live() || !m?.message || isAppText(m.message)) return; me.messages.push({ who: m.role === 'user' || m.source === 'user' ? 'you' : 'coach', text: m.message }); updateCall(); },
      onMistake: (p) => { if (!live()) return; const item = store.addMistake(p, me.title); if (item) { me.mistakes.push(item); updateCall(); } },
      onError: (msg) => { if (live()) H.toast(msg); },
      onEnd: ({ seconds, error }) => endCall(me, seconds, error),
    });
    if (!ctrl || !live()) return; // cancelled while connecting: the session was closed
    me.ctrl = ctrl;
    updateCall(); updateBar();
  } catch (e) {
    dropCall(me, e.message || 'Could not start the call.');
  }
}

/** A call that never got going (cancelled, refused, failed): nothing is logged. */
function dropCall(c, msg) {
  if (call !== c) return;
  c.abort.abort();
  call = null;
  updateBar();
  if (msg) H.toast(msg);
  if (routeName() === 'call') history.back();
}

/** End or cancel the current call, from the call screen, the call bar or when the page closes. */
function hangUp() {
  if (!call) return;
  if (call.ctrl) call.ctrl.end(); // reports the end synchronously → endCall
  else dropCall(call, 'Call cancelled.');
}

function endCall(c, seconds, error = '') {
  if (call !== c) return;
  const secs = c.started ? Math.round((Date.now() - c.started) / 1000) : 0;
  // Refused or cut off before anything happened: show why, and don't count it as a call.
  if (!c.started || (error && secs < 10 && !c.messages.length)) { dropCall(c, error || 'The call could not connect.'); return; }
  call = null;
  if (secs > 0) store.addSeconds(store.dayKey(), c.skill, secs);
  store.logCall({ mode: c.mode, title: c.title, ref: c.ref, seconds: secs, mistakes: c.mistakes.length });
  if (c.item) {
    // How engaged you were: long, talkative calls count for the topic; quick exits against it.
    const yourTurns = c.messages.filter((m) => m.who === 'you').length;
    store.logEvent({ item: c.item.key, topics: c.item.topics, type: 'talk', w: rec.callWeight({ seconds: secs, maxMinutes: c.maxMinutes, yourTurns }) });
  }
  lastRecap = { item: c.item, title: c.title, mode: c.mode, seconds: secs, mistakes: c.mistakes, messages: c.messages, cardsDone: c.cards ? c.cardIndex + 1 : null, cardsTotal: c.cards?.length, dropped: error || '' };
  usageCache = null;
  updateBar();
  location.hash = '#/recap';
}

// ---------- "call in progress" bar on other screens ----------
function updateBar() {
  let el = document.getElementById('call-bar');
  if (!call || routeName() === 'call') {
    el?.remove();
    document.body.classList.remove('has-call-bar');
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'call-bar';
    el.className = 'call-bar';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  document.body.classList.add('has-call-bar');
  el.innerHTML = `<span class="call-bar-text"><strong>${call.ctrl ? 'Call in progress' : 'Connecting…'}</strong> · ${esc(call.title)}</span>
    <a class="btn btn-primary" href="#/call">Return</a>
    <button class="btn btn-danger" data-action="end-call">End</button>`;
}

// ---------- low credits: confirm before starting ----------
let pendingStart = null;
function askLowCredits(opts, left) {
  closeSheet();
  pendingStart = opts;
  const el = document.createElement('div');
  el.id = 'confirm-sheet';
  el.className = 'sheet';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'confirm-title');
  el.innerHTML = `<div class="card sheet-card">
    <h3 id="confirm-title">Only ${left.toLocaleString('en-GB')} ElevenLabs credits left</h3>
    <p class="muted">The call may stop early when your credits run out. Start anyway?</p>
    <div class="row">
      <button class="btn btn-primary" data-action="confirm-start">Start anyway</button>
      <button class="btn btn-ghost" data-action="confirm-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('[data-action=confirm-start]').focus();
}
function closeSheet() { pendingStart = null; document.getElementById('confirm-sheet')?.remove(); }

export function viewCall() {
  if (!call) { setTimeout(() => { location.hash = lastRecap ? '#/recap' : '#/speak'; }); return ''; }
  return `<section class="call" aria-live="polite">
    <p class="eyebrow center">${esc(call.title)}</p>
    <div class="orb-wrap"><div class="orb" id="orb"></div></div>
    <p class="call-status center" id="call-status"></p>
    <p class="call-time center" id="call-time">0:00</p>
    <div id="card-box"></div>
    <div id="subs" class="subs" hidden></div>
    <div class="call-actions">
      <button class="btn btn-ghost" data-action="toggle-subs" id="subs-btn">Subtitles off</button>
      <button class="btn btn-danger" data-action="end-call">End call</button>
    </div>
    <p class="muted small center" id="call-mistakes"></p>
  </section>`;
}

function updateCall() {
  if (!call || !document.getElementById('orb')) return;
  const orb = document.getElementById('orb');
  const speaking = call.status === 'connected' && call.aiMode === 'speaking';
  orb.className = `orb ${call.status !== 'connected' ? 'idle' : speaking ? 'speaking' : 'listening'}`;
  document.getElementById('call-status').textContent =
    call.status === 'connected' ? (speaking ? `${coachName()} is talking…` : 'Your turn, go ahead') : 'Connecting…';
  document.getElementById('call-mistakes').textContent = call.mistakes.length ? `${call.mistakes.length} thing${call.mistakes.length === 1 ? '' : 's'} to review afterwards` : '';
  const subs = document.getElementById('subs');
  subs.hidden = !call.subtitles;
  document.getElementById('subs-btn').textContent = call.subtitles ? 'Subtitles on' : 'Subtitles off';
  if (call.subtitles) {
    subs.innerHTML = call.messages.slice(-6).map((m) => `<p class="${m.who}" lang="it"><strong>${m.who === 'you' ? 'You' : coachName()}:</strong> ${esc(m.text)}</p>`).join('');
    subs.scrollTop = subs.scrollHeight;
  }
  const box = document.getElementById('card-box');
  if (call.cards) {
    const c = call.cards[call.cardIndex];
    const last = call.cardIndex >= call.cards.length - 1;
    box.innerHTML = `<div class="flashcard card">
      <p class="muted small">Card ${call.cardIndex + 1} of ${call.cards.length} · ${c.type === 'deep' ? 'talk about it' : 'quick answer'}</p>
      <p class="flashcard-text" lang="it">${esc(c.text)}</p>
      <button class="btn btn-primary" data-action="next-card" ${call.status === 'connected' ? '' : 'disabled'}>${last ? 'Finish' : 'Next card'}</button>
    </div>`;
  }
}

setInterval(() => {
  if (!call?.started) return;
  const el = document.getElementById('call-time');
  if (el) el.textContent = `${H.mmss(Math.round((Date.now() - call.started) / 1000))} / ${call.maxMinutes}:00`;
}, 500);

export function viewRecap() {
  const r = lastRecap;
  if (!r) { setTimeout(() => { location.hash = '#/speak'; }); return ''; }
  return `
  <section class="page-head">
    <p class="eyebrow">Recap</p>
    <h1>${r.mistakes.length ? 'Bravo! Here\'s what to fix' : 'Bravo!'}</h1>
    <p class="muted">${esc(r.title)} · ${H.mmss(r.seconds)} min${r.cardsTotal ? ` · ${r.cardsDone} of ${r.cardsTotal} cards` : ''} · added to your ${r.mode === 'read' ? 'reading' : 'speaking'} time.</p>
  </section>
  ${r.dropped ? `<div class="card notice warn"><p><strong>The call dropped.</strong> ${esc(r.dropped)}</p><p class="muted small">The time until then still counts.</p></div>` : ''}
  ${r.mistakes.length
    ? `<div class="mistakes">${r.mistakes.map(mistakeRow).join('')}</div><p class="muted small">Say each correct version out loud once. They're saved in Review.</p>`
    : `<div class="card"><p>${coachName()} didn't note any clear mistakes this time${r.seconds < 90 ? ' (it was a short call)' : ''}.</p></div>`}
  ${r.messages.length ? `<details class="card"><summary><strong>Transcript</strong></summary>
    <div class="subs">${r.messages.map((m) => `<p class="${m.who}" lang="it"><strong>${m.who === 'you' ? 'You' : coachName()}:</strong> ${esc(m.text)}</p>`).join('')}</div></details>` : ''}
  ${r.item ? ratingCard(r.item) : ''}
  <div class="row"><a class="btn btn-primary" href="#/today">Back to today</a><a class="btn btn-ghost" href="#/review">Open review</a></div>`;
}

// ---------- settings ----------
let keyNote = ''; // result of the last "Save and test"
export function settingsCard() {
  const key = store.getApiKey();
  return `<form class="card" id="coach-form" autocomplete="off">
    <h3>Coach (ElevenLabs)</h3>
    <p class="muted">Your API key is stored only on this device. It's never part of the app's code or your backup file.</p>
    ${key ? `<p class="small" id="key-status"><strong>Key saved</strong> · ends in <code>${esc(key.slice(-4))}</code></p>` : ''}
    <label class="stack"><span>${key ? 'Replace key' : 'API key'}</span>
      <input type="password" name="key" value="" placeholder="${key ? 'Paste a new key to replace' : 'sk_…'}" spellcheck="false" autocapitalize="off" autocomplete="off"></label>
    <details class="small"><summary>How to make a safe key</summary>
      <ol>
        <li>In ElevenLabs, go to <em>Developers → API keys → Create key</em>.</li>
        <li>Turn on <strong>restrict key</strong> and allow only <strong>ElevenAgents</strong> (to start calls), <strong>Text to Speech</strong> (to voice listening clips) and <strong>User: read</strong> (for the credit meter).</li>
        <li>Set a monthly <strong>credit limit</strong> on the key, for example 60,000, so a leaked key can't spend more than that.</li>
      </ol>
    </details>
    <div class="row">
      <button class="btn btn-primary" type="submit">Save and test</button>
      ${key ? '<button class="btn btn-ghost" type="button" data-action="forget-key">Remove key</button>' : ''}
    </div>
    ${keyNote ? `<p class="small" id="key-note">${esc(keyNote)}</p>` : ''}
    <div id="credit-meter"></div>
  </form>
  <form class="card" id="budget-form">
    <h3>Coach time per day</h3>
    <p class="muted">A daily cap on live calls, to keep your ElevenLabs credits in check. New calls can't start once it's reached. 0 means no limit.</p>
    <label class="field">
      <span>Coach minutes per day</span>
      <input type="number" name="minutes" min="0" max="600" step="5" value="${store.coachDailyMinutes()}" inputmode="numeric">
      <span class="muted">min</span>
    </label>
    <p class="muted small">Today: ${Math.round(store.callSecondsToday() / 60)} min of calls so far.</p>
    <button class="btn btn-primary" type="submit">Save</button>
  </form>
  ${voices().length > 1 ? `<div class="card">
    <h3>Coach voice</h3>
    <p class="muted">Pick who you talk to, or let the app switch to a different voice each call so you get used to more voices and accents. The coach's name follows the voice.</p>
    <label class="stack"><span>Voice</span>
      <select id="coach-voice">
        <option value="rotate"${voiceSetting() === 'rotate' ? ' selected' : ''}>Different voice each call</option>
        ${voices().map((v) => `<option value="${v.key}"${voiceSetting() === v.key ? ' selected' : ''}>${esc(v.name)} (${v.gender === 'male' ? 'm' : 'f'}, ${esc(v.accent)})</option>`).join('')}
      </select></label>
  </div>` : ''}`;
}

/** What the app knows about a scene or article for personal picks. */
const itemOf = (kind, x, skill) => ({ key: `${kind}:${x.id}`, topics: x.topics || [], d: rec.levelNum(x.level), skill });

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;
  const L = H.L();
  if (a === 'call-scene') {
    if (!content.scenes) await loadContent(); // started from Today's picks before Speak was opened
    const sc = content.scenes?.find((x) => x.id === btn.dataset.id);
    if (!sc) return;
    startCall({ mode: 'scene', title: sc.title, ref: sc.id, skill: 'speak', item: itemOf('scene', sc, 'speak'), maxMinutes: sc.minutes, firstMessage: sc.firstMessage,
      prompt: buildPrompt(sc.instructions) });
  } else if (a === 'call-read') {
    const ar = content.articles.find((x) => x.id === btn.dataset.id);
    startCall({ mode: 'read', title: ar.title, ref: ar.id, skill: 'read', item: itemOf('article', ar, 'read'), maxMinutes: 12,
      firstMessage: `Allora, hai letto l'articolo "${ar.title}". Me lo riassumi con parole tue?`,
      prompt: buildPrompt(`A discussion about an article the learner has just read. Their goal is to show they understood the meaning, and to talk about it.
1. Start by asking them to summarise it in their own words (already done in your first message).
2. Then go through the key points below one at a time with open questions, like a curious friend, not like an exam. If they misunderstood something, ask a question that helps them reconsider; don't explain in English.
3. Encourage them to use the article's vocabulary: ${ar.glossary.map(([w]) => w).join(', ')}. If they avoid a word, set up a question where it fits naturally.
4. Finish with their opinion and one personal connection.

Key points:
${ar.discussion.map((d, i) => `${i + 1}. ${d}`).join('\n')}

The article:
"${ar.title}"
${ar.paragraphs.join('\n\n')}`) });
  } else if (a === 'call-cards') {
    const cards = drawCards(cardCount);
    startCall({ mode: 'cards', title: 'Conversation cards', ref: 'cards', skill: 'speak', maxMinutes: cardLimit(), cards,
      firstMessage: `Allora, giochiamo con le carte! Prima carta: ${cards[0].text}`,
      prompt: buildPrompt(`Conversation cards, like the flashcard game the learner plays with their tutor. The app shows one card at a time on screen.
- You already read the first card in your first message.
- For a "quick" card: let the learner answer in a sentence or two, react naturally in one short sentence, at most one tiny follow-up.
- For a "talk about it" card: ask 2 to 4 follow-up questions that push for detail, reasons and examples, and share a brief opinion of your own.
- When the learner taps Next, you'll get an [APP] message with the next card. Then read that card aloud naturally (you can introduce it with "Prossima carta:") and continue.
- Don't move to a new card on your own.

The deck for this call, in order:
${cards.map((c, i) => `${i + 1}. [${c.type === 'deep' ? 'talk about it' : 'quick'}] ${c.text}`).join('\n')}`) });
  } else if (a === 'next-card' && call?.cards) {
    // say() sends a user message (not a contextual update), so the coach answers by reading the card.
    if (call.cardIndex >= call.cards.length - 1) {
      call.ctrl?.say('[APP] That was the last card. Thank the learner, give one sentence of encouragement and say goodbye.');
      btn.disabled = true;
    } else {
      call.cardIndex++;
      const c = call.cards[call.cardIndex];
      call.ctrl?.say(`[APP] Next card (${call.cardIndex + 1} of ${call.cards.length}, ${c.type === 'deep' ? 'talk about it' : 'quick'}): ${c.text}`);
      updateCall();
    }
  } else if (a === 'end-call') {
    btn.disabled = true;
    hangUp();
  } else if (a === 'confirm-start' && pendingStart) {
    const opts = pendingStart;
    closeSheet();
    startCall({ ...opts, confirmed: true });
  } else if (a === 'confirm-cancel') {
    closeSheet();
  } else if (a === 'retry-content') {
    retryContent();
  } else if (a === 'toggle-subs' && call) {
    call.subtitles = !call.subtitles; updateCall();
  } else if (a === 'del-mistake') {
    store.deleteMistake(btn.dataset.id); H.render();
  } else if (a === 'forget-key') {
    store.setApiKey(''); usageCache = null; keyNote = ''; H.toast('Key removed from this device.'); H.render();
  }
});

export function bind(r) {
  closeSheet();
  updateBar();
  if (r === 'call') updateCall();
  if (r === 'cards') {
    fillUsage();
    document.querySelectorAll('input[name=cardcount]').forEach((i) => i.addEventListener('change', () => { cardCount = Number(i.value); H.render(); }));
  }
  if (r === 'settings') {
    document.getElementById('coach-voice')?.addEventListener('change', (e) => {
      store.setCoachVoice(e.target.value);
      H.toast(e.target.value === 'rotate' ? 'A different voice each call.' : `Your coach is now ${coachName()}.`);
    });
    if (store.getApiKey()) fillUsage();
    document.getElementById('coach-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('[type=submit]');
      // An empty field keeps the saved key (Remove key deletes it).
      const typed = String(new FormData(e.target).get('key') || '').trim();
      if (typed) store.setApiKey(typed);
      const key = store.getApiKey();
      if (!key) { H.toast('Paste your ElevenLabs API key first.'); return; }
      usageCache = null;
      btn.disabled = true;
      H.toast(typed ? 'Key saved. Testing…' : 'Testing your key…');
      try {
        // Test what calls need (a signed URL for the agent); credits are a bonus.
        const t = await coach.testKey(key, H.L().coach.agentId);
        if (t.usage) usageCache = { t: Date.now(), u: t.usage };
        keyNote = t.usageError || 'Key works for calls ✓';
        H.toast(t.usageError ? 'Key works for calls ✓' : 'Key works ✓');
      } catch (err) {
        keyNote = err.message;
        H.toast(err.message);
      }
      H.render();
    });
    document.getElementById('budget-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      store.setCoachDailyMinutes(new FormData(e.target).get('minutes'));
      const m = store.coachDailyMinutes();
      H.toast(m ? `Coach calls limited to ${m} min a day.` : 'No daily limit on coach calls.');
      H.render();
    });
  }
}

// Warn before closing the page mid-call, and never leave a call running in a page that is gone.
window.addEventListener('beforeunload', (e) => { if (call) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', () => hangUp());
