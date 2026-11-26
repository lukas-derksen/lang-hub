import { DEFAULT_LANGUAGE } from './languages.js';

// Local persistence. Everything lives on this device (localStorage), with
// export/import in Settings as the backup path.

const KEY = 'langhub.v1';

export const SKILLS = {
  speak: { label: 'Speaking', icon: '🗣', route: '#/speak' },
  listen: { label: 'Listening', icon: '🎧', route: '#/listen' },
  read: { label: 'Reading', icon: '📖', route: '#/read' },
  review: { label: 'Review', icon: '✎', route: '#/review' },
};

const ZERO = () => Object.fromEntries(Object.keys(SKILLS).map((k) => [k, 0]));

const DEFAULTS = {
  version: 1,
  settings: {
    language: DEFAULT_LANGUAGE,
    // Base minutes per day. On reading days, Read + discuss takes the
    // speaking slot, so the day stays the same length.
    plan: { speak: 12, listen: 12, review: 6 },
    readDays: [1, 4], // JS weekday numbers: 0 = Sunday ... 6 = Saturday (Mon, Thu)
  },
  days: {},     // 'YYYY-MM-DD' -> { speak, listen, read, review } in seconds
  timer: null,  // { skill, startedAt (ms epoch) } while a timer runs
  mistakes: [], // { id, at, said, correct, explanation, category, source }
  calls: [],    // { at, mode, title, seconds, mistakes }
};

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch (e) { /* storage blocked or corrupt: start fresh in memory */ }
  return structuredClone(DEFAULTS);
}

function merge(base, data) {
  return {
    ...base,
    ...data,
    settings: { ...base.settings, ...(data.settings || {}), plan: { ...base.settings.plan, ...(data.settings?.plan || {}) } },
    days: data.days || {},
    mistakes: Array.isArray(data.mistakes) ? data.mistakes : [],
    calls: Array.isArray(data.calls) ? data.calls : [],
  };
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  listeners.forEach((fn) => fn(state));
}

export const get = () => state;
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function dayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const BASE_SKILLS = ['speak', 'listen', 'review'];

const dateOf = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };

export function isReadDay(key = dayKey()) {
  return (state.settings.readDays || []).includes(dateOf(key).getDay());
}

/** Effective minutes per skill for a day. A skill at 0 is an extra without a goal. */
export function planFor(key = dayKey()) {
  const b = state.settings.plan;
  const p = { speak: b.speak || 0, listen: b.listen || 0, read: 0, review: b.review || 0 };
  if (isReadDay(key)) { p.read = p.speak; p.speak = 0; }
  return p;
}

export function targetMinutes(key = dayKey()) {
  return Object.values(planFor(key)).reduce((a, b) => a + b, 0);
}

/** Seconds logged for a day, including the running timer if it's today. */
export function daySeconds(key = dayKey()) {
  const d = { ...ZERO(), ...(state.days[key] || {}) };
  const t = state.timer;
  if (t && key === dayKey()) d[t.skill] += Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000));
  return d;
}

export function totalSeconds(d) { return Object.values(d).reduce((a, b) => a + b, 0); }

/** A day "counts" for the streak when the total target time is reached. */
export function dayMet(key) {
  return totalSeconds(daySeconds(key)) >= targetMinutes(key) * 60;
}

export function streak() {
  const d = new Date();
  let n = 0;
  // Today only extends the streak once it's met; an unmet today doesn't break it.
  if (dayMet(dayKey(d))) n++;
  d.setDate(d.getDate() - 1);
  while (dayMet(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

export function bestStreak() {
  const keys = Object.keys(state.days).sort();
  if (!keys.length) return 0;
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    if (!dayMet(k)) { run = 0; prev = k; continue; }
    const contiguous = prev && dayMet(prev) && (new Date(k) - new Date(prev)) / 864e5 === 1;
    run = contiguous ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return best;
}

// ---- timer ----
export function startTimer(skill) {
  if (state.timer?.skill === skill) return;
  stopTimer(false);
  state.timer = { skill, startedAt: Date.now() };
  save();
}

export function stopTimer(persist = true) {
  const t = state.timer;
  if (!t) return;
  // A timer left running past midnight is credited to the day it started.
  const key = dayKey(new Date(t.startedAt));
  const secs = Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000));
  // Guard against a timer forgotten for hours: cap a single session at 3h.
  addSeconds(key, t.skill, Math.min(secs, 3 * 3600), false);
  state.timer = null;
  if (persist) save();
}

export function addSeconds(key, skill, secs, persist = true) {
  const d = state.days[key] || (state.days[key] = ZERO());
  d[skill] = Math.max(0, (d[skill] || 0) + secs);
  if (persist) save();
}

export function setPlan(plan, readDays) {
  state.settings.plan = { ...state.settings.plan, ...plan };
  if (readDays) state.settings.readDays = readDays;
  save();
}

export function exportData() { return JSON.stringify(state, null, 2); }

export function importData(json) {
  const data = JSON.parse(json);
  if (!data || typeof data !== 'object' || !data.days) throw new Error('This file is not a Lang Hub backup.');
  state = merge(structuredClone(DEFAULTS), data);
  save();
}

export function resetAll() { state = structuredClone(DEFAULTS); save(); }

// ---- coach: mistakes and calls ----
export function addMistake(m, source) {
  const item = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    said: String(m.said || '').slice(0, 300),
    correct: String(m.correct || '').slice(0, 300),
    explanation: String(m.explanation || '').slice(0, 200),
    category: String(m.category || 'other').slice(0, 40),
    source,
  };
  if (!item.said || !item.correct) return null;
  state.mistakes.unshift(item);
  if (state.mistakes.length > 2000) state.mistakes.length = 2000;
  save();
  return item;
}

export function deleteMistake(id) { state.mistakes = state.mistakes.filter((m) => m.id !== id); save(); }

export function logCall(call) {
  state.calls.unshift({ at: Date.now(), ...call });
  if (state.calls.length > 1000) state.calls.length = 1000;
  save();
}

/** Coach call seconds in the current calendar month (on this device). */
export function callSecondsThisMonth() {
  const now = new Date();
  return state.calls
    .filter((c) => { const d = new Date(c.at); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); })
    .reduce((a, c) => a + (c.seconds || 0), 0);
}

// ---- secrets: kept apart from progress, never exported ----
const SECRET_KEY = 'langhub.secret';
export function getApiKey() { try { return localStorage.getItem(SECRET_KEY) || ''; } catch (e) { return ''; } }
export function setApiKey(v) {
  try { v ? localStorage.setItem(SECRET_KEY, v.trim()) : localStorage.removeItem(SECRET_KEY); } catch (e) { /* ignore */ }
}
