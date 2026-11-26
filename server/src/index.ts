// Lang Hub content server: writes new articles, clips, scenes and cards that fit
// your interests and level, voices clips once, and serves both to the app.
// Single user: every /api route except /api/health needs the app password
// (LANGHUB_APP_TOKEN) as a bearer token.
import Anthropic from '@anthropic-ai/sdk';
import { BUILTIN, write, finish, type Brief } from './generate.ts';
import { topUp, chooseTopic, targetLevel, focusCategories, rng, type Kind, type Profile, type Caps } from './plan.ts';
import { audioKey, voice, TtsError } from './tts.ts';

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
}

type Item = { id: string; kind: Kind; created_at: number; data: any };
const KINDS: Kind[] = ['article', 'clip', 'scene', 'cards'];
const month = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

// ---------- http helpers ----------
function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const ok = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : { Vary: 'Origin' };
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

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

// ---------- storage ----------
async function getProfile(env: Env): Promise<Profile> {
  const row = await env.DB.prepare('SELECT value FROM state WHERE key = ?').bind('profile').first<{ value: string }>();
  const p = row ? JSON.parse(row.value) : {};
  return { events: Array.isArray(p.events) ? p.events : [], used: Array.isArray(p.used) ? p.used : [], mistakes: Array.isArray(p.mistakes) ? p.mistakes : [], updatedAt: p.updatedAt };
}
async function addUsage(env: Env, kind: string, amount: number) {
  if (!amount) return;
  await env.DB.prepare('INSERT INTO usage (month, kind, amount) VALUES (?, ?, ?) ON CONFLICT(month, kind) DO UPDATE SET amount = amount + excluded.amount')
    .bind(month(), kind, Math.round(amount)).run();
}
async function usageThisMonth(env: Env): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare('SELECT kind, amount FROM usage WHERE month = ?').bind(month()).all<{ kind: string; amount: number }>();
  return Object.fromEntries(results.map((r) => [r.kind, r.amount]));
}
async function allItems(env: Env, since = 0): Promise<Item[]> {
  const { results } = await env.DB.prepare('SELECT id, kind, created_at, data FROM items WHERE created_at > ? ORDER BY created_at').bind(since).all<{ id: string; kind: Kind; created_at: number; data: string }>();
  return results.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

const caps = (env: Env): Caps => ({
  clip: Number(env.CLIPS_PER_WEEK) || 0, article: Number(env.ARTICLES_PER_WEEK) || 0,
  scene: Number(env.SCENES_PER_WEEK) || 0, cards: Number(env.CARD_BATCHES_PER_WEEK) || 0,
});

// ---------- clips and audio ----------
function findClip(id: string, generated: Item[]): any {
  return BUILTIN.clips.clips.find((c: any) => c.id === id) || generated.find((g) => g.kind === 'clip' && g.data.id === id)?.data;
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
  const used = (await usageThisMonth(env)).tts_chars || 0;
  if (used + seg.text.length > (Number(env.TTS_MONTHLY_CHARS) || 0)) throw new TtsError('The server\'s voice budget for this month is used up.', 429);
  const buf = await voice(env.ELEVENLABS_TTS_KEY, vid, seg.text, env.TTS_MODEL);
  await addUsage(env, 'tts_chars', seg.text.length);
  await env.AUDIO.put(key, buf);
  return buf;
}

// ---------- generation ----------
async function generate(env: Env, kind: Kind, now = Date.now()): Promise<Item> {
  const prof = await getProfile(env);
  const existing = await allItems(env);
  const r = rng(`${now}:${kind}`);
  const { topic } = chooseTopic(prof.events, now, r);
  const titles = [
    ...(kind === 'article' ? BUILTIN.articles : kind === 'clip' ? BUILTIN.clips.clips : kind === 'scene' ? BUILTIN.scenes : []).map((x: any) => x.title),
    ...existing.filter((x) => x.kind === kind).map((x) => x.data.title).filter(Boolean),
  ];
  const brief: Brief = { kind, topic, level: targetLevel(prof.events, kind), focus: focusCategories(prof.mistakes, now), avoidTitles: titles };
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const { raw, usage } = await write(client, env.MODEL, brief);
  await addUsage(env, 'claude_input', usage.input);
  await addUsage(env, 'claude_output', usage.output);
  let { id, data } = finish(kind, raw, brief, now);
  for (let n = 2; existing.some((x) => x.id === id); n++) { id = `${data.id}-${n}`; }
  data.id = id;
  await env.DB.prepare('INSERT INTO items (id, kind, created_at, data) VALUES (?, ?, ?, ?)').bind(id, kind, now, JSON.stringify(data)).run();
  if (kind === 'clip') {
    // Voice it straight away so it's ready on every device (best effort: else on first play).
    for (let i = 0; i < data.segments.length; i++) { try { await segmentAudio(env, data, i); } catch (e) { console.log('voicing failed', id, i, String(e)); break; } }
  }
  return { id, kind, created_at: now, data };
}

/** Generate what you're running low on (see plan.topUp). */
async function runTopUp(env: Env, now = Date.now()): Promise<{ made: string[]; errors: string[] }> {
  const prof = await getProfile(env);
  const gen = await allItems(env);
  const keyOf: Record<Kind, string> = { clip: 'clip', article: 'article', scene: 'scene', cards: 'cards' };
  const existing = {
    clip: [...BUILTIN.clips.clips.map((c: any) => c.id), ...gen.filter((g) => g.kind === 'clip').map((g) => g.id)].map((id) => `clip:${id}`),
    article: [...BUILTIN.articles.map((c) => c.id), ...gen.filter((g) => g.kind === 'article').map((g) => g.id)].map((id) => `article:${id}`),
    scene: [...BUILTIN.scenes.map((c) => c.id), ...gen.filter((g) => g.kind === 'scene').map((g) => g.id)].map((id) => `scene:${id}`),
    cards: [],
  } as Record<Kind, string[]>;
  const kinds = topUp({ existing, made: gen.map((g) => ({ kind: g.kind, created_at: g.created_at })), used: new Set(prof.used), caps: caps(env), now });
  const made: string[] = [], errors: string[] = [];
  for (const k of kinds) {
    try { made.push((await generate(env, keyOf[k] as Kind, now)).id); } catch (e) { errors.push(`${k}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { made, errors };
}

// ---------- routes ----------
async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === '/api/health') return json({ ok: true });
  if (!(await authorized(req, env))) return json({ error: 'Wrong or missing app password.' }, 401);

  if (p === '/api/items' && req.method === 'GET') {
    return json({ items: await allItems(env, Number(url.searchParams.get('since')) || 0), now: Date.now() });
  }
  if (p === '/api/profile' && req.method === 'PUT') {
    const text = await req.text();
    if (text.length > 1_500_000) return json({ error: 'Profile too large' }, 413);
    let body: any;
    try { body = JSON.parse(text); } catch { return json({ error: 'Not JSON' }, 400); }
    const profile: Profile = {
      events: (Array.isArray(body.events) ? body.events : []).slice(-3000),
      used: (Array.isArray(body.used) ? body.used : []).filter((x: unknown) => typeof x === 'string').slice(-2000),
      mistakes: (Array.isArray(body.mistakes) ? body.mistakes : []).slice(0, 500).map((m: any) => ({ at: Number(m.at) || 0, category: String(m.category || '').slice(0, 40) })),
      updatedAt: Date.now(),
    };
    await env.DB.prepare('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .bind('profile', JSON.stringify(profile), Date.now()).run();
    return json({ ok: true });
  }
  if (p === '/api/status' && req.method === 'GET') {
    const gen = await allItems(env);
    const count = Object.fromEntries(KINDS.map((k) => [k, gen.filter((g) => g.kind === k).length]));
    return json({ ok: true, model: env.MODEL, usage: await usageThisMonth(env), ttsLimit: Number(env.TTS_MONTHLY_CHARS) || 0, caps: caps(env), generated: count });
  }
  if (p === '/api/topup' && req.method === 'POST') return json(await runTopUp(env));
  if (p === '/api/generate' && req.method === 'POST') {
    let kind: Kind;
    try { kind = (await req.json<any>()).kind; } catch { return json({ error: 'Not JSON' }, 400); }
    if (!KINDS.includes(kind)) return json({ error: 'Unknown kind' }, 400);
    const weekAgo = Date.now() - 7 * 864e5;
    const madeThisWeek = (await allItems(env, weekAgo)).filter((g) => g.kind === kind).length;
    if (madeThisWeek >= caps(env)[kind]) return json({ error: `This week's budget for new ${kind}s is used up.` }, 429);
    try { return json({ item: await generate(env, kind) }); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
  }
  const m = p.match(/^\/api\/audio\/([\w-]+)\/(\d+)$/);
  if (m && req.method === 'GET') {
    const clip = findClip(m[1], await allItems(env));
    if (!clip) return json({ error: 'No such clip' }, 404);
    try {
      const buf = await segmentAudio(env, clip, Number(m[2]));
      return new Response(buf, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=31536000, immutable' } });
    } catch (e) {
      const status = e instanceof TtsError ? (e.status === 429 || e.status === 404 ? e.status : 502) : 500;
      return json({ error: e instanceof Error ? e.message : String(e) }, status);
    }
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const c = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    let res: Response;
    try { res = await route(req, env, ctx); } catch (e) { console.log('error', String(e)); res = json({ error: 'Server error' }, 500); }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(c)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runTopUp(env).then((r) => console.log('top-up', JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
