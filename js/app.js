import * as store from './store.js';
import { SKILLS } from './store.js';
import { lang } from './languages.js';
import * as coachViews from './coachviews.js';
import * as listen from './listen.js';
import * as review from './review.js';

const L = () => lang(store.get().settings.language);

const view = document.getElementById('view');
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const mins = (s) => Math.floor(s / 60);

function greeting() {
  const h = new Date().getHours();
  const g = L().greetings;
  if (h < 12) return g.morning;
  if (h < 18) return g.afternoon;
  return g.evening;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3200);
}

function ring(pct, size = 132, stroke = 12) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - Math.min(1, pct));
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg" stroke-width="${stroke}" fill="none"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-width="${stroke}" fill="none"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="round"/>
  </svg>`;
}

// ---------- block card (used on Today and section pages) ----------
function blockCard(skill, { compact = false } = {}) {
  const s = store.get();
  const plan = store.planFor();
  const goal = plan[skill] * 60;
  const done = store.daySeconds()[skill];
  const running = s.timer?.skill === skill;
  const bonus = goal === 0;
  const pct = goal ? Math.min(1, done / goal) : 0;
  const finished = !bonus && done >= goal;
  const meta = SKILLS[skill];
  return `<article class="block ${running ? 'running' : ''} ${finished ? 'finished' : ''}" data-skill="${skill}">
    <div class="block-head">
      <span class="block-ico" aria-hidden="true">${meta.icon}</span>
      <div class="block-title">
        <strong>${meta.label}</strong>${bonus ? '<span class="muted">Bonus, no daily goal</span>' : ''}
      </div>
      <span class="block-time" data-live="${skill}">${mmss(Math.min(done, 359999))}</span>
      ${bonus ? '' : `<span class="muted block-goal">/ ${plan[skill]} min</span>`}
    </div>
    ${bonus ? '' : `<div class="bar"><span style="width:${pct * 100}%"></span></div>`}
    <div class="block-actions">
      <button class="btn ${running ? 'btn-ghost' : 'btn-primary'}" data-action="${running ? 'pause' : 'start'}" data-skill="${skill}">
        ${running ? 'Pause' : finished ? 'Keep going' : done ? 'Resume' : 'Start'}
      </button>
      ${compact ? '' : `<a class="btn btn-ghost" href="${meta.route}">Open</a>`}
      ${finished ? '<span class="badge">Done ✓</span>' : ''}
    </div>
  </article>`;
}

// ---------- views ----------
function viewToday() {
  const s = store.get();
  const d = store.daySeconds();
  const total = store.totalSeconds(d);
  const target = store.targetMinutes() * 60;
  const streak = store.streak();
  const pct = target ? total / target : 0;
  const plan = store.planFor();
  const order = Object.keys(SKILLS).filter((k) => plan[k] > 0);
  const bonus = Object.keys(SKILLS).filter((k) => !(plan[k] > 0));
  const next = order.find((k) => d[k] < plan[k] * 60);

  return `
  <section class="hero">
    <div class="hero-text">
      <p class="eyebrow">${new Date().toLocaleDateString(L().locale, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <h1>${greeting()}!</h1>
      <p class="muted">${total >= target
        ? `${L().goalDone} Today's goal is done. Anything extra is a bonus.`
        : next ? `Next up: <strong>${SKILLS[next].label.toLowerCase()}</strong>. ${mins(target - total)} min to go.` : ''}</p>
      <p class="streak" title="Days in a row with your full daily goal">🔥 <strong>${streak}</strong> day${streak === 1 ? '' : 's'} in a row</p>
    </div>
    <div class="hero-ring">
      ${ring(pct)}
      <div class="ring-label"><strong data-live="total">${mins(total)}</strong><span>/ ${mins(target)} min</span></div>
    </div>
  </section>

  <h2 class="section-title">Today's session</h2>
  <div class="blocks">${order.map((k) => blockCard(k)).join('')}</div>
  ${bonus.length ? `<h2 class="section-title">Extra</h2><div class="blocks">${bonus.map((k) => blockCard(k)).join('')}</div>` : ''}

  ${weekStrip()}
  `;
}

function weekStrip() {
  const days = [];
  const d = new Date();
  d.setDate(d.getDate() - 6);
  for (let i = 0; i < 7; i++) {
    const key = store.dayKey(d);
    const target = store.targetMinutes(key) * 60;
    const t = store.totalSeconds(store.daySeconds(key));
    days.push({ key, label: d.toLocaleDateString('en-GB', { weekday: 'narrow' }), pct: target ? Math.min(1, t / target) : 0, min: mins(t), today: i === 6 });
    d.setDate(d.getDate() + 1);
  }
  return `<h2 class="section-title">This week</h2>
  <div class="week card">${days.map((x) => `
    <div class="week-day ${x.today ? 'today' : ''} ${x.pct >= 1 ? 'met' : ''}" title="${x.key}: ${x.min} min">
      <div class="week-bar"><span style="height:${Math.max(x.pct * 100, x.min ? 6 : 0)}%"></span></div>
      <span>${x.label}</span>
    </div>`).join('')}
  </div>`;
}

function sectionPage(skill, intro, comingSoon, interim) {
  return `
  <section class="page-head">
    <p class="eyebrow">${L().name}</p>
    <h1>${SKILLS[skill].icon} ${SKILLS[skill].label}</h1>
    <p class="muted">${intro}</p>
  </section>
  ${blockCard(skill, { compact: true })}
  <div class="card">
    <h3>For now</h3>
    ${interim}
  </div>
  <div class="card soon">
    <h3>Coming next</h3>
    <ul>${comingSoon.map((x) => `<li>${x}</li>`).join('')}</ul>
  </div>`;
}

function viewProgress() {
  const s = store.get();
  const keys = Object.keys(s.days);
  const totals = Object.fromEntries(Object.keys(SKILLS).map((k) => [k, 0]));
  keys.forEach((k) => { const d = store.daySeconds(k); for (const sk in totals) totals[sk] += d[sk] || 0; });
  const today = store.daySeconds();
  if (!s.days[store.dayKey()]) for (const sk in totals) totals[sk] += today[sk];
  const all = store.totalSeconds(totals);
  const daysPracticed = new Set([...keys.filter((k) => store.totalSeconds(store.daySeconds(k)) > 0)]).size;

  // 12-week heatmap, Monday-first columns
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - 7 * 12 + 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday
  const cells = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = store.dayKey(d);
    const target = store.targetMinutes(key) * 60;
    const t = store.totalSeconds(store.daySeconds(key));
    const lvl = t === 0 ? 0 : t >= target ? 4 : t >= target * 0.66 ? 3 : t >= target * 0.33 ? 2 : 1;
    cells.push(`<span class="hm l${lvl}" title="${key}: ${mins(t)} min"></span>`);
  }

  const max = Math.max(1, ...Object.values(totals));
  return `
  <section class="page-head">
    <p class="eyebrow">${L().name}</p>
    <h1>📈 Progress</h1>
  </section>
  <div class="stats">
    <div class="stat card"><strong>${store.streak()}</strong><span>current streak</span></div>
    <div class="stat card"><strong>${store.bestStreak()}</strong><span>best streak</span></div>
    <div class="stat card"><strong>${(all / 3600).toFixed(1)}</strong><span>hours total</span></div>
    <div class="stat card"><strong>${daysPracticed}</strong><span>days practised</span></div>
  </div>
  <div class="card">
    <h3>Last 12 weeks</h3>
    <div class="heatmap">${cells.join('')}</div>
    <p class="legend muted"><span class="hm l0"></span> none <span class="hm l2"></span> some <span class="hm l4"></span> full goal</p>
  </div>
  ${review.trendsCard()}
  ${coachViews.usageCard()}
  <div class="card">
    <h3>Time per skill</h3>
    ${Object.keys(SKILLS).map((k) => `
      <div class="skill-row">
        <span>${SKILLS[k].icon} ${SKILLS[k].label}</span>
        <div class="bar"><span style="width:${(totals[k] / max) * 100}%"></span></div>
        <span class="muted">${(totals[k] / 3600).toFixed(1)} h</span>
      </div>`).join('')}
  </div>`;
}

function viewSettings() {
  const p = store.get().settings.plan;
  return `
  <section class="page-head">
    <p class="eyebrow">Lang Hub</p>
    <h1>⚙ Settings</h1>
  </section>
  <form class="card" id="plan-form">
    <h3>Daily routine</h3>
    <p class="muted">Minutes per skill each day. Your streak counts days where you reach the total. Set a skill to 0 to keep it as an extra without a goal.</p>
    ${store.BASE_SKILLS.map((k) => `
      <label class="field">
        <span>${SKILLS[k].icon} ${SKILLS[k].label}</span>
        <input type="number" name="${k}" min="0" max="180" step="1" value="${p[k]}" inputmode="numeric">
        <span class="muted">min</span>
      </label>`).join('')}
    <p class="muted">Total: <strong id="plan-total">${store.BASE_SKILLS.reduce((a, k) => a + (p[k] || 0), 0)}</strong> min a day</p>
    <h3>Reading days</h3>
    <p class="muted">On these days, Read + discuss takes the speaking slot.</p>
    <div class="days">${[1, 2, 3, 4, 5, 6, 0].map((n) => `
      <label class="day-chip"><input type="checkbox" name="readDay" value="${n}" ${store.get().settings.readDays.includes(n) ? 'checked' : ''}>
      <span>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n]}</span></label>`).join('')}
    </div>
    <button class="btn btn-primary" type="submit">Save</button>
  </form>
  ${coachViews.settingsCard()}
  <div class="card">
    <h3>Backup</h3>
    <p class="muted">Your progress is stored only on this device. Export it now and then, or to move to another device.</p>
    <div class="row">
      <button class="btn btn-ghost" data-action="export">Export</button>
      <label class="btn btn-ghost">Import<input type="file" accept="application/json,.json" id="import-file" hidden></label>
    </div>
  </div>
  <div class="card">
    <h3>Add time manually</h3>
    <p class="muted">Practised without the app, for example during your lesson with your tutor? Log it here for today.</p>
    <form class="row" id="manual-form">
      <select name="skill">${Object.keys(SKILLS).map((k) => `<option value="${k}">${SKILLS[k].label}</option>`).join('')}</select>
      <input type="number" name="minutes" min="1" max="240" value="60" inputmode="numeric" aria-label="Minutes">
      <button class="btn btn-primary" type="submit">Add</button>
    </form>
  </div>
  <div class="card danger">
    <h3>Reset</h3>
    <button class="btn btn-danger" data-action="reset">Delete all progress</button>
  </div>
  <p class="muted center small">Lang Hub · all 4 steps</p>`;
}

// ---------- router ----------
const routes = {
  today: viewToday, listen: listen.viewListen, progress: viewProgress, settings: viewSettings,
  speak: coachViews.viewSpeak, read: coachViews.viewRead, review: coachViews.viewReview,
  cards: coachViews.viewCards, call: coachViews.viewCall, recap: coachViews.viewRecap,
  drill: review.viewDrill, report: review.viewReport,
};
const TAB_OF = { cards: 'speak', call: null, recap: null, drill: 'review', report: 'progress' };

function currentRoute() {
  const [r, ...params] = (location.hash.replace(/^#\/?/, '') || 'today').split('?')[0].split('/');
  return routes[r] ? { r, params } : { r: 'today', params: [] };
}

function render() {
  const { r, params } = currentRoute();
  document.getElementById('lang-name').textContent = L().native;
  view.innerHTML = routes[r](...params);
  const tab = r in TAB_OF ? TAB_OF[r] : r;
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  document.body.classList.toggle('in-call', r === 'call');
  bindView(r);
  coachViews.bind(r, params);
  listen.bind(r, params);
  review.bind(r, params);
}
coachViews.init({ render, toast, blockCard, sectionPage, L, esc, mmss });
listen.init({ render, toast, blockCard, L, esc, mmss });
review.init({ render, toast, L, esc });
coachViews.setReview(review);

window.addEventListener('hashchange', () => { render(); view.focus({ preventScroll: true }); window.scrollTo(0, 0); });

// ---------- events ----------
view.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, skill } = btn.dataset;
  if (action === 'start') { store.startTimer(skill); render(); }
  else if (action === 'pause') { store.stopTimer(); render(); }
  else if (action === 'export') {
    const blob = new Blob([store.exportData()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lang-hub-backup-${store.dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } else if (action === 'reset') {
    if (btn.dataset.confirm) { store.resetAll(); toast('All progress deleted.'); render(); }
    else { btn.dataset.confirm = '1'; btn.textContent = 'Tap again to confirm'; }
  }
});

function bindView(r) {
  if (r === 'progress') coachViews.fillUsage();
  if (r !== 'settings') return;
  const form = $('#plan-form');
  form.addEventListener('input', () => {
    const t = [...form.querySelectorAll('input[type=number]')].reduce((a, i) => a + (parseInt(i.value, 10) || 0), 0);
    $('#plan-total').textContent = t;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const plan = {};
    form.querySelectorAll('input[type=number]').forEach((i) => { plan[i.name] = Math.max(0, Math.min(180, parseInt(i.value, 10) || 0)); });
    const readDays = [...form.querySelectorAll('input[name=readDay]:checked')].map((i) => Number(i.value));
    store.setPlan(plan, readDays);
    toast('Routine saved.');
  });
  $('#manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const m = Math.max(1, Math.min(240, parseInt(f.get('minutes'), 10) || 0));
    store.addSeconds(store.dayKey(), f.get('skill'), m * 60);
    toast(`Added ${m} min of ${SKILLS[f.get('skill')].label.toLowerCase()}.`);
  });
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { store.importData(await file.text()); toast('Backup imported.'); render(); }
    catch (err) { toast(err.message || 'Could not read that file.'); }
  });
}

// ---------- live ticking ----------
// Blocks already at their goal when the app opens don't trigger a celebration.
const celebrated = new Set();
function markCelebrated() {
  const plan = store.planFor(), d = store.daySeconds();
  for (const k in plan) if (plan[k] && d[k] >= plan[k] * 60) celebrated.add(`${store.dayKey()}:${k}`);
}
markCelebrated();

setInterval(() => {
  const s = store.get();
  if (!s.timer) return;
  const d = store.daySeconds();
  const sk = s.timer.skill;
  document.querySelectorAll(`[data-live="${sk}"]`).forEach((el) => { el.textContent = mmss(d[sk]); });
  const totalEl = document.querySelector('[data-live="total"]');
  if (totalEl) totalEl.textContent = mins(store.totalSeconds(d));
  const goal = store.planFor()[sk] * 60;
  // Re-render once when a block hits its goal, and nudge the user.
  const id = `${store.dayKey()}:${sk}`;
  if (goal && d[sk] >= goal && !celebrated.has(id)) {
    celebrated.add(id);
    toast(`${SKILLS[sk].label}: ${goal / 60} min done! 🎉`);
    try { navigator.vibrate?.([120, 60, 120]); } catch (e) { /* ignore */ }
    render();
  }
}, 1000);

// Re-render when returning to the app (e.g. the next day, or after the phone slept).
document.addEventListener('visibilitychange', () => { if (!document.hidden) { markCelebrated(); render(); } });

render();

// ---------- service worker ----------
// A new version waits until the user taps "Reload". The page never reloads by
// itself during a live call: the reload waits until the call screen is closed.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const sw = navigator.serviceWorker;
  const inCall = () => document.body.classList.contains('in-call');
  let reg = null, wantReload = false, reloading = false, lastCheck = Date.now();

  const reloadWhenFree = () => {
    if (reloading) return;
    if (!inCall()) { reloading = true; location.reload(); return; }
    // Wait for the call screen to close (app.js toggles body.in-call per route).
    const mo = new MutationObserver(() => { if (!inCall()) { mo.disconnect(); reloadWhenFree(); } });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  };

  const showUpdate = () => {
    let bar = document.getElementById('update-banner');
    if (bar) return;
    bar = document.createElement('div');
    bar.id = 'update-banner';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>New version</span><button type="button" class="btn btn-primary">Reload</button>';
    bar.querySelector('button').addEventListener('click', () => {
      wantReload = true;
      bar.remove();
      if (reg?.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      else reloadWhenFree(); // already active (e.g. another tab took the update)
    });
    document.body.appendChild(bar);
  };

  const hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install: nothing to reload
    if (wantReload) reloadWhenFree();
    else showUpdate(); // updated from another tab: offer the reload here too
  });

  sw.register('sw.js').then((r) => {
    reg = r;
    if (reg.waiting && sw.controller) showUpdate();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && sw.controller) showUpdate(); });
    });
  }).catch(() => { /* offline support unavailable */ });

  // Look for a new version when the app comes back to the foreground, at most once an hour.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !reg || Date.now() - lastCheck < 3600e3) return;
    lastCheck = Date.now();
    reg.update().catch(() => { /* offline */ });
  });
}
