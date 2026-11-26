// Run: npm test (Node 22+, strips the types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topUp, chooseTopic, targetLevel, focusCategories, rng } from '../src/plan.ts';
import { finish } from '../src/generate.ts';

const DAY = 864e5, NOW = Date.UTC(2026, 10, 26);
const caps = { clip: 3, article: 2, scene: 1, cards: 1 };
const keys = (kind: string, n: number) => Array.from({ length: n }, (_, i) => `${kind}:${i}`);

test('top-up: makes what is running low, within the weekly budget', () => {
  const existing = { clip: keys('clip', 10), article: keys('article', 4), scene: keys('scene', 7), cards: [] };
  const used = new Set([...keys('clip', 9), ...keys('article', 1)]);
  assert.deepEqual(topUp({ existing, made: [], used, caps, now: NOW }), ['clip', 'cards']);
  const made = [0, 1, 2].map((d) => ({ kind: 'clip' as const, created_at: NOW - d * DAY }));
  assert.deepEqual(topUp({ existing, made: [...made, { kind: 'cards', created_at: NOW - 2 * DAY }], used, caps, now: NOW }), []);
  assert.deepEqual(topUp({ existing, made: made.map((m) => ({ ...m, created_at: m.created_at - 8 * DAY })), used, caps, now: NOW }), ['clip', 'cards']);
});

test('topic choice follows interest, explores, and covers practical topics', () => {
  const events = Array.from({ length: 12 }, (_, i) => ({ at: NOW - i * DAY, item: `clip:${i}`, topics: ['food', 'health', 'services', 'travel', 'home'].slice(0, i % 2 ? 1 : 5), type: 'rate', w: i % 2 ? 1 : 0.01 }));
  const count: Record<string, number> = {};
  for (let i = 0; i < 300; i++) { const t = chooseTopic(events, NOW, rng(`t${i}`)).topic; count[t] = (count[t] || 0) + 1; }
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(top, 'food', JSON.stringify(count));
  assert.ok(Object.keys(count).length >= 5, 'other topics still come up');
  const fresh = chooseTopic([], NOW, () => 0.1);
  assert.equal(fresh.why, 'practical');
});

test('level and focus', () => {
  assert.equal(targetLevel([], 'article'), 'B1–B2');
  assert.equal(targetLevel([], 'clip'), 'B1');
  const m = [{ at: NOW - DAY, category: 'congiuntivo' }, { at: NOW - 2 * DAY, category: 'congiuntivo' }, { at: NOW - DAY, category: 'articoli' }, { at: NOW - 40 * DAY, category: 'preposizioni' }, { at: NOW - 41 * DAY, category: 'preposizioni' }];
  assert.deepEqual(focusCategories(m, NOW), ['congiuntivo']);
});

test('finish: clip dictation must come from the clip, bad answers dropped', () => {
  const b = { kind: 'clip' as const, topic: 'food', level: 'B1', focus: [], avoidTitles: [] };
  const raw = {
    title: 'Al forno', genre: 'Dialogue', level: 'B1',
    segments: [{ voice: 'paolo', text: 'Buongiorno! Vorrei un chilo di pane, quello integrale con i semi. Ce l\'ha ancora?' }],
    questions: [{ q: 'Cosa vuole?', options: ['pane', 'latte'], answer: 0 }, { q: 'Quanto?', options: ['un chilo', 'due'], answer: 0 }, { q: 'x', options: ['a'], answer: 3 }],
    dictation: 'Not in the clip at all',
  };
  const { id, data } = finish('clip', raw, b, NOW);
  assert.match(id, /^g261126-al-forno$/);
  assert.equal(data.questions.length, 2);
  assert.ok(raw.segments[0].text.includes(data.dictation), data.dictation);
  assert.deepEqual(data.topics, ['food']);
});

test('finish: article glossary becomes pairs like the built-in articles', () => {
  const b = { kind: 'article' as const, topic: 'work', level: 'B1–B2', focus: [], avoidTitles: [] };
  const raw = { title: 'Smart working', topic_label: 'Lavoro', level: 'B1–B2', minutes: 5, paragraphs: ['a', 'b', 'c'], glossary: ['w1', 'w2', 'w3', 'w4'].map((w) => ({ word: w, meaning: 'm' })), discussion: ['x'] };
  const { data } = finish('article', raw, b, NOW);
  assert.deepEqual(data.glossary[0], ['w1', 'm']);
  assert.equal(data.topic, 'Lavoro');
});
