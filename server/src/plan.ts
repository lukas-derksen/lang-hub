// What to generate next, and about what. Pure functions (tested in test/plan.test.ts).
// The interest and level model is shared with the app: js/recommend.js.
import * as rec from '../../js/recommend.js';

export type Kind = 'article' | 'clip' | 'scene' | 'cards';
export type Ev = { at: number; item?: string; topics?: string[]; type?: string; w?: number; skill?: string; d?: number; perf?: number };
export type Profile = {
  events: Ev[];
  used: string[];                       // item keys you already did ('clip:x', 'article:y', 'scene:z')
  mistakes: { at: number; category: string }[];
  updatedAt?: number;
};
export type Caps = Record<Kind, number>;

const DAY = 864e5;
export const SKILL_OF: Record<Kind, 'listen' | 'read' | 'speak'> = { clip: 'listen', article: 'read', scene: 'speak', cards: 'speak' };
// Keep this many items of each kind waiting that you haven't done yet.
export const TARGET_UNUSED: Record<Exclude<Kind, 'cards'>, number> = { clip: 3, article: 2, scene: 2 };

/**
 * Kinds to generate now, at most one of each per run (the daily cron fills up over days).
 * existing: every item key per kind (built-in and generated); made: generated items with dates.
 */
export function topUp({ existing, made, used, caps, now }: {
  existing: Record<Kind, string[]>; made: { kind: Kind; created_at: number }[]; used: Set<string>; caps: Caps; now: number;
}): Kind[] {
  const out: Kind[] = [];
  const thisWeek = (k: Kind) => made.filter((m) => m.kind === k && now - m.created_at < 7 * DAY).length;
  for (const k of ['clip', 'article', 'scene'] as const) {
    const unused = existing[k].filter((key) => !used.has(key)).length;
    if (unused < TARGET_UNUSED[k] && thisWeek(k) < caps[k]) out.push(k);
  }
  if (caps.cards > 0 && thisWeek('cards') < caps.cards && !made.some((m) => m.kind === 'cards' && now - m.created_at < 7 * DAY)) out.push('cards');
  return out;
}

/**
 * The topic for a new item: mostly what you enjoy (Thompson sampling over topics),
 * sometimes something you know little about, and practical topics when they're due.
 */
export function chooseTopic(events: Ev[], now: number, r: () => number): { topic: string; why: string } {
  const topics = Object.keys(rec.TOPICS);
  const lastSeen: Record<string, number> = {};
  for (const e of events) if (e.type !== 'skip') for (const t of e.topics || []) lastSeen[t] = Math.max(lastSeen[t] || 0, e.at);
  const due = rec.MUST_COVER.filter((t: string) => now - (lastSeen[t] || 0) > rec.MUST_COVER_DAYS * DAY);
  if (due.length && r() < 0.5) return { topic: due[Math.floor(r() * due.length)], why: 'practical' };
  const prof = rec.interestProfile(events, now) as Record<string, { a: number; b: number; n: number; mean: number }>;
  if (r() < rec.EXPLORE_RATE) {
    const least = [...topics].sort((a, b) => (prof[a]?.n || 0) - (prof[b]?.n || 0) || r() - 0.5);
    return { topic: least[0], why: 'explore' };
  }
  let best = topics[0], bestV = -1;
  for (const t of topics) {
    const x = prof[t] || { a: 1, b: 1 };
    const v = rec.betaSample(x.a, x.b, r);
    if (v > bestV) { bestV = v; best = t; }
  }
  return { topic: best, why: 'interest' };
}

/** The level to write at for a skill: slightly above your current estimate. */
export function targetLevel(events: Ev[], kind: Kind): string {
  const L = (rec.levels(events) as Record<string, number>)[SKILL_OF[kind]] ?? 3;
  return rec.levelLabel(L + 0.25);
}

/** Your most frequent mistake categories in the last 30 days (to weave into new content). */
export function focusCategories(mistakes: Profile['mistakes'], now: number, n = 3): string[] {
  const count: Record<string, number> = {};
  for (const m of mistakes) if (now - m.at < 30 * DAY && m.category && m.category !== 'other') count[m.category] = (count[m.category] || 0) + 1;
  return Object.entries(count).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([c]) => c);
}

export const topicLabel = (t: string): string => rec.topicLabel(t);
export const rng = (seed: string): (() => number) => rec.rng(seed);

/**
 * The profile the app syncs (PUT /api/profile), reduced to known fields with sane sizes.
 * Events keep only { at, item, topics, type, w, skill, d, perf } (see js/store.js logEvent);
 * anything else, or of the wrong type, is dropped.
 */
export function cleanProfile(body: any, now: number): Profile {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const events: Ev[] = [];
  for (const e of (Array.isArray(body?.events) ? body.events : []).slice(-3000)) {
    if (!e || typeof e !== 'object' || num(e.at) === undefined) continue;
    const ev: Ev = { at: e.at };
    const item = str(e.item, 80), type = str(e.type, 16), skill = str(e.skill, 8);
    if (item !== undefined) ev.item = item;
    if (Array.isArray(e.topics)) ev.topics = e.topics.filter((t: unknown) => typeof t === 'string').slice(0, 6).map((t: string) => t.slice(0, 24));
    if (type !== undefined) ev.type = type;
    if (num(e.w) !== undefined) ev.w = e.w;
    if (skill !== undefined) ev.skill = skill;
    if (num(e.d) !== undefined) ev.d = e.d;
    if (num(e.perf) !== undefined) ev.perf = e.perf;
    events.push(ev);
  }
  return {
    events,
    used: (Array.isArray(body?.used) ? body.used : []).filter((x: unknown) => typeof x === 'string').slice(-2000).map((x: string) => x.slice(0, 120)),
    mistakes: (Array.isArray(body?.mistakes) ? body.mistakes : []).slice(0, 500).map((m: any) => ({ at: Number(m?.at) || 0, category: String(m?.category || '').slice(0, 40) })),
    updatedAt: now,
  };
}
