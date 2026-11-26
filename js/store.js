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
    // Minutes per day. A skill set to 0 is shown as a bonus without a goal.
    plan: { speak: 12, listen: 12, read: 0, review: 6 },
  },
  days: {},   // 'YYYY-MM-DD' -> { speak, listen, read, review } in seconds
  timer: null // { skill, startedAt (ms epoch) } while a timer runs
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

export function targetMinutes() {
  return Object.values(state.settings.plan).reduce((a, b) => a + b, 0);
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
  return totalSeconds(daySeconds(key)) >= targetMinutes() * 60;
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

export function setPlan(plan) { state.settings.plan = { ...state.settings.plan, ...plan }; save(); }

export function exportData() { return JSON.stringify(state, null, 2); }

export function importData(json) {
  const data = JSON.parse(json);
  if (!data || typeof data !== 'object' || !data.days) throw new Error('This file is not a Lang Hub backup.');
  state = merge(structuredClone(DEFAULTS), data);
  save();
}

export function resetAll() { state = structuredClone(DEFAULTS); save(); }
