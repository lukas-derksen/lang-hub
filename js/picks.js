// Today's picks, the "How was it?" rating card, and the "What the app has
// learned" card. The ranking itself lives in recommend.js.
import * as store from './store.js';
import * as rec from './recommend.js';
import * as server from './server.js';

let H = {}; // helpers from app.js: render, toast, L, esc
export function init(helpers) { H = helpers; }
const esc = (s) => H.esc(s);

// ---------- catalog: every pickable item in the current language ----------
let cat = null, catBase = null, catLoading = null, catError = false;

function loadCatalog() {
  const base = H.L().content;
  if (catBase !== base) { cat = null; catLoading = null; catError = false; catBase = base; }
  catLoading ||= Promise.all(['scenes', 'articles', 'clips'].map((n) =>
    fetch(`${base}${n}.json`).then((r) => { if (!r.ok) throw new Error(n); return r.json(); })))
    .then(([scenes, articles, clips]) => {
      if (catBase !== base) return;
      const item = (kind, skill, x, extra) => ({
        key: `${kind}:${x.id}`, kind, skill, id: x.id, title: x.title, topics: x.topics || [],
        level: x.level || 'B1', d: rec.levelNum(x.level), ...extra,
      });
      cat = [
        ...[...server.byKind('scene'), ...scenes].map((x) => item('scene', 'speak', x, { icon: x.icon, sub: x.subtitle })),
        ...[...server.byKind('article'), ...articles].map((x) => item('article', 'read', x, { minutes: x.minutes })),
        ...[...server.byKind('clip').filter((c) => c.segments.every((sg) => clips.voices?.[sg.voice])), ...clips.clips].map((x) => item('clip', 'listen', x, { questions: x.questions.length, sub: x.genre })),
      ];
      catError = false;
    })
    .catch(() => { catLoading = null; catError = true; })
    .finally(() => { if (routeName() === 'today') H.render(); });
  return catLoading;
}
const routeName = () => (location.hash.replace(/^#\/?/, '') || 'today').split(/[/?]/)[0];
const byKey = (k) => cat?.find((x) => x.key === k);

/** Forget the catalog (new content arrived). Today's picks stay as chosen until tomorrow. */
export function reset() { cat = null; catLoading = null; catError = false; }

/** Ratings for an item from the catalog, for screens that only know the key. */
export function itemFor(key) { return byKey(key); }

// ---------- history from data recorded before picks existed ----------
function extraHistory() {
  const s = store.get(), h = {};
  for (const [id, r] of Object.entries(s.listening || {})) {
    const it = byKey(`clip:${id}`);
    if (r?.last) h[`clip:${id}`] = { lastAt: r.last, perf: it?.questions ? r.best / it.questions : null };
  }
  for (const c of s.calls) {
    const kind = c.mode === 'read' ? 'article' : c.mode === 'scene' ? 'scene' : null;
    if (!kind || !c.ref) continue;
    const k = `${kind}:${c.ref}`;
    if (!h[k] || h[k].lastAt < c.at) h[k] = { lastAt: c.at, perf: null };
  }
  return h;
}

/** Which slots get a pick today: the speaking (or reading) block and listening. */
function slotsToday() {
  const p = store.planFor();
  const out = [];
  if (p.read > 0) out.push('read'); else if (p.speak > 0) out.push('speak');
  if (p.listen > 0) out.push('listen');
  return out;
}
const SLOT = {
  speak: { icon: '🗣', label: 'Speaking' },
  read: { icon: '📖', label: 'Reading' },
  listen: { icon: '🎧', label: 'Listening' },
};

/** Today's picks, computed once a day (and when the routine changes), then kept. */
function todaysPicks() {
  const day = store.dayKey(), lang = store.get().settings.language, slots = slotsToday();
  const cur = store.get().picks;
  if (cur && cur.day === day && cur.lang === lang && slots.every((s) => cur.slots?.[s]?.length)) return cur;
  const events = store.get().events;
  const next = { day, lang, slots: {}, idx: {} };
  for (const s of slots) {
    next.slots[s] = rec.pick(cat.filter((x) => x.skill === s), { events, skill: s, seed: day, extraHistory: extraHistory() });
    next.idx[s] = 0;
  }
  // Save outside of rendering (saving notifies listeners).
  setTimeout(() => { if (store.get().picks?.day !== day || store.get().picks?.lang !== lang || !slots.every((s) => store.get().picks.slots?.[s])) store.setPicks(next); });
  return next;
}

/** Whether you already did this item today. */
function doneToday(key) {
  const day = store.dayKey(), s = store.get();
  if (s.events.some((e) => e.item === key && e.type !== 'skip' && store.dayKey(new Date(e.at)) === day)) return true;
  const [kind, id] = key.split(':');
  if (kind === 'clip') { const r = s.listening?.[id]; return !!r?.last && store.dayKey(new Date(r.last)) === day; }
  const mode = kind === 'article' ? 'read' : 'scene';
  return s.calls.some((c) => c.mode === mode && c.ref === id && store.dayKey(new Date(c.at)) === day);
}

export function picksSection() {
  const slots = slotsToday();
  if (!slots.length) return '';
  if (!cat) {
    if (!catError) loadCatalog();
    return `<h2 class="section-title">Today's picks</h2>
      <div class="card"><p class="muted">${catError ? 'Could not load today\'s picks. They\'ll show once you\'re online.' : 'Choosing today\'s picks…'}</p>
      ${catError ? '<button class="btn btn-ghost" data-action="picks-retry">Try again</button>' : ''}</div>`;
  }
  const p = todaysPicks();
  const cards = slots.map((s) => pickCard(s, p)).filter(Boolean);
  if (!cards.length) return '';
  return `<h2 class="section-title">Today's picks</h2><div class="picks">${cards.join('')}</div>`;
}

function pickCard(slot, p) {
  const opts = p.slots[slot] || [];
  if (!opts.length) return '';
  const i = (p.idx?.[slot] || 0) % opts.length;
  const { key, reason } = opts[i];
  const it = byKey(key);
  if (!it) return '';
  const done = doneToday(key);
  const hasKey = !!store.getApiKey();
  let go;
  if (it.kind === 'clip') go = `<a class="btn btn-primary" href="#/listen/${esc(it.id)}">Listen</a>`;
  else if (it.kind === 'article') go = `<a class="btn btn-primary" href="#/read/${esc(it.id)}">Read</a>`;
  else go = hasKey ? `<button class="btn btn-primary" data-action="call-scene" data-id="${esc(it.id)}">Start call</button>` : '<a class="btn btn-primary" href="#/speak">Open</a>';
  const meta = SLOT[slot];
  return `<article class="card pick ${done ? 'done' : ''}" data-slot="${slot}">
    <p class="muted small">${meta.icon} ${meta.label} · ${esc(it.level)}${it.sub ? ` · ${esc(it.sub)}` : ''}</p>
    <strong lang="it">${it.icon ? `${esc(it.icon)} ` : ''}${esc(it.title)}</strong>
    <p class="small pick-reason">${done ? 'Done today ✓' : esc(reason)}</p>
    <div class="row">
      ${done ? '' : go}
      ${opts.length > 1 ? `<button class="btn btn-ghost" data-action="${done ? 'pick-next' : 'pick-skip'}" data-slot="${slot}">${done ? 'Another one' : 'Something else'}</button>` : ''}
    </div>
  </article>`;
}

function advance(slot, skipped) {
  const p = store.get().picks;
  if (!p?.slots?.[slot]) return;
  const opts = p.slots[slot], i = (p.idx[slot] || 0) % opts.length;
  if (skipped) {
    const it = byKey(opts[i].key);
    if (it) store.logEvent({ item: it.key, topics: it.topics, type: 'skip', w: -0.15 });
  }
  store.setPicks({ ...p, idx: { ...p.idx, [slot]: i + 1 } });
  H.render();
}

// ---------- "How was it?" ----------
/** item = { key, topics, d, skill } */
export function ratingCard(item) {
  if (!item?.key) return '';
  const cur = store.recentRating(item.key);
  const chip = (action, value, label) => `<button type="button" class="chip ${cur[action === 'rate' ? 'rate' : 'level'] === value ? 'on' : ''}" data-action="${action}" data-value="${value}">${label}</button>`;
  return `<div class="card rate-card" data-item="${esc(item.key)}" data-topics="${esc((item.topics || []).join(','))}" data-d="${Number(item.d) || 0}" data-skill="${esc(item.skill || '')}">
    <h3>How was it?</h3>
    <div class="row chips" role="group" aria-label="Did you like it">
      ${chip('rate', 'up', '👍 Liked it')}${chip('rate', 'meh', '😐 OK')}${chip('rate', 'down', '👎 Not for me')}
    </div>
    <div class="row chips" role="group" aria-label="Difficulty">
      ${chip('rate-level', 'easy', 'Too easy')}${chip('rate-level', 'right', 'Just right')}${chip('rate-level', 'hard', 'Too hard')}
    </div>
    <p class="muted small">Your answers steer what Today suggests. Liking a topic and finding it hard are kept apart.</p>
  </div>`;
}

function rate(btn) {
  const card = btn.closest('.rate-card');
  if (!card) return;
  const { item, topics, d, skill } = card.dataset;
  const value = btn.dataset.value;
  const base = { item, topics: topics ? topics.split(',') : [], value };
  if (btn.dataset.action === 'rate') store.logEvent({ ...base, type: 'rate', w: rec.RATE_W[value] });
  else store.logEvent({ ...base, type: 'rate-level', skill, d: Number(d), perf: rec.LEVEL_PERF[value] });
  card.querySelectorAll(`[data-action="${btn.dataset.action}"]`).forEach((b) => b.classList.toggle('on', b === btn));
  H.toast('Thanks, noted.');
}

// ---------- Progress: what the app has learned ----------
export function learnedCard() {
  const events = store.get().events;
  const prof = rec.interestProfile(events);
  // Only topics the app knows (generated content could carry others).
  const topics = Object.entries(prof).filter(([t, x]) => Object.hasOwn(rec.TOPICS, t) && x.n >= 0.3).sort((a, b) => b[1].mean - a[1].mean);
  const lv = rec.levels(events);
  return `<div class="card">
    <h3>What the app has learned</h3>
    <p class="muted small">Your picks on Today come from this. It updates as you rate things, finish them or skip them.</p>
    ${topics.length ? topics.map(([t, x]) => `
      <div class="skill-row">
        <span>${esc(rec.topicLabel(t))}</span>
        <div class="bar"><span style="width:${Math.round(x.mean * 100)}%"></span></div>
        <span class="muted">${x.mean > 0.65 ? 'likes' : x.mean < 0.4 ? 'less' : 'neutral'}</span>
      </div>`).join('') : '<p class="muted">Nothing yet. Rate a few clips, articles or calls and this fills up.</p>'}
    <p class="small">Estimated level: listening ${rec.levelLabel(lv.listen)} · reading ${rec.levelLabel(lv.read)} · speaking ${rec.levelLabel(lv.speak)}</p>
  </div>`;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;
  if (a === 'rate' || a === 'rate-level') rate(btn);
  else if (a === 'pick-skip') advance(btn.dataset.slot, true);
  else if (a === 'pick-next') advance(btn.dataset.slot, false);
  else if (a === 'picks-retry') { catError = false; loadCatalog(); H.render(); }
});
window.addEventListener('online', () => { if (catError) { catError = false; loadCatalog(); } });
