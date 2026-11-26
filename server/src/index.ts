// Lang Hub content server: writes new articles, clips, scenes and cards that fit
// your interests and level, voices clips once, and serves both to the app.
// Single user: every /api route except /api/health needs the app password
// (LANGHUB_APP_TOKEN) as a bearer token.
import { BUILTIN, write, finish, WriteError, type Brief } from './generate.ts';
import { topUp, chooseTopic, targetLevel, focusCategories, cleanProfile, rng, type Kind, type Caps } from './plan.ts';
import { audioKey, segHash, voice, TtsError } from './tts.ts';
import { deps } from './deps.ts';
import * as db from './db.ts';

export interface Env {
  DB: D1Database;
  AUDIO: KVNamespace;
  APP_TOKEN: string;          // secret: the app password
  ANTHROPIC_API_KEY: string;  // secret
  ELEVENLABS_TTS_KEY: string; // secret: text to speech only
  ALLOWED_ORIGINS: string;
  MODEL: string;
  TTS_MODEL: string;
  CLIPS_PER_WEEK: string; ARTICLES_PER_WEEK: string; SCENES_PER_WEEK: string; CARD_BATCHES_PER_WEEK: string;
  TTS_MONTHLY_CHARS: string;
  CLAUDE_MONTHLY_INPUT_TOKENS: string; CLAUDE_MONTHLY_OUTPUT_TOKENS: string;
}

const KINDS: Kind[] = ['article', 'clip', 'scene', 'cards'];
const LABEL: Record<Kind, string> = { article: 'articles', clip: 'clips', scene: 'scenes', cards: 'card batches' };
const MAX_FAILS_PER_DAY = 2;        // failed Claude attempts per kind per UTC day, then skip it
const TOPUP_EVERY = 10 * 60e3;      // POST /api/topup at most this often
const PROFILE_MAX = 1_500_000;      // bytes
const BUSY = 'Already writing new content, try again in a few minutes';

/** A reason not to write now (budget used up, too many failures): skipped, not an error. */
class SkipError extends Error {}

// ---------- http helpers ----------
function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const ok = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : { Vary: 'Origin' };
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function sha256(s: string): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
/** Constant-time check of the bearer token against APP_TOKEN. */
async function authorized(req: Request, env: Env): Promise<boolean> {
  if (!env.APP_TOKEN || env.APP_TOKEN.length < 16) return false; // never run open
  const got = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const [a, b] = await Promise.all([sha256(got), sha256(env.APP_TOKEN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && got.length > 0;
}

const caps = (env: Env): Caps => ({
  clip: Number(env.CLIPS_PER_WEEK) || 0, article: Number(env.ARTICLES_PER_WEEK) || 0,
  scene: Number(env.SCENES_PER_WEEK) || 0, cards: Number(env.CARD_BATCHES_PER_WEEK) || 0,
});
const claudeLimits = (env: Env) => ({ input: Number(env.CLAUDE_MONTHLY_INPUT_TOKENS) || 2_000_000, output: Number(env.CLAUDE_MONTHLY_OUTPUT_TOKENS) || 300_000 });

/** Runs fn while holding the writing lease; null when another run holds it. */
async function withLock<T>(env: Env, fn: (owner: string) => Promise<T>): Promise<T | null> {
  const owner = await db.acquireLock(env.DB);
  if (!owner) return null;
  try { return await fn(owner); } finally { await db.releaseLock(env.DB, owner); }
}

// ---------- clips and audio ----------
async function findClip(env: Env, id: string): Promise<any> {
  return BUILTIN.clips.clips.find((c: any) => c.id === id) || (await db.getClip(env.DB, id));
}
const voiceIdOf = (key: string) => BUILTIN.clips.voices[key]?.id as string | undefined;

/** Audio for one clip segment: from KV, or voiced now (within the monthly budget) and stored. */
async function segmentAudio(env: Env, clip: any, i: number): Promise<ArrayBuffer> {
  const seg = clip.segments?.[i];
  const vid = seg && voiceIdOf(seg.voice);
  if (!seg || !vid) throw new TtsError('No such segment', 404);
  const key = audioKey(clip.id, i, vid, seg.text, env.TTS_MODEL);
  const hit = await env.AUDIO.get(key, 'arrayBuffer');
  if (hit) return hit;
  // Reserve the characters first (atomic), so two requests at once can't both pass the budget.
  const chars = seg.text.length;
  const m = await db.reserve(env.DB, 'tts_chars', chars, Number(env.TTS_MONTHLY_CHARS) || 0);
  if (!m) throw new TtsError('The server\'s voice budget for this month is used up.', 429);
  let buf: ArrayBuffer;
  try { buf = await voice(env.ELEVENLABS_TTS_KEY, vid, seg.text, env.TTS_MODEL); } catch (e) { await db.refund(env.DB, m, 'tts_chars', chars); throw e; }
  await env.AUDIO.put(key, buf);
  return buf;
}

// ---------- generation ----------
/** Throws SkipError when this kind shouldn't be written now. */
async function checkCanWrite(env: Env, kind: Kind): Promise<void> {
  const u = await db.usageThisMonth(env.DB), lim = claudeLimits(env);
  if ((u.claude_input || 0) >= lim.input || (u.claude_output || 0) >= lim.output) {
    throw new SkipError(`This month's Claude budget is used up (${u.claude_input || 0}/${lim.input} input, ${u.claude_output || 0}/${lim.output} output tokens).`);
  }
  if ((await db.failuresToday(env.DB, kind)) >= MAX_FAILS_PER_DAY) {
    throw new SkipError(`Writing new ${LABEL[kind]} failed ${MAX_FAILS_PER_DAY} times today; trying again tomorrow.`);
  }
}

/** Write, check and store one item (the caller holds the lease). */
async function generate(env: Env, kind: Kind, now = Date.now()): Promise<db.Item> {
  await checkCanWrite(env, kind);
  const prof = await db.getProfile(env.DB);
  const r = rng(`${now}:${kind}`);
  const { topic } = chooseTopic(prof.events, now, r);
  const titles = [
    ...(kind === 'article' ? BUILTIN.articles : kind === 'clip' ? BUILTIN.clips.clips : kind === 'scene' ? BUILTIN.scenes : []).map((x: any) => x.title),
    ...(await db.recentTitles(env.DB, kind)),
  ];
  const brief: Brief = { kind, topic, level: targetLevel(prof.events, kind), focus: focusCategories(prof.mistakes, now), avoidTitles: titles };
  let item: { id: string; data: any };
  try {
    let out;
    try {
      out = await write(deps.claude(env.ANTHROPIC_API_KEY), env.MODEL, brief);
    } catch (e) {
      // A reply that didn't work out still cost tokens; an API error without a reply costs none.
      if (e instanceof WriteError && e.usage) { await db.addUsage(env.DB, 'claude_input', e.usage.input); await db.addUsage(env.DB, 'claude_output', e.usage.output); }
      throw e;
    }
    await db.addUsage(env.DB, 'claude_input', out.usage.input);
    await db.addUsage(env.DB, 'claude_output', out.usage.output);
    item = finish(kind, out.raw, brief, now);
  } catch (e) {
    await db.recordAttempt(env.DB, kind, false, message(e));
    throw e;
  }
  await db.recordAttempt(env.DB, kind, true);
  let { id, data } = item;
  for (let n = 2; await db.idTaken(env.DB, id); n++) id = `${data.id}-${n}`;
  data.id = id;
  const created_at = await db.insertItem(env.DB, id, kind, data);
  if (kind === 'clip') {
    // Voice it straight away so it's ready on every device (best effort: else on first play).
    for (let i = 0; i < data.segments.length; i++) { try { await segmentAudio(env, data, i); } catch (e) { console.log('voicing failed', id, i, String(e)); break; } }
  }
  return { id, kind, created_at, data };
}

export type RunResult = { at: number; made: string[]; errors: string[]; skipped: string[] };

/** Generate what you're running low on (see plan.topUp). The caller holds the lease. */
async function runTopUp(env: Env, owner: string, now = Date.now()): Promise<RunResult> {
  const prof = await db.getProfile(env.DB);
  const gen = await db.itemIndex(env.DB);
  const ids = (k: Kind) => gen.filter((g) => g.kind === k && !g.hidden).map((g) => g.id); // hidden ones don't count as waiting
  const existing = {
    clip: [...BUILTIN.clips.clips.map((c: any) => c.id), ...ids('clip')].map((id) => `clip:${id}`),
    article: [...BUILTIN.articles.map((c) => c.id), ...ids('article')].map((id) => `article:${id}`),
    scene: [...BUILTIN.scenes.map((c) => c.id), ...ids('scene')].map((id) => `scene:${id}`),
    cards: [],
  } as Record<Kind, string[]>;
  const kinds = topUp({ existing, made: gen.map((g) => ({ kind: g.kind, created_at: g.created_at })), used: new Set(prof.used), caps: caps(env), now });
  const made: string[] = [], errors: string[] = [], skipped: string[] = [];
  for (const k of kinds) {
    await db.renewLock(env.DB, owner);
    try { made.push((await generate(env, k, now)).id); } catch (e) { (e instanceof SkipError ? skipped : errors).push(`${k}: ${message(e)}`); }
  }
  await db.pruneAttempts(env.DB);
  const run = { at: Date.now(), made, errors, skipped };
  await db.setState(env.DB, 'lastRun', run);
  return run;
}

// ---------- routes ----------
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === '/api/health') return json({ ok: true });
  if (!(await authorized(req, env))) return json({ error: 'Wrong or missing app password.' }, 401);

  // New and changed items. Contract for the app (js/server.js):
  // - send since = the newest created_at you have (0 at first) and optionally limit (default 100, max 200);
  // - you get visible items with created_at >= since, oldest first (drop ids you already have),
  //   and items hidden since then as { id, kind, created_at, hidden: true }: drop those;
  // - when more is true the page was full: ask again with since = the newest created_at you now have.
  if (p === '/api/items' && req.method === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 100)));
    return json({ ...(await db.itemsSince(env.DB, since, limit)), now: Date.now() });
  }
  const hide = p.match(/^\/api\/items\/([\w-]+)$/);
  if (hide && req.method === 'DELETE') {
    // Hide a bad item on every device (it stays in the database).
    return (await db.hideItem(env.DB, hide[1])) ? json({ ok: true }) : json({ error: 'No such item' }, 404);
  }
  if (p === '/api/profile' && req.method === 'PUT') {
    if (Number(req.headers.get('Content-Length')) > PROFILE_MAX) return json({ error: 'Profile too large' }, 413);
    const text = await req.text();
    if (text.length > PROFILE_MAX) return json({ error: 'Profile too large' }, 413);
    let body: any;
    try { body = JSON.parse(text); } catch { return json({ error: 'Not JSON' }, 400); }
    await db.setState(env.DB, 'profile', cleanProfile(body, Date.now()));
    return json({ ok: true });
  }
  if (p === '/api/status' && req.method === 'GET') {
    const [usage, count, lastRun] = await Promise.all([db.usageThisMonth(env.DB), db.countByKind(env.DB), db.getState<RunResult>(env.DB, 'lastRun')]);
    const lim = claudeLimits(env);
    return json({
      ok: true, model: env.MODEL, usage, ttsLimit: Number(env.TTS_MONTHLY_CHARS) || 0,
      claude: { input: usage.claude_input || 0, output: usage.claude_output || 0, inputLimit: lim.input, outputLimit: lim.output },
      caps: caps(env), generated: Object.fromEntries(KINDS.map((k) => [k, count[k] || 0])), lastRun,
    });
  }
  if (p === '/api/topup' && req.method === 'POST') {
    const res = await withLock(env, async (owner) => {
      if (!(await db.rateOk(env.DB, 'topup:last', TOPUP_EVERY))) return json({ error: 'New content was checked less than 10 minutes ago, try again later.' }, 429);
      return json(await runTopUp(env, owner));
    });
    return res || json({ error: BUSY }, 409);
  }
  if (p === '/api/generate' && req.method === 'POST') {
    let kind: Kind;
    try { kind = (await req.json<any>()).kind; } catch { return json({ error: 'Not JSON' }, 400); }
    if (!KINDS.includes(kind)) return json({ error: 'Unknown kind' }, 400);
    if ((await db.madeSince(env.DB, kind, Date.now() - 7 * 864e5)) >= caps(env)[kind]) return json({ error: `This week's budget for new ${LABEL[kind]} is used up.` }, 429);
    const res = await withLock(env, async () => {
      try { return json({ item: await generate(env, kind) }); } catch (e) { return json({ error: message(e) }, e instanceof SkipError ? 429 : 502); }
    });
    return res || json({ error: BUSY }, 409);
  }
  // Clip audio. /api/audio/{clipId}/{i}/{hash}: hash = tts.segHash of the segment as the app
  // knows it; a stale hash gets 409, so the immutable cache only ever holds the right audio.
  // /api/audio/{clipId}/{i} (older app versions): same audio, but not cached as immutable.
  const m = p.match(/^\/api\/audio\/([\w-]+)\/(\d+)(?:\/([0-9a-f]{8}))?$/);
  if (m && req.method === 'GET') {
    const clip = await findClip(env, m[1]);
    if (!clip) return json({ error: 'No such clip' }, 404);
    const i = Number(m[2]), seg = clip.segments?.[i];
    if (m[3] && seg && m[3] !== segHash(seg.text, env.TTS_MODEL)) return json({ error: 'This clip has changed; reload it.' }, 409);
    try {
      const buf = await segmentAudio(env, clip, i);
      return new Response(buf, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': m[3] ? 'private, max-age=31536000, immutable' : 'private, no-cache' } });
    } catch (e) {
      const status = e instanceof TtsError ? (e.status === 429 || e.status === 404 ? e.status : 502) : 500;
      return json({ error: message(e) }, status);
    }
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const c = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    let res: Response;
    try { res = await route(req, env); } catch (e) { console.log('error', String(e)); res = json({ error: 'Server error' }, 500); }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(c)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Nightly top-up; skipped when a run (manual or the previous night's) still holds the lease.
    ctx.waitUntil(withLock(env, (owner) => runTopUp(env, owner))
      .then((r) => console.log('top-up', r ? JSON.stringify(r) : 'skipped: already running'))
      .catch((e) => console.log('top-up failed', String(e))));
  },
} satisfies ExportedHandler<Env>;
