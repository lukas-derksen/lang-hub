// Connection to your own content server (server/ in this repo, a Cloudflare Worker).
// Optional: without it the app works as before. With it:
// - new articles, clips, scenes and cards written for your interests show up in the app,
// - your engagement (events), what you've done and mistake categories are synced to it,
//   so it knows what to write next,
// - clip audio comes from the server (voiced once, for every device) instead of
//   being voiced on each device with your own key.
import * as store from './store.js';

const CONF_KEY = 'langhub.server';      // { url, token } — kept on this device only, never in the backup
const ITEMS_KEY = 'langhub.serveritems'; // { items: [{ id, kind, created_at, data }], fetchedAt }
const SYNC_KEY = 'langhub.serversync';   // ms epoch of the last profile sync
const REFRESH_EVERY = 10 * 60e3;
const SYNC_DEBOUNCE = 5000;

function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; } }
function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }

export const config = () => read(CONF_KEY, null);
export const enabled = () => { const c = config(); return !!(c?.url && c?.token); };
export function setConfig(url, token) {
  if (!url) { try { localStorage.removeItem(CONF_KEY); } catch (e) { /* ignore */ } return; }
  write(CONF_KEY, { url: url.trim().replace(/\/+$/, ''), token: (token || '').trim() });
}

/** Call the server. Throws an Error with a readable message. */
export async function api(path, { method = 'GET', body, timeout = 20000 } = {}) {
  const c = config();
  if (!c?.url || !c?.token) throw new Error('No content server set up.');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(`${c.url}${path}`, {
      method, signal: ctrl.signal,
      headers: { Authorization: `Bearer ${c.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(ctrl.signal.aborted ? 'The content server took too long to answer.' : 'Could not reach the content server. Check the address and your connection.');
  } finally { clearTimeout(t); }
  if (res.status === 401) throw new Error('The content server refused the app password.');
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error || ''; } catch (e) { /* not JSON */ }
    throw new Error(msg || `Content server error (${res.status}).`);
  }
  return res;
}

// ---------- generated items ----------
let newArrived = false;
const cached = () => read(ITEMS_KEY, { items: [], fetchedAt: 0 });

/** Generated content of one kind ('article' | 'clip' | 'scene' | 'cards'), newest first. */
export function byKind(kind) {
  if (!enabled()) return [];
  return cached().items.filter((x) => x.kind === kind).sort((a, b) => b.created_at - a.created_at).map((x) => ({ ...x.data, generated: x.created_at }));
}

/** Fetch new items from the server (at most every 10 minutes unless forced). Returns how many arrived. */
export async function refreshItems(force = false) {
  if (!enabled()) return 0;
  const c = cached();
  if (!force && Date.now() - c.fetchedAt < REFRESH_EVERY) return 0;
  const since = c.items.reduce((a, x) => Math.max(a, x.created_at), 0);
  const res = await api(`/api/items?since=${since}`);
  const { items } = await res.json();
  const known = new Set(c.items.map((x) => x.id));
  const fresh = (items || []).filter((x) => x && x.id && !known.has(x.id));
  write(ITEMS_KEY, { items: [...c.items, ...fresh], fetchedAt: Date.now() });
  if (fresh.length) { newArrived = true; dispatchEvent(new CustomEvent('langhub:newcontent', { detail: fresh.length })); }
  return fresh.length;
}

/** True once after new items arrived (the screens reload their lists). */
export function takeNew() { const n = newArrived; newArrived = false; return n; }

// ---------- profile sync ----------
/** Every item you've done: picks events, coach calls and clip results. */
export function usedKeys() {
  const s = store.get(), used = new Set();
  for (const e of s.events) if (e.item) used.add(e.item);
  for (const c of s.calls) if (c.ref && (c.mode === 'scene' || c.mode === 'read')) used.add(`${c.mode === 'read' ? 'article' : 'scene'}:${c.ref}`);
  for (const id of Object.keys(s.listening || {})) used.add(`clip:${id}`);
  return [...used];
}

let syncTimer = null, lastSyncedRev = -1;
export async function syncProfile() {
  if (!enabled()) return;
  const s = store.get();
  if (s.rev === lastSyncedRev) return;
  await api('/api/profile', {
    method: 'PUT',
    body: { events: s.events.slice(-3000), used: usedKeys(), mistakes: s.mistakes.slice(0, 500).map((m) => ({ at: m.at, category: m.category })) },
  });
  lastSyncedRev = s.rev;
  write(SYNC_KEY, Date.now());
}
export const lastSync = () => read(SYNC_KEY, 0);

function scheduleSync() {
  if (!enabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncProfile().catch(() => { /* retried on the next change or start */ }); }, SYNC_DEBOUNCE);
}

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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) go(); });
}

// ---------- audio ----------
/** One clip segment's mp3 from the server (voiced there once, kept for every device). */
export async function segmentAudio(clipId, i) {
  const res = await api(`/api/audio/${encodeURIComponent(clipId)}/${i}`, { timeout: 60000 });
  return res.arrayBuffer();
}
