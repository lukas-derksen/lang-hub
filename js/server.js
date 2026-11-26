// Connection to your own content server (server/ in this repo, a Cloudflare Worker).
// Optional: without it the app works as before. With it:
// - new articles, clips, scenes and cards written for your interests show up in the app,
// - your engagement (events), what you've done and mistake categories are synced to it,
//   so it knows what to write next,
// - clip audio comes from the server (voiced once, for every device) instead of
//   being voiced on each device with your own key.
import * as store from './store.js';

// The only server this app talks to. index.html's Content Security Policy
// (connect-src) must name exactly this origin too: change both together.
export const ALLOWED_ORIGIN = 'https://lang-hub-api.dark-bird-a775.workers.dev';

const CONF_KEY = 'langhub.server';      // { url, token } — kept on this device only, never in the backup
const LEGACY_ITEMS_KEY = 'langhub.serveritems'; // where items lived before IndexedDB (migrated once, then removed)
const SYNC_KEY = 'langhub.serversync';   // ms epoch of the last profile sync
const REFRESH_EVERY = 10 * 60e3;
const SYNC_EVERY = 10 * 60e3;   // profile uploads at most this often (plus on leaving the app and after a call or drill)
const SYNC_DEBOUNCE = 5000;     // a burst of saves becomes one upload
const PAGE_LIMIT = 100;         // items per /api/items request
const KEEPALIVE_MAX = 64 * 1024; // browsers refuse keepalive bodies above 64 KB

function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; } }
function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }

/** The normalised server address, or null when it isn't the allowed one. */
export function checkUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch (e) { return null; }
  if (u.origin !== ALLOWED_ORIGIN || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return null;
  return u.origin;
}
export const wrongUrlMessage = () => `This app only talks to your own server at ${ALLOWED_ORIGIN}.`;

export const config = () => read(CONF_KEY, null);
/** Connected: a password is saved for the allowed server (an older saved address for another host doesn't count). */
export const enabled = () => { const c = config(); return !!(c?.token && checkUrl(c.url)); };
export function setConfig(url, token) {
  if (!url) { try { localStorage.removeItem(CONF_KEY); } catch (e) { /* ignore */ } return; }
  const origin = checkUrl(url);
  if (!origin) throw new Error(wrongUrlMessage());
  write(CONF_KEY, { url: origin, token: (token || '').trim() });
}

/** Call the server. Throws an Error with a readable message and the HTTP status (err.status) when there is one. */
export async function api(path, { method = 'GET', body, timeout = 20000, keepalive = false } = {}) {
  const c = config();
  if (!c?.url || !c?.token) throw new Error('No content server set up.');
  const origin = checkUrl(c.url);
  if (!origin) throw new Error(wrongUrlMessage());
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const json = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  let res;
  try {
    res = await fetch(`${origin}${path}`, {
      method, signal: ctrl.signal, keepalive,
      headers: { Authorization: `Bearer ${c.token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json,
    });
  } catch (e) {
    throw new Error(ctrl.signal.aborted ? 'The content server took too long to answer.' : 'Could not reach the content server. Check your connection.');
  } finally { clearTimeout(t); }
  if (res.status === 401) throw Object.assign(new Error('The content server refused the app password.'), { status: 401 });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error || ''; } catch (e) { /* not JSON */ }
    throw Object.assign(new Error(String(msg || `Content server error (${res.status}).`)), { status: res.status });
  }
  return res;
}

// ---------- generated items ----------
// Kept in IndexedDB (they can grow to megabytes), with an in-memory copy so
// byKind() stays synchronous. { items: [{ id, kind, created_at, updated_at?, data }], fetchedAt, since }
// `since` is the paging cursor: the newest created_at received.
let mem = { items: [], fetchedAt: 0, since: 0 };
let newArrived = false;

const DB_NAME = 'langhub', DB_STORE = 'kv', DB_KEY = 'serveritems';
let dbP = null;
function db() {
  dbP ||= new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('no IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  dbP.catch(() => { dbP = null; });
  return dbP;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}
const idbGet = (k) => idb('readonly', (s) => s.get(k));
const idbPut = (k, v) => idb('readwrite', (s) => s.put(v, k));

const sinceOf = (items) => items.reduce((a, x) => Math.max(a, Number(x.created_at) || 0), 0);
function normalise(v) {
  const items = Array.isArray(v?.items) ? v.items.filter((x) => x && x.id && x.data) : [];
  return { items, fetchedAt: Number(v?.fetchedAt) || 0, since: Number(v?.since) || sinceOf(items) };
}

let storeOk = true; // false when IndexedDB is unavailable: items then live in localStorage, as before
async function persist() {
  const v = { items: mem.items, fetchedAt: mem.fetchedAt, since: mem.since };
  if (storeOk) {
    try { await idbPut(DB_KEY, v); return; } catch (e) { storeOk = false; }
  }
  write(LEGACY_ITEMS_KEY, v);
}

/** Load the downloaded items from IndexedDB (once), migrating the old localStorage copy. */
let loadP = null, loadedLate = false, loaded = false;
function loadItems() {
  loadP ||= (async () => {
    const legacy = read(LEGACY_ITEMS_KEY, null);
    try {
      let v = normalise(await idbGet(DB_KEY));
      if (legacy) {
        // One-time move out of localStorage (it's small and synchronous; items can be large).
        const old = normalise(legacy), byId = new Map(old.items.map((x) => [x.id, x]));
        for (const x of v.items) byId.set(x.id, x);
        v = { items: [...byId.values()], fetchedAt: Math.max(v.fetchedAt, old.fetchedAt), since: Math.max(v.since, old.since) };
        await idbPut(DB_KEY, v);
        try { localStorage.removeItem(LEGACY_ITEMS_KEY); } catch (e) { /* ignore */ }
      }
      mem = v;
    } catch (e) {
      storeOk = false;
      mem = normalise(legacy);
    }
    loaded = true;
    if (loadedLate && mem.items.length) dispatchEvent(new CustomEvent('langhub:newcontent', { detail: 0 }));
  })();
  return loadP;
}
loadItems();

/** Resolves once the items are loaded, or after `ms` (the app then re-renders when they arrive). */
export function whenLoaded(ms = 800) {
  return Promise.race([loadP, new Promise((r) => setTimeout(r, ms))]).then(() => { if (!loaded) loadedLate = true; });
}

// Light shape checks, so one malformed generated item can't break a whole screen.
const isArr = Array.isArray, isStr = (v) => typeof v === 'string' && v.length > 0;
const VALID = {
  clip: (x) => isArr(x.segments) && x.segments.length && x.segments.every((s) => s && isStr(s.text) && isStr(s.voice)) && isArr(x.questions) && x.questions.every((q) => q && isArr(q.options)) && typeof x.dictation === 'string',
  article: (x) => isArr(x.paragraphs) && isArr(x.glossary) && x.glossary.every(isArr) && isArr(x.discussion),
  scene: (x) => isStr(x.instructions) && isStr(x.firstMessage),
  cards: (x) => isArr(x.cards),
};

/** Generated content of one kind ('article' | 'clip' | 'scene' | 'cards'), newest first. */
export function byKind(kind) {
  if (!enabled()) return [];
  return mem.items
    .filter((x) => x.kind === kind && x.data && typeof x.data === 'object' && isStr(x.data.id) && (kind === 'cards' || isStr(x.data.title)) && VALID[kind]?.(x.data))
    .sort((a, b) => b.created_at - a.created_at)
    .map((x) => ({ ...x.data, topics: isArr(x.data.topics) ? x.data.topics.filter(isStr) : [], generated: x.created_at, serverId: x.id }));
}

let refreshing = null;
/** Fetch new and changed items from the server (at most every 10 minutes unless forced). Returns how many new ones arrived. */
export function refreshItems(force = false) {
  if (!enabled()) return Promise.resolve(0);
  refreshing ||= (async () => {
    await loadP;
    if (!force && Date.now() - mem.fetchedAt < REFRESH_EVERY) return 0;
    const byId = new Map(mem.items.map((x) => [x.id, x]));
    let since = mem.since, fresh = 0, changed = false;
    for (let page = 0; page < 50; page++) {
      const res = await api(`/api/items?since=${since}&limit=${PAGE_LIMIT}`);
      const { items, more } = await res.json();
      const list = (isArr(items) ? items : []).filter((x) => x && x.id);
      for (const x of list) {
        const had = byId.get(x.id);
        // Hidden on the server ({ id, kind, created_at, hidden }): drop it here (may repeat).
        if (x.hidden) { if (had) { byId.delete(x.id); changed = true; } continue; }
        if (!x.data) continue;
        if (!had) { byId.set(x.id, x); fresh++; changed = true; }
        else if ((Number(x.updated_at) || 0) > (Number(had.updated_at) || 0)) { byId.set(x.id, x); changed = true; }
      }
      const next = Math.max(since, sinceOf(list));
      // Loop while the server says there's more (older servers don't say: a full page means more).
      // `since` is inclusive, so stop if the cursor can't move on.
      const hasMore = typeof more === 'boolean' ? more : list.length >= PAGE_LIMIT;
      if (!hasMore || next === since) { since = next; break; }
      since = next;
    }
    mem = { items: [...byId.values()], fetchedAt: Date.now(), since };
    await persist();
    if (fresh) newArrived = true;
    if (changed) dispatchEvent(new CustomEvent('langhub:newcontent', { detail: fresh }));
    return fresh;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** True once after new items arrived (the screens reload their lists). */
export function takeNew() { const n = newArrived; newArrived = false; return n; }

/** Hide a generated item: the server stops offering it, and it's dropped here. */
export async function hideItem(id) {
  let local = false;
  try { await api(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) {
    if (e.status !== 404) throw e;
    local = true; // older server without the route, or already gone there
  }
  await loadP;
  mem = { ...mem, items: mem.items.filter((x) => x.id !== id) };
  await persist();
  dispatchEvent(new CustomEvent('langhub:newcontent', { detail: 0 }));
  return { local };
}

// ---------- profile sync ----------
/** Every item you've done: picks events, coach calls and clip results. */
export function usedKeys() {
  const s = store.get(), used = new Set();
  for (const e of s.events) if (e.item) used.add(e.item);
  for (const c of s.calls) if (c.ref && (c.mode === 'scene' || c.mode === 'read')) used.add(`${c.mode === 'read' ? 'article' : 'scene'}:${c.ref}`);
  for (const id of Object.keys(s.listening || {})) used.add(`clip:${id}`);
  return [...used];
}

let syncTimer = null, lastSyncedRev = -1, inflightRev = -1;
let lastAttempt = lastSync(); // a reload doesn't reset the throttle

function profileBody() {
  const s = store.get();
  return JSON.stringify({ events: s.events.slice(-3000), used: usedKeys(), mistakes: s.mistakes.slice(0, 500).map((m) => ({ at: m.at, category: m.category })) });
}

/** Upload the profile now if it changed since the last upload. */
export async function syncProfile({ keepalive = false } = {}) {
  if (!enabled()) return;
  const rev = store.get().rev;
  if (rev === lastSyncedRev || rev === inflightRev) return;
  clearTimeout(syncTimer); syncTimer = null;
  const body = profileBody();
  inflightRev = rev;
  lastAttempt = Date.now();
  try {
    // keepalive lets the upload finish after the page is gone, but only for small bodies.
    await api('/api/profile', { method: 'PUT', body, keepalive: keepalive && new Blob([body]).size < KEEPALIVE_MAX });
    lastSyncedRev = rev;
    write(SYNC_KEY, Date.now());
  } finally { if (inflightRev === rev) inflightRev = -1; }
}
export function lastSync() { return read(SYNC_KEY, 0); }

/** After a change: upload at most once per SYNC_EVERY. */
function scheduleSync() {
  if (!enabled() || syncTimer) return;
  const wait = Math.max(SYNC_DEBOUNCE, lastAttempt + SYNC_EVERY - Date.now());
  syncTimer = setTimeout(() => { syncTimer = null; syncProfile().catch(() => { /* retried on the next change or start */ }); }, wait);
}

/** Upload soon, regardless of the throttle (a call or drill just ended). */
export function syncSoon() {
  if (!enabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncProfile().catch(() => { /* retried later */ }); }, 1500);
}

/** Leaving the app: upload what's pending, best effort. */
function flush() { if (enabled()) syncProfile({ keepalive: true }).catch(() => { /* best effort */ }); }

/** Start: sync and fetch new items in the background, then keep syncing on changes. */
export function start() {
  store.subscribe(scheduleSync);
  const go = () => {
    if (!enabled() || !navigator.onLine) return;
    scheduleSync();
    refreshItems().catch(() => { /* offline or server down: cached items stay */ });
  };
  go();
  addEventListener('online', go);
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else go(); });
}

// ---------- audio ----------
/**
 * One clip segment's mp3 from the server (voiced there once, kept for every device).
 * `hash` is the segment's text/model/settings hash (see segHash in listen.js): the
 * server answers 409 when its text differs, so stale audio is never cached.
 */
export async function segmentAudio(clipId, i, hash) {
  const base = `/api/audio/${encodeURIComponent(clipId)}/${Number(i)}`;
  let res;
  try {
    res = await api(hash ? `${base}/${encodeURIComponent(hash)}` : base, { timeout: 60000 });
  } catch (e) {
    if (e.status === 409) {
      refreshItems(true).catch(() => { /* offline */ });
      throw Object.assign(new Error('This clip changed on the server; refresh content'), { status: 409 });
    }
    if (e.status !== 404 || !hash) throw e;
    res = await api(base, { timeout: 60000 }); // older server without hashed audio URLs
  }
  return res.arrayBuffer();
}
