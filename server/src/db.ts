// Storage in D1: items, the synced profile, usage counters, attempts, the writing lease.
// Anything that must hold under concurrent requests is a single atomic SQL statement.
import type { Kind, Profile } from './plan.ts';

export type Item = { id: string; kind: Kind; created_at: number; data: any };
/** A hidden item as /api/items reports it: no data, the app drops it. */
export type HiddenItem = { id: string; kind: Kind; created_at: number; hidden: true };

const DAY = 864e5;
export const month = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
const changed = (r: D1Result) => (r.meta?.changes || 0) > 0;

// ---------- state ----------
export async function getState<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare('SELECT value FROM state WHERE key = ?').bind(key).first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}
export async function setState(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), Date.now()).run();
}

export async function getProfile(db: D1Database): Promise<Profile> {
  const p = (await getState<any>(db, 'profile')) || {};
  return { events: Array.isArray(p.events) ? p.events : [], used: Array.isArray(p.used) ? p.used : [], mistakes: Array.isArray(p.mistakes) ? p.mistakes : [], updatedAt: p.updatedAt };
}

// ---------- the writing lease ----------
// One top-up or generate at a time. The row 'lock:generate' holds the owner in value and
// the lease's expiry in updated_at; a crashed run frees it when the lease runs out.
const LOCK = 'lock:generate';
export const LEASE_MS = 15 * 60e3;

/** Take the lease if it's free or expired (one atomic statement). Returns the owner id, or null. */
export async function acquireLock(db: D1Database, now = Date.now()): Promise<string | null> {
  const owner = crypto.randomUUID();
  const r = await db.prepare(`INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE state.updated_at <= ?4`)
    .bind(LOCK, owner, now + LEASE_MS, now).run();
  return changed(r) ? owner : null;
}
/** Extend the lease (between items of a long top-up). */
export async function renewLock(db: D1Database, owner: string): Promise<void> {
  await db.prepare('UPDATE state SET updated_at = ? WHERE key = ? AND value = ?').bind(Date.now() + LEASE_MS, LOCK, owner).run();
}
export async function releaseLock(db: D1Database, owner: string): Promise<void> {
  await db.prepare('DELETE FROM state WHERE key = ? AND value = ?').bind(LOCK, owner).run();
}

/** True at most once per `everyMs` for `key` (one atomic statement): a simple rate limit. */
export async function rateOk(db: D1Database, key: string, everyMs: number, now = Date.now()): Promise<boolean> {
  const r = await db.prepare(`INSERT INTO state (key, value, updated_at) VALUES (?1, '', ?2)
    ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at WHERE state.updated_at <= ?2 - ?3`)
    .bind(key, now, everyMs).run();
  return changed(r);
}

// ---------- usage ----------
export async function addUsage(db: D1Database, kind: string, amount: number): Promise<void> {
  if (!amount) return;
  await db.prepare('INSERT INTO usage (month, kind, amount) VALUES (?, ?, ?) ON CONFLICT(month, kind) DO UPDATE SET amount = amount + excluded.amount')
    .bind(month(), kind, Math.round(amount)).run();
}
export async function usageThisMonth(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare('SELECT kind, amount FROM usage WHERE month = ?').bind(month()).all<{ kind: string; amount: number }>();
  return Object.fromEntries(results.map((r) => [r.kind, r.amount]));
}
/**
 * Reserve `n` units of a monthly budget before spending them: one atomic UPDATE that only
 * applies while the total stays within `limit`. Returns the month to refund to, or null.
 */
export async function reserve(db: D1Database, kind: string, n: number, limit: number): Promise<string | null> {
  const m = month();
  await db.prepare('INSERT INTO usage (month, kind, amount) VALUES (?, ?, 0) ON CONFLICT(month, kind) DO NOTHING').bind(m, kind).run();
  const r = await db.prepare('UPDATE usage SET amount = amount + ?1 WHERE month = ?2 AND kind = ?3 AND amount + ?1 <= ?4').bind(n, m, kind, limit).run();
  return changed(r) ? m : null;
}
export async function refund(db: D1Database, m: string, kind: string, n: number): Promise<void> {
  await db.prepare('UPDATE usage SET amount = MAX(0, amount - ?) WHERE month = ? AND kind = ?').bind(n, m, kind).run();
}

// ---------- attempts ----------
const dayStart = (t: number) => t - (t % DAY); // UTC midnight
export async function recordAttempt(db: D1Database, kind: Kind, ok: boolean, error = ''): Promise<void> {
  await db.prepare('INSERT INTO attempts (kind, at, ok, error) VALUES (?, ?, ?, ?)').bind(kind, Date.now(), ok ? 1 : 0, error.slice(0, 500) || null).run();
}
export async function failuresToday(db: D1Database, kind: Kind, now = Date.now()): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE kind = ? AND ok = 0 AND at >= ?').bind(kind, dayStart(now)).first<{ n: number }>();
  return row?.n || 0;
}
export async function pruneAttempts(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM attempts WHERE at < ?').bind(now - 90 * DAY).run();
}

// ---------- items ----------
/**
 * Store a new item. Its created_at is the time of this insert, but always later than every
 * other item's, so each item has its own timestamp and the app's `since` cursor never skips one.
 * Returns that created_at (updated_at starts equal to it).
 */
export async function insertItem(db: D1Database, id: string, kind: Kind, data: unknown): Promise<number> {
  const row = await db.prepare(`INSERT INTO items (id, kind, created_at, updated_at, data)
    SELECT ?1, ?2, t, t, ?3 FROM (SELECT MAX(?4, COALESCE((SELECT MAX(created_at) FROM items), 0) + 1) AS t)
    RETURNING created_at`).bind(id, kind, JSON.stringify(data), Date.now()).first<{ created_at: number }>();
  return row!.created_at;
}
export async function idTaken(db: D1Database, id: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 AS x FROM items WHERE id = ?').bind(id).first());
}

/**
 * GET /api/items: items for the app's cursor `since` (the newest created_at it has).
 * - Visible items with created_at >= since, oldest first, at most `limit` (more: page was full;
 *   ask again with since = the last item's created_at, and drop ids you already have).
 * - Items hidden since then that the app already has (created_at <= since, updated_at >= since),
 *   as { id, kind, created_at, hidden: true } without data: the app drops them.
 *   Hidden items it never got aren't sent at all.
 */
export async function itemsSince(db: D1Database, since: number, limit: number): Promise<{ items: (Item | HiddenItem)[]; more: boolean }> {
  const { results } = await db.prepare('SELECT id, kind, created_at, data FROM items WHERE hidden = 0 AND created_at >= ? ORDER BY created_at, id LIMIT ?')
    .bind(since, limit).all<{ id: string; kind: Kind; created_at: number; data: string }>();
  const hidden = since > 0
    ? (await db.prepare('SELECT id, kind, created_at FROM items WHERE hidden = 1 AND updated_at >= ?1 AND created_at <= ?1 ORDER BY created_at')
      .bind(since).all<{ id: string; kind: Kind; created_at: number }>()).results
    : [];
  return {
    items: [...hidden.map((r) => ({ id: r.id, kind: r.kind, created_at: r.created_at, hidden: true as const })), ...results.map((r) => ({ ...r, data: JSON.parse(r.data) }))],
    more: results.length === limit,
  };
}

/** Every generated item's id, kind and date (no data), for planning. */
export async function itemIndex(db: D1Database): Promise<{ id: string; kind: Kind; created_at: number; hidden: number }[]> {
  return (await db.prepare('SELECT id, kind, created_at, hidden FROM items').all<{ id: string; kind: Kind; created_at: number; hidden: number }>()).results;
}

/** One generated clip (not hidden), or null. */
export async function getClip(db: D1Database, id: string): Promise<any> {
  const row = await db.prepare("SELECT data FROM items WHERE id = ? AND kind = 'clip' AND hidden = 0").bind(id).first<{ data: string }>();
  return row ? JSON.parse(row.data) : null;
}

/** Titles of the latest 40 visible items of a kind, oldest first. */
export async function recentTitles(db: D1Database, kind: Kind): Promise<string[]> {
  const { results } = await db.prepare("SELECT json_extract(data, '$.title') AS title FROM items WHERE kind = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 40")
    .bind(kind).all<{ title: string | null }>();
  return results.map((r) => r.title).filter((t): t is string => !!t).reverse();
}

/** Visible generated items per kind. */
export async function countByKind(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db.prepare('SELECT kind, COUNT(*) AS n FROM items WHERE hidden = 0 GROUP BY kind').all<{ kind: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.kind, r.n]));
}

/** Items of a kind made since `t`, hidden ones included (they were still paid for). */
export async function madeSince(db: D1Database, kind: Kind, t: number): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM items WHERE kind = ? AND created_at >= ?').bind(kind, t).first<{ n: number }>();
  return row?.n || 0;
}

/**
 * Hide an item (DELETE /api/items/:id). updated_at moves past every created_at, so any
 * app that has the item sees the hide on its next fetch. False when there's no such item.
 */
export async function hideItem(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare('UPDATE items SET hidden = 1, updated_at = MAX(?2, (SELECT MAX(created_at) FROM items) + 1) WHERE id = ?1')
    .bind(id, Date.now()).run();
  return changed(r);
}
