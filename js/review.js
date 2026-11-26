// Step 4: spaced repetition drills from the mistake log, mistake trends,
// and a shareable progress report for the tutor.
import * as store from './store.js';
import { SKILLS } from './store.js';

let H = {};
export function init(helpers) { H = helpers; }
const esc = (s) => H.esc(s);
const DAY = 864e5;

export const CATEGORY = {
  'verb tense': { label: 'Verb tenses', it: 'tempi verbali' },
  agreement: { label: 'Agreement (gender/number)', it: 'concordanza' },
  prepositions: { label: 'Prepositions', it: 'preposizioni' },
  articles: { label: 'Articles', it: 'articoli' },
  pronouns: { label: 'Pronouns', it: 'pronomi' },
  subjunctive: { label: 'Subjunctive', it: 'congiuntivo' },
  'word choice': { label: 'Word choice', it: 'lessico' },
  'word order': { label: 'Word order', it: 'ordine delle parole' },
  other: { label: 'Other', it: 'altro' },
};
const catLabel = (c) => (CATEGORY[c] ? `${CATEGORY[c].label} · ${CATEGORY[c].it}` : c);

// ---------- scheduling (simple SM-2 style) ----------
const isDue = (m, now = Date.now()) => !m.srs || m.srs.due <= now;
export const dueCount = () => store.get().mistakes.filter((m) => isDue(m)).length;

function grade(m, g) { // g: 0 again, 1 hard, 2 good, 3 easy
  const s = m.srs || { interval: 0, ease: 2.5, reps: 0, lapses: 0, history: [] };
  if (g === 0) { s.lapses++; s.reps = 0; s.interval = 0; s.ease = Math.max(1.3, s.ease - 0.2); }
  else {
    s.reps++;
    s.interval = s.reps === 1 ? (g === 3 ? 3 : 1) : s.reps === 2 ? (g === 1 ? 3 : 6) : Math.round(s.interval * (g === 1 ? 1.2 : g === 3 ? s.ease * 1.3 : s.ease));
    s.ease = Math.max(1.3, s.ease + (g === 1 ? -0.15 : g === 3 ? 0.15 : 0));
  }
  // "Again" comes back in the same session (10 min), the rest after `interval` days.
  s.due = g === 0 ? Date.now() + 10 * 60e3 : Date.now() + s.interval * DAY;
  s.history = [...(s.history || []), { at: Date.now(), g }].slice(-30);
  m.srs = s;
  store.save();
}

// ---------- drill session ----------
let session = null; // { queue: [ids], idx, shown, typed, done, right, started }

export function viewDrill() {
  if (!session) {
    // One card per distinct mistake, so a slip made five times isn't drilled five times in a row.
    const seenKeys = new Set();
    const due = store.get().mistakes.filter((m) => isDue(m)).sort((a, b) => (a.srs?.due || a.at) - (b.srs?.due || b.at))
      .filter((m) => { const k = `${m.said}|${m.correct}`; if (seenKeys.has(k)) return false; seenKeys.add(k); return true; }).slice(0, 20);
    if (!due.length) return `<a class="back" href="#/review">‹ Review</a><div class="card"><h3>Nothing due right now</h3><p class="muted">All your mistakes are scheduled for later. Have a conversation to collect new ones.</p></div>`;
    session = { queue: due.map((m) => m.id), idx: 0, shown: false, typed: '', done: 0, right: 0, started: Date.now() };
    if (!store.get().timer) store.startTimer('review');
  }
  const m = store.get().mistakes.find((x) => x.id === session.queue[session.idx]);
  if (!m) return finishView();
  return `
  <a class="back" href="#/review" data-action="drill-quit">‹ Stop</a>
  <p class="muted small">Card ${session.idx + 1} of ${session.queue.length} · ${esc(catLabel(m.category))}</p>
  <div class="card drill">
    <p class="muted small">You said:</p>
    <p class="drill-said" lang="it">${esc(m.said)}</p>
    ${m.explanation && !session.shown ? `<details class="small"><summary>Hint</summary><p>${esc(m.explanation)}</p></details>` : ''}
    <p class="muted small">Say the correct version out loud, or type it:</p>
    <textarea id="drill-input" rows="2" lang="it" spellcheck="false" autocapitalize="off" ${session.shown ? 'disabled' : ''}>${esc(session.typed)}</textarea>
    ${session.shown ? `
      <p class="muted small">Correct:</p>
      <p class="drill-correct" lang="it">${esc(m.correct)}</p>
      ${m.explanation ? `<p class="muted small">${esc(m.explanation)}</p>` : ''}
      <p class="small"><strong>How did it go?</strong></p>
      <div class="grade-row">
        <button class="btn btn-danger" data-action="drill-grade" data-g="0">Again</button>
        <button class="btn btn-ghost" data-action="drill-grade" data-g="1">Hard</button>
        <button class="btn btn-primary" data-action="drill-grade" data-g="2">Good</button>
        <button class="btn btn-ghost" data-action="drill-grade" data-g="3">Easy</button>
      </div>`
      : '<button class="btn btn-primary" data-action="drill-show">Show answer</button>'}
  </div>`;
}

function finishView() {
  const s = session;
  session = null;
  if (store.get().timer?.skill === 'review') store.stopTimer();
  store.logDrill({ cards: s.done, right: s.right, seconds: Math.round((Date.now() - s.started) / 1000) });
  return `<section class="page-head"><p class="eyebrow">Review</p><h1>Fatto! 🎉</h1>
    <p class="muted">${s.done} card${s.done === 1 ? '' : 's'}, ${s.right} remembered well. Cards you found hard come back sooner.</p></section>
    <div class="row"><a class="btn btn-primary" href="#/today">Back to today</a><a class="btn btn-ghost" href="#/review">Review</a></div>`;
}

// ---------- analysis ----------
const weekStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };

/** Per category: mistakes per 10 minutes of coach conversation, per week. */
export function trends(weeks = 8) {
  const st = store.get();
  const now = weekStart(Date.now());
  const starts = Array.from({ length: weeks }, (_, i) => now - (weeks - 1 - i) * 7 * DAY);
  const talk = starts.map((w) => st.calls.filter((c) => c.at >= w && c.at < w + 7 * DAY).reduce((a, c) => a + c.seconds, 0) / 60);
  const cats = {};
  st.mistakes.forEach((m) => {
    if (m.source === 'manual') return;
    const i = starts.findIndex((w) => m.at >= w && m.at < w + 7 * DAY);
    if (i < 0) return;
    (cats[m.category] ||= Array(weeks).fill(0))[i]++;
  });
  return Object.entries(cats).map(([cat, counts]) => {
    const rate = counts.map((n, i) => (talk[i] >= 3 ? (n / talk[i]) * 10 : null));
    return { cat, counts, rate, total: counts.reduce((a, b) => a + b, 0) };
  }).sort((a, b) => b.total - a.total).map((x) => ({ ...x, talk, starts }));
}

/** Compare the rate in [from,to) with the period before it, for each category. */
export function periodStats(from, to) {
  const st = store.get();
  const len = to - from, pFrom = from - len;
  const talkMin = (a, b) => st.calls.filter((c) => c.at >= a && c.at < b).reduce((s, c) => s + c.seconds, 0) / 60;
  const cur = talkMin(from, to), prev = talkMin(pFrom, from);
  const count = (a, b) => { const o = {}; st.mistakes.forEach((m) => { if (m.at >= a && m.at < b) o[m.category] = (o[m.category] || 0) + 1; }); return o; };
  const c1 = count(from, to), c0 = count(pFrom, from);
  const cats = [...new Set([...Object.keys(c1), ...Object.keys(c0)])].map((cat) => {
    const r1 = cur >= 3 ? ((c1[cat] || 0) / cur) * 10 : null;
    const r0 = prev >= 3 ? ((c0[cat] || 0) / prev) * 10 : null;
    return { cat, n: c1[cat] || 0, rate: r1, prevRate: r0, change: r1 != null && r0 != null && r0 > 0 ? (r1 - r0) / r0 : null };
  }).sort((a, b) => b.n - a.n);
  // Drill recall per category in this period.
  const recall = {};
  st.mistakes.forEach((m) => (m.srs?.history || []).forEach((h) => {
    if (h.at < from || h.at >= to) return;
    const r = (recall[m.category] ||= { ok: 0, n: 0 }); r.n++; if (h.g >= 2) r.ok++;
  }));
  return { talkMin: cur, prevTalkMin: prev, cats, recall };
}

const arrow = (ch) => (ch == null ? '' : ch <= -0.15 ? `<span class="trend good">▼ ${Math.round(-ch * 100)}%</span>` : ch >= 0.15 ? `<span class="trend bad">▲ ${Math.round(ch * 100)}%</span>` : '<span class="trend">≈ steady</span>');
const arrowText = (ch) => (ch == null ? '' : ch <= -0.15 ? ` (down ${Math.round(-ch * 100)}%, improving)` : ch >= 0.15 ? ` (up ${Math.round(ch * 100)}%)` : ' (about the same)');

function sparkline(vals, w = 96, h = 26) {
  const pts = vals.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return `<svg width="${w}" height="${h}" aria-hidden="true"></svg>`;
  const max = Math.max(...pts.map(([, v]) => v), 0.1);
  const x = (i) => (i / (vals.length - 1)) * (w - 4) + 2, y = (v) => h - 2 - (v / max) * (h - 4);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>
    <circle cx="${x(pts.at(-1)[0])}" cy="${y(pts.at(-1)[1])}" r="2.5" fill="currentColor"/></svg>`;
}

/** Card for the Progress page. */
export function trendsCard() {
  const t = trends(8);
  if (!t.length) return `<div class="card"><h3>Mistake trends</h3><p class="muted">After a few conversations with ${H.L().coach.name} you'll see which mistakes you make most, and whether they're going down.</p></div>`;
  const now = Date.now(), p = periodStats(now - 14 * DAY, now);
  return `<div class="card">
    <h3>Mistake trends</h3>
    <p class="muted small">Mistakes per 10 minutes of conversation, week by week (last 8 weeks). Lower is better.</p>
    ${t.slice(0, 6).map((x) => {
      const pc = p.cats.find((c) => c.cat === x.cat);
      return `<div class="trend-row">
        <span>${esc(catLabel(x.cat))}<br><span class="muted small">${x.total} in 8 weeks</span></span>
        ${sparkline(x.rate)}
        <span class="small">${arrow(pc?.change)}</span>
      </div>`;
    }).join('')}
    <a class="btn btn-ghost" href="#/report">Report for your tutor</a>
  </div>`;
}

// ---------- tutor report ----------
let reportDays = 14;
function reportData() {
  const st = store.get();
  const to = Date.now(), from = to - reportDays * DAY;
  const p = periodStats(from, to);
  const time = Object.fromEntries(Object.keys(SKILLS).map((k) => [k, 0]));
  for (let t = from; t < to + DAY; t += DAY) { const d = st.days[store.dayKey(new Date(t))]; if (d) for (const k in time) time[k] += d[k] || 0; }
  const daysPractised = Object.keys(st.days).filter((k) => { const t = new Date(k).getTime(); return t >= from - DAY && t < to && store.totalSeconds(st.days[k]) > 0; }).length;
  const calls = st.calls.filter((c) => c.at >= from);
  const seen = new Map();
  st.mistakes.filter((m) => m.at >= from).forEach((m) => { const k = `${m.said}|${m.correct}`; seen.set(k, { ...(seen.get(k) || m), times: (seen.get(k)?.times || 0) + 1 }); });
  const examples = [...seen.values()].slice(0, 10);
  const listening = Object.entries(st.listening || {}).filter(([, r]) => r.last >= from);
  const drills = (st.drills || []).filter((d) => d.at >= from);
  const lastReport = (st.reports || []).at(-1);
  return { from, to, p, time, daysPractised, calls, examples, listening, drills, lastReport };
}

export function viewReport() {
  const r = reportData();
  const fmt = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const h = (s) => (s / 3600).toFixed(1);
  const totalH = h(store.totalSeconds(r.time));
  const drillN = r.drills.reduce((a, d) => a + d.cards, 0), drillOk = r.drills.reduce((a, d) => a + d.right, 0);
  return `
  <a class="back no-print" href="#/progress">‹ Progress</a>
  <div class="row chips no-print" role="group" aria-label="Period">${[[7, 'Last week'], [14, 'Last 2 weeks'], [30, 'Last month']].map(([d, l]) => `
    <button class="chip ${reportDays === d ? 'on' : ''}" data-action="report-days" data-days="${d}">${l}</button>`).join('')}</div>
  <article class="card report" id="report">
    <p class="eyebrow">Italian progress report</p>
    <h1>${fmt(r.from)} – ${fmt(r.to)}</h1>
    <h3>Practice</h3>
    <p>${totalH} hours over ${r.daysPractised} days: speaking ${h(r.time.speak)} h, listening ${h(r.time.listen)} h, reading ${h(r.time.read)} h, review ${h(r.time.review)} h.
    ${r.calls.length} conversation${r.calls.length === 1 ? '' : 's'} with an AI coach (${Math.round(r.p.talkMin)} min)${r.p.prevTalkMin ? `, compared with ${Math.round(r.p.prevTalkMin)} min the period before` : ''}.</p>
    ${r.calls.length ? `<p class="small muted">Topics: ${[...new Set(r.calls.map((c) => c.title))].slice(0, 8).map(esc).join(', ')}.</p>` : ''}
    <h3>Recurring mistakes</h3>
    ${r.p.cats.length ? `<table class="rtable"><thead><tr><th>Type</th><th>Count</th><th>Per 10 min</th><th>vs. before</th></tr></thead><tbody>
      ${r.p.cats.slice(0, 8).map((c) => `<tr><td>${esc(catLabel(c.cat))}</td><td>${c.n}</td><td>${c.rate == null ? '–' : c.rate.toFixed(1)}</td><td>${arrow(c.change) || '–'}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No mistakes logged in this period.</p>'}
    ${Object.keys(r.p.recall).length ? `<p class="small">Review drills: ${drillOk} of ${drillN} cards recalled well. ${Object.entries(r.p.recall).map(([c, x]) => `${esc(CATEGORY[c]?.it || c)} ${Math.round((x.ok / x.n) * 100)}%`).join(', ')}.</p>` : ''}
    ${r.examples.length ? `<h3>Examples</h3><ul class="examples">${r.examples.map((m) => `<li lang="it"><s>${esc(m.said)}</s> → <strong>${esc(m.correct)}</strong>${m.times > 1 ? ` <span class="muted small">(${m.times}×)</span>` : ''}</li>`).join('')}</ul>` : ''}
    ${r.listening.length ? `<h3>Listening</h3><p class="small">${r.listening.map(([id, x]) => `${esc(id)}: ${x.best}/3${x.dict != null ? `, dictation ${x.dict}%` : ''}`).join(' · ')}</p>` : ''}
    ${r.lastReport ? `<p class="muted small">Previous report: ${fmt(r.lastReport.at)}.</p>` : ''}
    <p class="muted small">Mistakes are noted automatically by the AI coach during conversations; "per 10 min" makes weeks with more or less talking comparable.</p>
  </article>
  <div class="row no-print">
    <button class="btn btn-primary" data-action="report-share">Share</button>
    <button class="btn btn-ghost" data-action="report-copy">Copy text</button>
    <button class="btn btn-ghost" data-action="report-print">Save as PDF</button>
  </div>`;
}

function reportText() {
  const r = reportData();
  const fmt = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const h = (s) => (s / 3600).toFixed(1);
  const lines = [
    `Italian progress report, ${fmt(r.from)} – ${fmt(r.to)}`,
    '',
    `Practice: ${h(store.totalSeconds(r.time))} h over ${r.daysPractised} days (speaking ${h(r.time.speak)} h, listening ${h(r.time.listen)} h, reading ${h(r.time.read)} h, review ${h(r.time.review)} h).`,
    `${r.calls.length} conversations with an AI coach, ${Math.round(r.p.talkMin)} min in total.`,
    '',
    'Recurring mistakes (count, per 10 min of conversation):',
    ...r.p.cats.slice(0, 8).map((c) => `- ${catLabel(c.cat)}: ${c.n}${c.rate != null ? `, ${c.rate.toFixed(1)} per 10 min` : ''}${arrowText(c.change)}`),
    '',
    'Examples:',
    ...r.examples.map((m) => `- ${m.said} → ${m.correct}${m.times > 1 ? ` (${m.times}×)` : ''}`),
  ];
  return lines.join('\n');
}

function snapshot() {
  const st = store.get();
  const r = reportData();
  st.reports = [...(st.reports || []), { at: Date.now(), days: reportDays, cats: Object.fromEntries(r.p.cats.map((c) => [c.cat, c.rate])) }].slice(-50);
  store.save();
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;
  if (a === 'drill-show' && session) {
    session.typed = document.getElementById('drill-input')?.value || '';
    session.shown = true; H.render();
  } else if (a === 'drill-grade' && session) {
    const g = Number(btn.dataset.g);
    const m = store.get().mistakes.find((x) => x.id === session.queue[session.idx]);
    if (m) {
      grade(m, g);
      session.done++; if (g >= 2) session.right++;
      if (g === 0 && session.queue.filter((id) => id === m.id).length < 3) session.queue.push(m.id); // see it again this session
    }
    session.idx++; session.shown = false; session.typed = '';
    H.render(); window.scrollTo(0, 0);
  } else if (a === 'drill-quit') {
    if (session) { const s = session; session = null; if (store.get().timer?.skill === 'review') store.stopTimer(); if (s.done) store.logDrill({ cards: s.done, right: s.right, seconds: Math.round((Date.now() - s.started) / 1000) }); }
  } else if (a === 'report-days') {
    reportDays = Number(btn.dataset.days); H.render();
  } else if (a === 'report-share') {
    snapshot();
    const text = reportText();
    if (navigator.share) { try { await navigator.share({ title: 'Italian progress report', text }); } catch (err) { /* cancelled */ } }
    else { await copy(text); }
  } else if (a === 'report-copy') {
    snapshot(); await copy(reportText());
  } else if (a === 'report-print') {
    snapshot(); window.print();
  }
});

async function copy(text) {
  try { await navigator.clipboard.writeText(text); H.toast('Report copied. Paste it in a message to your tutor.'); }
  catch (e) { H.toast('Could not copy. Use Save as PDF instead.'); }
}

export function bind(r) {
  if (r !== 'drill' && session && !location.hash.startsWith('#/drill')) {
    // left the drill some other way: keep progress, stop the timer
    if (store.get().timer?.skill === 'review') store.stopTimer();
    session = null;
  }
  if (r === 'drill') document.getElementById('drill-input')?.addEventListener('input', (e) => { if (session) session.typed = e.target.value; });
}
