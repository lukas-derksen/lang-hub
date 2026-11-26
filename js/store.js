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
  rev: 0,       // bumped on every save; lets a tab notice newer data from another tab
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
  listening: {}, // clipId -> { best, dict, tries, last }
  drills: [],   // { at, cards, right, seconds }
  reports: [],  // { at, days, cats: { category: rate } }
};

const VERSION = DEFAULTS.version;

// Health of local storage, shown by the app (banner, Settings, toasts).
let saveError = null;   // { at, message } while saves fail; cleared by the next good save
let corrupt = null;     // { key, raw, at, preserved } when the stored JSON couldn't be read at start
let conflictAt = 0;     // last time a save was refused because another tab had newer data
let persisted = null;   // 'persisted' | 'not' | 'unsupported' once requestPersist() has run

const listeners = new Set();
let state; // set below, once the helpers load() uses are defined

function readRaw() {
  try { return localStorage.getItem(KEY); } catch (e) { return null; }
}

/** Parse stored progress. Returns null for missing data, throws on damaged data. */
function parse(raw) {
  if (raw == null) return null;
  const data = JSON.parse(raw);
  if (!isObj(data)) throw new Error('Not a progress object');
  return merge(structuredClone(DEFAULTS), migrate(data));
}

function load() {
  const raw = readRaw();
  try {
    return parse(raw) || structuredClone(DEFAULTS);
  } catch (e) {
    // Damaged data: keep a copy under its own key before any save can overwrite it.
    const key = preserveCorrupt(raw);
    corrupt = { key, raw, at: Date.now(), preserved: !!key };
    return structuredClone(DEFAULTS);
  }
}

function preserveCorrupt(raw) {
  const base = `${KEY}.corrupt-${dayKey()}`;
  try {
    for (let i = 1; i < 100; i++) {
      const key = i === 1 ? base : `${base}-${i}`;
      const existing = localStorage.getItem(key);
      if (existing === raw) return key;
      if (existing == null) { localStorage.setItem(key, raw); return key; }
    }
  } catch (e) { /* storage full or blocked: the raw copy stays in memory, see save() */ }
  return null;
}

/**
 * Schema migrations, keyed on `version`. Add a step here when the shape of the
 * stored data changes (and bump DEFAULTS.version). Data newer than this code
 * knows is left as is; import refuses it (see validateBackup).
 */
export function migrate(data) {
  const v = typeof data.version === 'number' ? data.version : 1;
  if (v > VERSION) return data;
  const out = { ...data };
  // if (v < 2) { ...reshape out for version 2... }
  out.version = VERSION;
  return out;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function merge(base, data) {
  return {
    ...base,
    ...data,
    rev: Number.isFinite(data.rev) ? data.rev : 0,
    settings: { ...base.settings, ...(data.settings || {}), plan: { ...base.settings.plan, ...(data.settings?.plan || {}) } },
    days: isObj(data.days) ? data.days : {},
    mistakes: Array.isArray(data.mistakes) ? data.mistakes : [],
    calls: Array.isArray(data.calls) ? data.calls : [],
    listening: isObj(data.listening) ? data.listening : {},
    drills: Array.isArray(data.drills) ? data.drills : [],
    reports: Array.isArray(data.reports) ? data.reports : [],
  };
}

const storedRev = (raw) => { try { const r = JSON.parse(raw)?.rev; return Number.isFinite(r) ? r : 0; } catch (e) { return 0; } };
const notify = (source) => listeners.forEach((fn) => fn(state, { source }));

/**
 * Write progress. Every write bumps `rev`. Before writing, the stored rev is
 * compared with ours: if another tab saved something newer that this tab
 * hasn't picked up yet (the `storage` event arrives asynchronously), we don't
 * overwrite it. We load that data instead, drop this tab's latest change, and
 * the app warns. Merging two diverged states field by field isn't worth the
 * risk here: the dropped change is at most one action (a timer start, a graded
 * card), while clobbering could lose a whole session from the other tab.
 * Returns true when the data was written.
 */
export function save() {
  if (corrupt && !corrupt.preserved) {
    // The damaged data couldn't be copied elsewhere: don't overwrite it until it's downloaded.
    saveError = { at: Date.now(), message: 'Saving is paused until the damaged data is downloaded (Settings).' };
    notify('local');
    return false;
  }
  const raw = readRaw();
  if (raw != null && storedRev(raw) > (state.rev || 0)) {
    try { state = parse(raw); conflictAt = Date.now(); notify('conflict'); return false; } catch (e) { /* unreadable: write ours */ }
  }
  state.rev = (state.rev || 0) + 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    saveError = null;
  } catch (e) {
    saveError = { at: Date.now(), message: e?.name === 'QuotaExceededError' ? 'Storage is full.' : 'The browser refused to save.' };
  }
  notify('local');
  return !saveError;
}

/** Re-read progress written by another tab. */
export function reload() {
  const raw = readRaw();
  if (raw == null) return false; // cleared elsewhere: keep what we have, the next save restores it
  try { state = parse(raw); } catch (e) { return false; }
  notify('remote');
  return true;
}

if (typeof addEventListener === 'function') {
  addEventListener('storage', (e) => { if (e.key === KEY) reload(); });
}

export const health = () => ({ saveError, corrupt, conflictAt, persisted });

/** Copies of damaged data kept under langhub.v1.corrupt-*, newest first. */
export function corruptCopies() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(`${KEY}.corrupt-`)) keys.push(k); }
  } catch (e) { /* ignore */ }
  return keys.sort().reverse();
}

/** The damaged text, from the copy `key` or (when it couldn't be copied) from memory. */
export function corruptRaw(key) {
  if (corrupt && (!key || corrupt.key === key)) return corrupt.raw;
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

export function deleteCorruptCopy(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  if (corrupt?.key === key) corrupt = null;
}

/** The damaged data was downloaded: saving may overwrite it now. */
export function corruptDownloaded() {
  if (corrupt && !corrupt.preserved) { corrupt.preserved = true; saveError = null; save(); }
}

/** Ask the browser not to clear our storage on its own. */
export async function requestPersist() {
  const s = globalThis.navigator?.storage;
  if (!s?.persist) { persisted = 'unsupported'; return persisted; }
  try { persisted = ((await s.persisted?.()) || (await s.persist())) ? 'persisted' : 'not'; } catch (e) { persisted = 'not'; }
  return persisted;
}

/** { data: bytes of stored progress, usage, quota } (the last two when the browser tells). */
export async function storageInfo() {
  const info = { data: (readRaw() || '').length * 2 };
  try { Object.assign(info, await globalThis.navigator?.storage?.estimate?.()); } catch (e) { /* ignore */ }
  return info;
}

state = load();

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
  const target = targetMinutes(key) * 60, done = totalSeconds(daySeconds(key));
  // With no goal at all, any practice counts (and empty days don't, so streak() ends).
  return target > 0 ? done >= target : done > 0;
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

/** 'rotate' or a voice key from the language's coach.voices. */
export function setCoachVoice(v) { state.settings.coachVoice = v; save(); }

export function setPlan(plan, readDays) {
  state.settings.plan = { ...state.settings.plan, ...plan };
  if (readDays) state.settings.readDays = readDays;
  save();
}

export function exportData() { return JSON.stringify(state, null, 2); }

/** Remember when the last export happened (for the backup reminder). */
export function markExported() { state.settings.lastExport = Date.now(); save(); }

/** "Not now" on the backup reminder: hide it for a week. */
export function snoozeBackupReminder() { state.settings.backupNudgeAt = Date.now(); save(); }

/** Throws with a readable message when `data` isn't a usable backup. */
export function validateBackup(data) {
  const bad = (why) => { throw new Error(`This file is not a Lang Hub backup (${why}).`); };
  if (!isObj(data)) bad('not an object');
  if (data.version !== undefined && !(Number.isInteger(data.version) && data.version >= 1)) bad('bad version');
  if ((data.version || 1) > VERSION) throw new Error('This backup is from a newer version of Lang Hub. Update the app first.');
  if (!isObj(data.days)) bad('no days');
  if (Object.values(data.days).some((d) => !isObj(d))) bad('bad day entry');
  for (const k of ['mistakes', 'calls', 'drills', 'reports']) if (data[k] !== undefined && !Array.isArray(data[k])) bad(`${k} is not a list`);
  for (const k of ['settings', 'listening']) if (data[k] !== undefined && !isObj(data[k])) bad(`bad ${k}`);
  if (data.settings?.plan !== undefined && !isObj(data.settings.plan)) bad('bad plan');
  if (data.settings?.readDays !== undefined && !Array.isArray(data.settings.readDays)) bad('bad reading days');
  return data;
}

// Before an import or reset, the current progress is kept under these keys so
// the toast can offer Undo. Each overwrites the previous snapshot.
export const UNDO_KEYS = { import: `${KEY}.before-import`, reset: `${KEY}.before-reset` };

function snapshot(kind) {
  try { localStorage.setItem(UNDO_KEYS[kind], JSON.stringify(state)); return true; } catch (e) { return false; }
}

/** Replace all progress, continuing our rev so the write isn't mistaken for stale data. */
function replaceState(next) {
  next.rev = Math.max(state.rev || 0, storedRev(readRaw()));
  state = next;
  return save();
}

/** Import a backup. Returns { undo }: false when the undo snapshot couldn't be stored. */
export function importData(json) {
  let data;
  try { data = JSON.parse(json); } catch (e) { throw new Error('This file is not a Lang Hub backup (not JSON).'); }
  validateBackup(data);
  const undo = snapshot('import');
  const next = merge(structuredClone(DEFAULTS), migrate(data));
  next.timer = null; // a timer from another device or day would credit hours of practice
  replaceState(next);
  return { undo };
}

export function resetAll() {
  const undo = snapshot('reset');
  replaceState(structuredClone(DEFAULTS));
  return { undo };
}

/** Restore the snapshot taken before the last import ('import') or reset ('reset'). */
export function undo(kind) {
  let next = null;
  try { next = parse(localStorage.getItem(UNDO_KEYS[kind])); } catch (e) { return false; }
  if (!next) return false;
  replaceState(next);
  try { localStorage.removeItem(UNDO_KEYS[kind]); } catch (e) { /* ignore */ }
  return true;
}

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

/**
 * Coach call seconds in the current calendar month (on this device), or since
 * `since` (ms epoch) when given, e.g. the start of the ElevenLabs billing period.
 */
export function callSecondsThisMonth(since) {
  const now = new Date();
  const inPeriod = since != null
    ? (c) => c.at >= since
    : (c) => { const d = new Date(c.at); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); };
  return state.calls
    .filter(inPeriod)
    .reduce((a, c) => a + (c.seconds || 0), 0);
}

// ---- secrets: kept apart from progress, never exported ----
const SECRET_KEY = 'langhub.secret';
export function getApiKey() { try { return localStorage.getItem(SECRET_KEY) || ''; } catch (e) { return ''; } }
export function setApiKey(v) {
  try { v ? localStorage.setItem(SECRET_KEY, v.trim()) : localStorage.removeItem(SECRET_KEY); } catch (e) { /* ignore */ }
}

export function logDrill(d) {
  state.drills.unshift({ at: Date.now(), ...d });
  if (state.drills.length > 1000) state.drills.length = 1000;
  save();
}
