// Tests for js/recommend.js (personal picks). Run: node --test tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as rec from '../js/recommend.js';

const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 26, 12);
const ev = (daysAgo, e) => ({ at: NOW - daysAgo * DAY, ...e });

describe('levels on a number line', () => {
  test('CEFR labels and ranges', () => {
    assert.equal(rec.levelNum('B1'), 3);
    assert.equal(rec.levelNum('B1–B2'), 3.5);
    assert.equal(rec.levelNum('B2'), 4);
    assert.equal(rec.levelNum(undefined), 3);
    assert.equal(rec.levelLabel(3), 'B1');
    assert.equal(rec.levelLabel(3.5), 'B1–B2');
    assert.equal(rec.levelLabel(3.9), 'B2');
  });
});

describe('interest profile', () => {
  test('liked topics rise, disliked fall, old signals fade', () => {
    const p = rec.interestProfile([
      ev(1, { topics: ['food'], w: 1 }),
      ev(1, { topics: ['food'], w: 0.4 }),
      ev(1, { topics: ['work'], w: -1 }),
      ev(120, { topics: ['travel'], w: 1 }),
    ], NOW);
    assert.ok(p.food.mean > 0.65, `food ${p.food.mean}`);
    assert.ok(p.work.mean < 0.4, `work ${p.work.mean}`);
    // 120 days = almost 6 half-lives: hardly any weight left.
    assert.ok(p.travel.n < 0.05 && Math.abs(p.travel.mean - 0.5) < 0.02);
  });

  test('half-life is three weeks', () => {
    assert.ok(Math.abs(rec.decay(21 * DAY) - 0.5) < 1e-9);
  });
});

describe('level estimate', () => {
  test('starts at B1-ish and moves with results', () => {
    assert.deepEqual(rec.levels([]), rec.START_LEVELS);
    const good = Array.from({ length: 8 }, (_, i) => ev(10 - i, { skill: 'listen', d: 3.5, perf: 1 }));
    assert.ok(rec.levels(good).listen > rec.START_LEVELS.listen + 0.5);
    const bad = Array.from({ length: 8 }, (_, i) => ev(10 - i, { skill: 'listen', d: 3, perf: 0.2 }));
    assert.ok(rec.levels(bad).listen < rec.START_LEVELS.listen - 0.5);
    assert.equal(rec.levels(good).read, rec.START_LEVELS.read, 'skills are separate');
  });
});

const items = [
  { key: 'clip:food1', topics: ['food'], d: 3 },
  { key: 'clip:food2', topics: ['food'], d: 3.5 },
  { key: 'clip:work1', topics: ['work'], d: 3 },
  { key: 'clip:work2', topics: ['work'], d: 3.5 },
  { key: 'clip:health', topics: ['health'], d: 3 },
  { key: 'clip:culture', topics: ['culture'], d: 3 },
  { key: 'clip:hard', topics: ['food'], d: 5 },
];

describe('pick', () => {
  test('stable for the same day and inputs', () => {
    const a = rec.pick(items, { skill: 'listen', seed: '2026-11-26', now: NOW });
    const b = rec.pick(items, { skill: 'listen', seed: '2026-11-26', now: NOW });
    assert.deepEqual(a, b);
    assert.equal(a.length, 3);
    assert.ok(a.every((x) => typeof x.reason === 'string' && x.reason));
  });

  test('steers toward liked topics and away from disliked ones over many days', () => {
    const events = [
      ev(2, { item: 'clip:x', topics: ['food'], type: 'rate', w: 1 }),
      ev(5, { item: 'clip:y', topics: ['food'], type: 'finish', w: 0.4 }),
      ev(3, { item: 'clip:z', topics: ['work'], type: 'rate', w: -1 }),
      ev(4, { item: 'clip:q', topics: ['work'], type: 'abandon', w: -0.3 }),
      // health and culture already covered recently, so no must-cover boost or novelty
      ev(1, { item: 'clip:h0', topics: ['health', 'culture'], type: 'finish', w: 0.0001 }),
    ];
    const count = { food: 0, work: 0 };
    for (let i = 0; i < 200; i++) {
      const [first] = rec.pick(items, { events, skill: 'listen', seed: `d${i}`, now: NOW });
      const t = items.find((x) => x.key === first.key).topics[0];
      if (t in count) count[t]++;
    }
    assert.ok(count.food > count.work * 3, JSON.stringify(count));
  });

  test('explores: a new topic still leads sometimes', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(i + 3, { item: `clip:f${i}`, topics: ['food'], type: 'rate', w: 1 }));
    let explored = 0;
    for (let i = 0; i < 200; i++) {
      const [first] = rec.pick(items, { events, skill: 'listen', seed: `e${i}`, now: NOW });
      if (first.reason.startsWith('Something new')) explored++;
    }
    assert.ok(explored > 20 && explored < 90, `explored ${explored}/200`);
  });

  test('items far above your level are rarely first', () => {
    let hard = 0;
    for (let i = 0; i < 100; i++) if (rec.pick(items, { skill: 'listen', seed: `h${i}`, now: NOW })[0].key === 'clip:hard') hard++;
    assert.ok(hard < 5, `hard first ${hard}/100`);
  });

  test('something done yesterday is not picked again; a hard one comes back later', () => {
    const events = [ev(1, { item: 'clip:food1', topics: ['food'], type: 'finish', w: 0.4 })];
    for (let i = 0; i < 30; i++) assert.notEqual(rec.pick(items, { events, skill: 'listen', seed: `y${i}`, now: NOW })[0].key, 'clip:food1');
    const extraHistory = { 'clip:work1': { lastAt: NOW - 5 * DAY, perf: 0.4 } };
    const all = Array.from({ length: 50 }, (_, i) => rec.pick(items, { skill: 'listen', seed: `r${i}`, now: NOW, extraHistory, count: 7 }));
    const retry = all.flat().find((x) => x.key === 'clip:work1');
    assert.match(retry.reason, /hard last time/);
  });

  test('a practical topic not seen for two weeks gets a nudge', () => {
    const its = [{ key: 'scene:doctor', topics: ['health'], d: 3 }, { key: 'scene:bar', topics: ['food'], d: 3 }];
    const events = [ev(1, { item: 'x', topics: ['food'], type: 'rate', w: 0.2 })];
    const got = rec.pick(its, { events, skill: 'speak', seed: 'm', now: NOW });
    assert.ok(got.some((g) => g.key === 'scene:doctor' && /Practical for Italy: health/.test(g.reason)), JSON.stringify(got));
    const later = rec.pick(its, { events: [...events, ev(20, { item: 'scene:old', topics: ['health'], type: 'finish', w: 0.4 })], skill: 'speak', seed: 'm', now: NOW });
    assert.ok(later.some((g) => g.key === 'scene:doctor' && /Health hasn't come up for two weeks/.test(g.reason)), JSON.stringify(later));
  });

  test('a topic liked in the last days is followed up (topic weeks)', () => {
    const events = [ev(1, { item: 'clip:food1', topics: ['food'], type: 'rate', w: 1 })];
    const got = rec.pick(items, { events, skill: 'listen', seed: 'tw', now: NOW, count: 7 });
    assert.ok(got.some((g) => g.key === 'clip:food2' && /Staying with food/.test(g.reason)), JSON.stringify(got));
  });
});

describe('signals', () => {
  test('call weight: quick exit is negative, a full chat positive', () => {
    assert.ok(rec.callWeight({ seconds: 40, maxMinutes: 10, yourTurns: 2 }) < 0);
    assert.ok(rec.callWeight({ seconds: 600, maxMinutes: 10, yourTurns: 30 }) > 0.7);
    assert.ok(rec.callWeight({ seconds: 200, maxMinutes: 10, yourTurns: 8 }) < rec.callWeight({ seconds: 500, maxMinutes: 10, yourTurns: 8 }));
  });

  test('weighted card order favours liked topics but keeps everything', () => {
    const cards = [{ id: 1, topics: ['food'] }, { id: 2, topics: ['work'] }];
    const events = [ev(1, { topics: ['food'], w: 1 }), ev(1, { topics: ['food'], w: 1 }), ev(1, { topics: ['work'], w: -1 })];
    let foodFirst = 0;
    for (let i = 0; i < 400; i++) {
      const out = rec.weightedOrder(cards, events, rec.rng(`c${i}`), NOW);
      assert.equal(out.length, 2);
      if (out[0].id === 1) foodFirst++;
    }
    assert.ok(foodFirst > 230 && foodFirst < 380, `food first ${foodFirst}/400`);
  });
});
