// The Worker's routes and nightly run, end to end in Node: D1 on node:sqlite with the real
// migrations, KV on a Map, a scripted Claude client and a stubbed ElevenLabs (global fetch).
// Run: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { deps } from '../src/deps.ts';
import { BUILTIN } from '../src/generate.ts';
import { segHash, VOICE_SETTINGS } from '../src/tts.ts';
import * as db from '../src/db.ts';
import { fakeD1, fakeKV, fakeClaude, ctx } from './fakes.ts';

const TOKEN = 'test-app-password-0123456789';
const TTS_MODEL = 'eleven_multilingual_v2';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEnv(over: Record<string, string> = {}): any {
  return {
    DB: fakeD1(), AUDIO: fakeKV(), APP_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'k', ELEVENLABS_TTS_KEY: 'e',
    ALLOWED_ORIGINS: 'http://localhost:8000', MODEL: 'test-model', TTS_MODEL,
    CLIPS_PER_WEEK: '3', ARTICLES_PER_WEEK: '2', SCENES_PER_WEEK: '1', CARD_BATCHES_PER_WEEK: '1',
    TTS_MONTHLY_CHARS: '25000', CLAUDE_MONTHLY_INPUT_TOKENS: '2000000', CLAUDE_MONTHLY_OUTPUT_TOKENS: '300000',
    ...over,
  };
}
async function call(env: any, path: string, { method = 'GET', body, token = TOKEN, headers = {} }: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const h: Record<string, string> = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://api.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx());
}
const getJson = async (env: any, path: string, opts = {}) => { const r = await call(env, path, opts); return { status: r.status, body: await r.json() as any, res: r }; };

// ---- what the scripted Claude writes, valid for each kind ----
let n = 0;
const voiceKey = Object.keys(BUILTIN.clips.voices)[0];
function rawFor(prompt: string): any {
  const title = `Titolo ${++n}`;
  if (prompt.includes('Write a reading article')) return { title, topic_label: 'Cibo', level: 'B1', minutes: 5, paragraphs: ['Uno.', 'Due.', 'Tre.'], glossary: ['a', 'b', 'c', 'd'].map((w) => ({ word: w, meaning: 'm' })), discussion: ['x'] };
  if (prompt.includes('Write a listening clip')) return { title, genre: 'Dialogue', level: 'B1', segments: [{ voice: voiceKey, text: 'Buongiorno, vorrei un caffè e un cornetto alla crema, per favore.' }], questions: [{ q: 'Cosa?', options: ['caffè', 'tè'], answer: 0 }, { q: 'E poi?', options: ['cornetto', 'pizza'], answer: 0 }], dictation: 'Buongiorno, vorrei un caffè e un cornetto alla crema, per favore.' };
  if (prompt.includes('Write a speaking scene')) return { title, subtitle: 'At the bar', icon: '☕', minutes: 8, level: 'B1', firstMessage: 'Buongiorno!', instructions: 'Play a barista.' };
  return { cards: Array.from({ length: 10 }, (_, i) => ({ text: `Domanda ${n}.${i}?`, type: 'quick', topics: ['food'] })) };
}
const kindOf = (params: any) => { const p = params.messages[0].content as string; return p.includes('reading article') ? 'article' : p.includes('listening clip') ? 'clip' : p.includes('speaking scene') ? 'scene' : 'cards'; };
const ok = (params: any) => ({ raw: rawFor(params.messages[0].content) });

// ---- ElevenLabs stub ----
const realFetch = globalThis.fetch;
let tts = { calls: 0, status: 200 };
beforeEach(() => {
  tts = { calls: 0, status: 200 };
  globalThis.fetch = (async (url: string) => {
    assert.match(String(url), /api\.elevenlabs\.io/);
    tts.calls++;
    await sleep(5);
    return tts.status === 200 ? new Response(new Uint8Array([1, 2, 3]), { status: 200 }) : new Response('{}', { status: tts.status });
  }) as any;
  deps.claude = () => { throw new Error('no Claude client set up in this test'); };
});
afterEach(() => { globalThis.fetch = realFetch; });

const allBuiltinKeys = () => [
  ...BUILTIN.clips.clips.map((c: any) => `clip:${c.id}`), ...BUILTIN.articles.map((a) => `article:${a.id}`), ...BUILTIN.scenes.map((s) => `scene:${s.id}`),
];

test('auth: 401 without or with a wrong password; /api/health is open', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/api/health', { token: null })).status, 200);
  assert.equal((await call(env, '/api/status', { token: null })).status, 401);
  assert.equal((await call(env, '/api/status', { token: 'wrong-password-0123456789' })).status, 401);
  assert.equal((await call(env, '/api/items', { token: TOKEN.slice(0, -1) })).status, 401);
  assert.equal((await call(env, '/api/status')).status, 200);
});

test('S1: every item of a run has its own created_at; a fetch mid-run misses none', async () => {
  const env = makeEnv();
  await call(env, '/api/profile', { method: 'PUT', body: { events: [], used: allBuiltinKeys(), mistakes: [] } });
  let midSince = -1;
  const claude = fakeClaude(async (params) => {
    if (claude.calls.length === 2) {
      // The app fetches while the second item is being written.
      const { body } = await getJson(env, '/api/items?since=0');
      midSince = Math.max(0, ...body.items.map((x: any) => x.created_at));
      assert.equal(body.items.length, 1);
    }
    return ok(params);
  });
  deps.claude = () => claude;
  const { status, body: run } = await getJson(env, '/api/topup', { method: 'POST' });
  assert.equal(status, 200);
  assert.deepEqual(run.errors, []);
  assert.equal(run.made.length, 4, JSON.stringify(run));

  const { body: all } = await getJson(env, '/api/items?since=0');
  const times = all.items.map((x: any) => x.created_at);
  assert.equal(new Set(times).size, 4, 'distinct timestamps');
  assert.deepEqual(times, [...times].sort((a: number, b: number) => a - b));

  const { body: after } = await getJson(env, `/api/items?since=${midSince}`);
  const ids = after.items.map((x: any) => x.id);
  for (const id of run.made.slice(1)) assert.ok(ids.includes(id), `${id} fetched after the mid-run since`);
  assert.ok(ids.includes(run.made[0]), 'since is inclusive (the app drops ids it has)');

  // Paging: limit, oldest first, `more` while the page is full.
  const p1 = (await getJson(env, '/api/items?since=0&limit=3')).body;
  assert.equal(p1.items.length, 3); assert.equal(p1.more, true);
  const p2 = (await getJson(env, `/api/items?since=${p1.items[2].created_at}&limit=3`)).body;
  assert.deepEqual(p2.items.map((x: any) => x.id), all.items.slice(2).map((x: any) => x.id));
  assert.equal(p2.more, false);

  // S5: the run is reported in /api/status.
  const { body: st } = await getJson(env, '/api/status');
  assert.deepEqual(st.lastRun.made, run.made);
  assert.deepEqual(st.lastRun.skipped, []);
  assert.equal(st.generated.clip, 1);
  assert.equal(st.claude.input, 4000);
  assert.equal(st.claude.inputLimit, 2000000);
  assert.equal(tts.calls, 1, 'the new clip was voiced');
});

test('S2: the monthly Claude budget stops writing', async () => {
  const env = makeEnv({ CLAUDE_MONTHLY_INPUT_TOKENS: '1000' });
  const claude = fakeClaude(ok);
  deps.claude = () => claude;
  assert.equal((await call(env, '/api/generate', { method: 'POST', body: { kind: 'article' } })).status, 200);
  const r = await getJson(env, '/api/generate', { method: 'POST', body: { kind: 'article' } });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Claude budget is used up/);
  assert.equal(claude.calls.length, 1);
  const { body: st } = await getJson(env, '/api/status');
  assert.deepEqual([st.claude.input, st.claude.output, st.claude.inputLimit, st.claude.outputLimit], [1000, 500, 1000, 300000]);
});

test('S2: failed replies count their tokens; 2 failures per kind per day, then that kind is skipped', async () => {
  const env = makeEnv();
  let i = 0;
  const claude = fakeClaude(() => {
    i++;
    if (i === 1) return { stop_reason: 'max_tokens', text: '{"title": "Cut' };
    throw new Error('API down'); // no reply: no usage
  });
  deps.claude = () => claude;
  const a = await getJson(env, '/api/generate', { method: 'POST', body: { kind: 'cards' } });
  assert.equal(a.status, 502); assert.match(a.body.error, /cut off/);
  const b = await getJson(env, '/api/generate', { method: 'POST', body: { kind: 'cards' } });
  assert.equal(b.status, 502); assert.match(b.body.error, /API down/);
  const c = await getJson(env, '/api/generate', { method: 'POST', body: { kind: 'cards' } });
  assert.equal(c.status, 429); assert.match(c.body.error, /failed 2 times today/);
  assert.equal(claude.calls.length, 2);
  const { body: st } = await getJson(env, '/api/status');
  assert.equal(st.claude.input, 1000, 'the cut-off reply was counted, the API error was not');
  const rows = env.DB.sqlite.prepare('SELECT kind, ok, error FROM attempts').all();
  assert.equal(rows.length, 2);

  // The nightly run skips cards for the rest of the day, and says so.
  const run = (await getJson(env, '/api/topup', { method: 'POST' })).body;
  assert.deepEqual(run.made, []);
  assert.match(run.skipped.join(), /^cards: /);
  assert.equal(claude.calls.length, 2);
  // And a manual top-up runs at most once per 10 minutes.
  const again = await getJson(env, '/api/topup', { method: 'POST' });
  assert.equal(again.status, 429); assert.match(again.body.error, /10 minutes/);
});

test('S2: a reply that does not match the schema still counts its tokens', async () => {
  const env = makeEnv();
  deps.claude = () => fakeClaude(() => ({ text: '{"nope": 1}' }));
  const r = await getJson(env, '/api/generate', { method: 'POST', body: { kind: 'scene' } });
  assert.equal(r.status, 502); assert.match(r.body.error, /schema/);
  assert.equal((await getJson(env, '/api/status')).body.claude.output, 500);
});

test('S3: one writer at a time (409), cron skips, an expired lease is taken over', async () => {
  const env = makeEnv();
  const claude = fakeClaude(async (params) => { await sleep(20); return ok(params); });
  deps.claude = () => claude;
  // Two requests at once: one writes, the other is told to wait.
  const [a, b] = await Promise.all([
    call(env, '/api/generate', { method: 'POST', body: { kind: 'article' } }),
    call(env, '/api/generate', { method: 'POST', body: { kind: 'scene' } }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.match(((await (a.status === 409 ? a : b).json()) as any).error, /Already writing new content/);
  assert.equal(claude.calls.length, 1);

  const owner = await db.acquireLock(env.DB);
  assert.ok(owner);
  assert.equal((await call(env, '/api/generate', { method: 'POST', body: { kind: 'scene' } })).status, 409);
  assert.equal((await call(env, '/api/topup', { method: 'POST' })).status, 409);
  const c = ctx();
  await worker.scheduled({} as any, env, c);
  await Promise.all(c.pending);
  assert.equal(claude.calls.length, 1, 'cron skipped');
  assert.equal(await db.getState(env.DB, 'lastRun'), null);
  await db.releaseLock(env.DB, owner!);

  // A lease left by a crashed run expires.
  assert.ok(await db.acquireLock(env.DB, Date.now() - db.LEASE_MS - 1000));
  assert.equal((await call(env, '/api/generate', { method: 'POST', body: { kind: 'scene' } })).status, 200);
  const c2 = ctx();
  await worker.scheduled({} as any, env, c2);
  await Promise.all(c2.pending);
  assert.ok(await db.getState(env.DB, 'lastRun'), 'cron ran once the lock was free');
});

test('S3: the voice budget is reserved atomically and refunded on failure', async () => {
  const clip = BUILTIN.clips.clips.find((c: any) => c.segments.length >= 2);
  const [l0, l1] = [clip.segments[0].text.length, clip.segments[1].text.length];
  const limit = Math.max(l0, l1) + Math.min(l0, l1) - 1; // either fits, not both
  const env = makeEnv({ TTS_MONTHLY_CHARS: String(limit) });
  const [a, b] = await Promise.all([call(env, `/api/audio/${clip.id}/0`), call(env, `/api/audio/${clip.id}/1`)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  assert.equal(tts.calls, 1);
  const used = (await getJson(env, '/api/status')).body.usage.tts_chars;
  assert.ok(used <= limit && used > 0, `${used} <= ${limit}`);

  const env2 = makeEnv();
  tts.status = 500;
  assert.equal((await call(env2, `/api/audio/${clip.id}/0`)).status, 502);
  assert.equal((await getJson(env2, '/api/status')).body.usage.tts_chars, 0, 'refunded');
});

test('S4: audio by segment hash (immutable), 409 on a stale hash, old route not cached', async () => {
  const env = makeEnv();
  const clip = BUILTIN.clips.clips[1];
  const h = segHash(clip.segments[0].text, TTS_MODEL);
  const good = await call(env, `/api/audio/${clip.id}/0/${h}`);
  assert.equal(good.status, 200);
  assert.match(good.headers.get('Cache-Control')!, /immutable/);
  assert.equal(good.headers.get('Content-Type'), 'audio/mpeg');
  const stale = await call(env, `/api/audio/${clip.id}/0/deadbeef`);
  assert.equal(stale.status, 409);
  const old = await call(env, `/api/audio/${clip.id}/0`);
  assert.equal(old.status, 200);
  assert.match(old.headers.get('Cache-Control')!, /no-cache/);
  assert.equal(tts.calls, 1, 'voiced once, then from KV');
  assert.equal((await call(env, '/api/audio/no-such-clip/0')).status, 404);
});

test('S4: the app hashes segments the same way (js/listen.js)', () => {
  const src = readFileSync(new URL('../../js/listen.js', import.meta.url), 'utf8');
  assert.ok(src.includes('fnv1a(`${seg.text}\\u0000${TTS_MODEL}\\u0000${JSON.stringify(VOICE_SETTINGS)}`)'), 'segHash input');
  assert.ok(src.includes(`const VOICE_SETTINGS = { stability: ${VOICE_SETTINGS.stability}, similarity_boost: ${VOICE_SETTINGS.similarity_boost}, style: ${VOICE_SETTINGS.style}, speed: 1.0 };`), 'voice settings');
  assert.ok(src.includes(`'${TTS_MODEL}'`), 'TTS model');
});

test('S8: hiding an item', async () => {
  const env = makeEnv();
  deps.claude = () => fakeClaude(ok);
  const { body } = await getJson(env, '/api/generate', { method: 'POST', body: { kind: 'clip' } });
  const { id, created_at } = body.item;
  assert.equal((await call(env, `/api/audio/${id}/0`)).status, 200);

  assert.equal((await call(env, '/api/items/no-such-item', { method: 'DELETE' })).status, 404);
  assert.equal((await call(env, `/api/items/${id}`, { method: 'DELETE' })).status, 200);

  // An app that has it gets the hide; an app that never had it doesn't get it at all.
  const had = (await getJson(env, `/api/items?since=${created_at}`)).body.items;
  assert.deepEqual(had, [{ id, kind: 'clip', created_at, hidden: true }]);
  assert.deepEqual((await getJson(env, '/api/items?since=0')).body.items, []);
  assert.equal((await getJson(env, '/api/status')).body.generated.clip, 0);
  assert.equal((await call(env, `/api/audio/${id}/0`)).status, 404);
});

test('profile: size limit and only known event fields', async () => {
  const env = makeEnv();
  const big = await call(env, '/api/profile', { method: 'PUT', body: {}, headers: { 'Content-Length': '2000000' } });
  assert.equal(big.status, 413);
  const events = [
    { at: 1, item: 'clip:x'.padEnd(100, 'x'), topics: ['food', 7, 'a'.repeat(30), 'b', 'c', 'd', 'e', 'f'], type: 'rate', w: 1, skill: 'listen', d: 3, perf: 0.5, secret: 'drop me' },
    { at: 'nope', item: 'x' },
    { at: 2, w: 'x', d: Infinity },
  ];
  assert.equal((await call(env, '/api/profile', { method: 'PUT', body: { events, used: ['clip:x', 3], mistakes: [] } })).status, 200);
  const p: any = await db.getState(env.DB, 'profile');
  assert.equal(p.events.length, 2);
  assert.deepEqual(Object.keys(p.events[0]).sort(), ['at', 'd', 'item', 'perf', 'skill', 'topics', 'type', 'w']);
  assert.equal(p.events[0].item.length, 80);
  assert.deepEqual(p.events[0].topics, ['food', 'a'.repeat(24), 'b', 'c', 'd', 'e']);
  assert.deepEqual(p.events[1], { at: 2 });
  assert.deepEqual(p.used, ['clip:x']);
});
