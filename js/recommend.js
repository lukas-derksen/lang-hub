// Personalised picks: what to practise next, based on what you engaged with.
// Pure functions (no DOM, no storage), so they can be tested in Node.
//
// Inputs are engagement events stored on the device (see store.logEvent):
//   { at, item: 'clip:mercato', topics: ['food'], type, w?, skill?, d?, perf? }
// - w (-1..1): how much this says you liked the item's topics (interest).
// - skill + d + perf (0..1): how well you managed an item of difficulty d (level).
// Interest and level are kept apart on purpose: a topic you love shouldn't be
// dropped because one clip on it was too fast.

export const TOPICS = {
  food: 'food', travel: 'travel', work: 'work', society: 'society', culture: 'culture',
  health: 'health', home: 'home and neighbours', city: 'city life', services: 'errands and services',
  personal: 'your own life', leisure: 'free time', everyday: 'everyday life', tech: 'technology',
};
export const topicLabel = (t) => TOPICS[t] || t;

// Practical domains you need in Italy, whatever your scores say: each one comes
// up at least every MUST_COVER_DAYS when there is content for it.
export const MUST_COVER = ['health', 'services', 'travel', 'home'];
export const MUST_COVER_DAYS = 14;

const DAY = 864e5;
export const HALF_LIFE_DAYS = 21;
// Share of picks that deliberately try a topic you have little data on.
export const EXPLORE_RATE = 0.25;

// CEFR labels on a number line, so "slightly above your level" can be computed.
const CEFR = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
export function levelNum(label) {
  const parts = String(label || '').toUpperCase().match(/[ABC][12]/g);
  if (!parts) return 3;
  const n = parts.map((p) => CEFR[p]);
  return n.reduce((a, b) => a + b, 0) / n.length;
}
export function levelLabel(n) {
  const names = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const lo = Math.max(1, Math.min(6, Math.floor(n + 0.25)));
  const frac = n - lo;
  if (frac >= 0.25 && lo < 6) return `${names[lo - 1]}–${names[lo]}`;
  return names[lo - 1];
}

/** Weight of an event that happened `ageMs` ago: halves every HALF_LIFE_DAYS. */
export const decay = (ageMs) => 0.5 ** (Math.max(0, ageMs) / (HALF_LIFE_DAYS * DAY));

// Starting levels (B1 overall; listening a bit lower, reading a bit higher).
export const START_LEVELS = { listen: 2.75, read: 3.25, speak: 2.75 };

/**
 * Interest per topic as a Beta(a, b) belief: a collects positive signals, b
 * negative ones, both fading with age. mean = a / (a + b); n = how much data.
 */
export function interestProfile(events, now = Date.now()) {
  const p = {};
  for (const e of events) {
    if (!e?.w || !Array.isArray(e.topics)) continue;
    const f = decay(now - e.at);
    for (const t of e.topics) {
      const x = (p[t] ||= { a: 1, b: 1, n: 0, last: 0 });
      if (e.w > 0) x.a += e.w * f; else x.b += -e.w * f;
      x.n += Math.abs(e.w) * f;
      x.last = Math.max(x.last, e.at);
    }
  }
  for (const t in p) p[t].mean = p[t].a / (p[t].a + p[t].b);
  return p;
}

/**
 * Level per skill. After each item, the level moves toward what your result
 * says: doing well on hard items raises it, struggling on easy ones lowers it.
 * Expected result at difficulty d for level L: about 73% when d == L.
 */
export function levels(events) {
  const L = { ...START_LEVELS };
  const sorted = events.filter((e) => e && e.skill in L && Number.isFinite(e.d) && Number.isFinite(e.perf)).sort((a, b) => a.at - b.at);
  for (const e of sorted) {
    const expected = 1 / (1 + Math.exp(-2 * (L[e.skill] + 0.5 - e.d)));
    L[e.skill] = Math.max(1.5, Math.min(5.5, L[e.skill] + 0.4 * (e.perf - expected)));
  }
  return L;
}

// ---- random numbers (seeded, so a day's picks are stable) ----
export function rng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function gamma(k, r) {
  if (k < 1) return gamma(k + 1, r) * r() ** (1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = gauss(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
/** A random draw from Beta(a, b) (Thompson sampling). */
export function betaSample(a, b, r) { const x = gamma(a, r), y = gamma(b, r); return x / (x + y); }

/**
 * History per item from events: { lastAt, perf (last result), done }.
 * Extra entries (e.g. from older data such as clip scores) can be merged in by the caller.
 */
export function history(events) {
  const h = {};
  for (const e of events) {
    if (!e?.item || e.type === 'skip') continue;
    const x = (h[e.item] ||= { lastAt: 0, perf: null });
    if (e.at >= x.lastAt) { x.lastAt = e.at; if (Number.isFinite(e.perf)) x.perf = e.perf; }
  }
  return h;
}

/** Topics you rated 👍 in the last `days` days (for "topic weeks", narrow input). */
export function hotTopics(events, now = Date.now(), days = 3) {
  const s = new Set();
  for (const e of events) if (e?.type === 'rate' && e.w > 0.5 && now - e.at < days * DAY) (e.topics || []).forEach((t) => s.add(t));
  return s;
}

/** Last time each topic came up in anything you did. */
function topicLastSeen(events) {
  const m = {};
  for (const e of events) if (e?.type !== 'skip') for (const t of e?.topics || []) m[t] = Math.max(m[t] || 0, e.at);
  return m;
}

/**
 * Rank items for one slot and explain the top ones.
 * items: [{ key, title, topics, d }]; skill: 'listen' | 'read' | 'speak'.
 * Returns up to `count` [{ key, reason }], best first.
 */
export function pick(items, { events = [], skill, now = Date.now(), seed = 'x', count = 3, extraHistory = {} } = {}) {
  if (!items.length) return [];
  const r = rng(`${seed}:${skill}`);
  const prof = interestProfile(events, now);
  const lv = levels(events)[skill] ?? 3;
  const hist = { ...extraHistory, ...history(events) };
  const hot = hotTopics(events, now);
  const seen = topicLastSeen(events);
  const target = lv + 0.25; // slightly above your level

  const scored = items.map((it) => {
    const topics = it.topics?.length ? it.topics : ['other'];
    const interest = topics.reduce((a, t) => { const x = prof[t] || { a: 1, b: 1 }; return a + betaSample(x.a, x.b, r); }, 0) / topics.length;
    const fit = Math.exp(-((it.d - target) ** 2) / (2 * 0.6 ** 2));
    const h = hist[it.key];
    let fresh = 1, retry = false;
    if (h?.lastAt) {
      const age = now - h.lastAt;
      if (age < 2 * DAY) fresh = 0.02;
      else if (h.perf != null && h.perf < 0.7) { fresh = 0.8; retry = true; } // spaced retry of something hard
      else fresh = age < 14 * DAY ? 0.1 : 0.3;
    }
    const due = topics.find((t) => MUST_COVER.includes(t) && now - (seen[t] || 0) > MUST_COVER_DAYS * DAY);
    const hotT = topics.find((t) => hot.has(t));
    const liked = topics.filter((t) => prof[t] && prof[t].n >= 0.5).sort((a, b) => prof[b].mean - prof[a].mean)[0];
    const novelty = topics.reduce((a, t) => a + (prof[t]?.n || 0), 0) / topics.length;
    const score = interest * fit * fresh * (due && !h ? 1.5 : due ? 1.2 : 1) * (hotT ? 1.4 : 1);
    return { it, topics, score, fit, fresh, retry, due, dueSeen: !!(due && seen[due]), hotT, liked, novelty, h };
  });

  scored.sort((a, b) => b.score - a.score);
  const out = [];
  // Exploration: sometimes lead with the least-known topic that still fits your level.
  if (r() < EXPLORE_RATE) {
    const pool = scored.filter((s) => s.fresh >= 0.3 && s.fit > 0.4).sort((a, b) => a.novelty - b.novelty || b.fit - a.fit);
    if (pool[0] && pool[0].novelty < 1) out.push({ ...pool[0], explore: true });
  }
  for (const s of scored) { if (out.length >= count) break; if (!out.some((o) => o.it.key === s.it.key)) out.push(s); }
  return out.map((s) => ({ key: s.it.key, reason: reason(s, prof, now) }));
}

function reason(s, prof, now) {
  const L = topicLabel;
  if (s.retry) return 'You found this one hard last time. Worth another go';
  if (s.due) return s.dueSeen ? `${L(s.due)[0].toUpperCase()}${L(s.due).slice(1)} hasn't come up for two weeks` : `Practical for Italy: ${L(s.due)}`;
  if (s.explore) return `Something new: ${L(s.topics[0])}`;
  if (s.hotT) return `Staying with ${L(s.hotT)} for a few days`;
  if (s.liked && prof[s.liked].mean > 0.6) return `Because you enjoy ${L(s.liked)}`;
  if (!s.h) return `New for you · ${L(s.topics[0])}`;
  return 'A good fit for your level';
}

/**
 * Weighted shuffle for conversation cards: topics you enjoy come up a bit more,
 * others still appear (weights 0.5 to 1.5).
 */
export function weightedOrder(items, events, r = Math.random, now = Date.now()) {
  const prof = interestProfile(events, now);
  return items
    .map((it) => {
      const t = it.topics || [];
      const m = t.length ? t.reduce((a, x) => a + (prof[x]?.mean ?? 0.5), 0) / t.length : 0.5;
      return { it, k: r() ** (1 / (0.5 + m)) }; // Efraimidis–Spirakis weighted sampling
    })
    .sort((a, b) => b.k - a.k)
    .map((x) => x.it);
}

// ---- turning activity into events ----

/** Interest weight of a coach call: long, talkative calls count as positive, quick exits as negative. */
export function callWeight({ seconds, maxMinutes, yourTurns }) {
  if (seconds < 90 && yourTurns < 4) return -0.4;
  const ratio = Math.min(1, seconds / (Math.max(1, maxMinutes) * 60 * 0.7));
  return Math.round((0.1 + 0.6 * ratio + Math.min(0.2, yourTurns / 50)) * 100) / 100;
}

/** Self-rated difficulty as a result: too easy = 1, just right = 0.75, too hard = 0.3. */
export const LEVEL_PERF = { easy: 1, right: 0.75, hard: 0.3 };
export const RATE_W = { up: 1, meh: -0.1, down: -1 };
