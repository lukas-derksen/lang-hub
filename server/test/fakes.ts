// Small stand-ins for the Worker's bindings, to run src/index.ts in Node:
// D1 on node:sqlite (with the real migrations), KV on a Map, and a scripted Claude client.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

/** An in-memory D1Database (the parts the server uses), migrated like production. */
export function fakeD1(): any {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(MIGRATIONS + f, 'utf8'));
  const plain = (r: any) => (r ? { ...r } : null);
  // Each call resolves on a later microtask, like a real (remote) D1, so requests interleave.
  const stmt = (sql: string, args: any[] = []): any => ({
    bind: (...a: any[]) => stmt(sql, a),
    first: async (col?: string) => { await null; const r = plain(sqlite.prepare(sql).get(...args)); return r && col ? r[col] : r; },
    all: async () => { await null; return { success: true, results: sqlite.prepare(sql).all(...args).map(plain), meta: {} }; },
    run: async () => { await null; const r = sqlite.prepare(sql).run(...args); return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { prepare: (sql: string) => stmt(sql), sqlite };
}

/** A KVNamespace on a Map (get as arrayBuffer, put). */
export function fakeKV(): any {
  const m = new Map<string, ArrayBuffer>();
  return {
    map: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: ArrayBuffer) => { m.set(k, v); },
  };
}

/**
 * A Claude client whose beta.messages.create answers with `reply(params)`:
 * { raw } for a JSON reply, or { stop_reason, text } to script a failure, or throws.
 */
export function fakeClaude(reply: (params: any) => any, usage = { input_tokens: 1000, output_tokens: 500 }): any {
  const calls: any[] = [];
  return {
    calls,
    beta: { messages: { create: async (params: any) => {
      calls.push(params);
      const r = await reply(params);
      return { content: [{ type: 'text', text: r.text ?? JSON.stringify(r.raw) }], stop_reason: r.stop_reason || 'end_turn', usage };
    } } },
  };
}

export function ctx(): any {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} };
}
