// Tests for js/store.js (and the scheduling in js/review.js), with Node's
// built-in runner: `node --test tests/`. No dependencies, no DOM.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// A time zone with DST, set before any Date is created.
process.env.TZ = 'Europe/Rome';

const KEY = 'langhub.v1';

class MemStorage {
  constructor() { this.m = new Map(); this.quota = Infinity; }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) {
    v = String(v);
    const used = [...this.m].reduce((a, [kk, vv]) => a + (kk === k ? 0 : vv.length), 0);
    if (used + v.length > this.quota) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
    this.m.set(k, v);
  }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

// store.js listens for `storage` events via the global addEventListener.
let storageHandlers = [];
globalThis.addEventListener = (type, fn) => { if (type === 'storage') storageHandlers.push(fn); };
const fireStorage = (key) => storageHandlers.forEach((fn) => fn({ key }));

let n = 0;
/** A fresh copy of store.js on a fresh localStorage, optionally seeded. */
async function fresh(seed = {}, { quota = Infinity } = {}) {
  globalThis.localStorage = new MemStorage();
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
  localStorage.quota = quota;
  storageHandlers = [];
  return import(`../js/store.js?fresh=${n++}`);
}

const stored = () => JSON.parse(localStorage.getItem(KEY));
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// 30 min goal on every day (reading days just move the speaking slot).
const met = { speak: 900, listen: 600, review: 300 };

describe('load', () => {
  test('corrupt JSON is copied aside before anything overwrites it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: at(2026, 3, 5) });
    const raw = '{"days": {"2026-03-01": {"speak": 6';
    const store = await fresh({ [KEY]: raw });
    assert.equal(localStorage.getItem(`${KEY}.corrupt-2026-03-05`), raw);
    const h = store.health();
    assert.equal(h.corrupt.key, `${KEY}.corrupt-2026-03-05`);
    assert.equal(h.corrupt.preserved, true);
    assert.deepEqual(store.get().days, {});
    store.addSeconds('2026-03-05', 'speak', 60);
    assert.equal(localStorage.getItem(`${KEY}.corrupt-2026-03-05`), raw, 'copy survives a save');
    assert.equal(stored().days['2026-03-05'].speak, 60);
    assert.deepEqual(store.corruptCopies(), [`${KEY}.corrupt-2026-03-05`]);
    assert.equal(store.corruptRaw(`${KEY}.corrupt-2026-03-05`), raw);
  });

  test('a second damaged copy on the same day gets its own key', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: at(2026, 3, 5) });
    await fresh({ [KEY]: 'nope', [`${KEY}.corrupt-2026-03-05`]: 'older' });
    assert.equal(localStorage.getItem(`${KEY}.corrupt-2026-03-05`), 'older');
    assert.equal(localStorage.getItem(`${KEY}.corrupt-2026-03-05-2`), 'nope');
  });

  test('valid JSON that is not an object counts as damaged', async () => {
    const store = await fresh({ [KEY]: '[1,2]' });
    assert.ok(store.health().corrupt);
  });

  test('when the copy cannot be stored, saving waits for the download', async () => {
    const raw = `{"broken": "${'x'.repeat(100)}`;
    const store = await fresh({ [KEY]: raw }, { quota: 150 });
    assert.equal(store.health().corrupt.preserved, false);
    assert.equal(store.save(), false);
    assert.equal(localStorage.getItem(KEY), raw, 'damaged data not overwritten');
    assert.ok(store.health().saveError);
    assert.equal(store.corruptRaw(''), raw);
    localStorage.quota = Infinity;
    store.corruptDownloaded();
    assert.equal(store.health().saveError, null);
    assert.equal(stored().version, 1);
  });

  test('partial data is merged with defaults', async () => {
    const store = await fresh({ [KEY]: JSON.stringify({ days: { '2026-01-02': { speak: 60 } }, settings: { plan: { speak: 20 } } }) });
    const s = store.get();
    assert.deepEqual(s.settings.plan, { speak: 20, listen: 12, review: 6 });
    assert.deepEqual(s.settings.readDays, [1, 4]);
    assert.equal(s.settings.language, 'it');
    for (const k of ['mistakes', 'calls', 'drills', 'reports']) assert.deepEqual(s[k], []);
    assert.deepEqual(s.listening, {});
    assert.equal(s.rev, 0);
    assert.equal(s.version, 1);
    assert.equal(s.days['2026-01-02'].speak, 60);
    assert.equal(store.health().corrupt, null);
  });

  test('migrate keeps version 1 data and leaves newer data alone', async () => {
    const store = await fresh();
    assert.equal(store.migrate({ days: {} }).version, 1);
    assert.equal(store.migrate({ version: 7, days: {} }).version, 7);
  });
});

describe('save', () => {
  test('every save bumps rev', async () => {
    const store = await fresh();
    assert.equal(store.get().rev, 0);
    store.save();
    store.save();
    assert.equal(store.get().rev, 2);
    assert.equal(stored().rev, 2);
  });

  test('a failing save is reported until a save succeeds', async () => {
    const store = await fresh({}, { quota: 10 });
    assert.equal(store.save(), false);
    assert.match(store.health().saveError.message, /full/);
    localStorage.quota = Infinity;
    assert.equal(store.save(), true);
    assert.equal(store.health().saveError, null);
  });

  test('a storage event from another tab reloads state and notifies', async () => {
    const store = await fresh();
    store.save();
    const seen = [];
    store.subscribe((s, info) => seen.push(info.source));
    localStorage.setItem(KEY, JSON.stringify({ ...stored(), rev: 5, days: { '2026-01-01': { listen: 120 } } }));
    fireStorage(KEY);
    assert.equal(store.get().days['2026-01-01'].listen, 120);
    assert.equal(store.get().rev, 5);
    assert.deepEqual(seen, ['remote']);
    fireStorage('something-else');
    assert.deepEqual(seen, ['remote']);
  });

  test('newer data from another tab is not clobbered by a stale save', async () => {
    const store = await fresh();
    store.save(); // rev 1
    const other = { ...stored(), rev: 3, days: { '2026-01-01': { speak: 999 } } };
    localStorage.setItem(KEY, JSON.stringify(other)); // no event delivered yet
    const seen = [];
    store.subscribe((s, info) => seen.push(info.source));
    store.addSeconds('2026-01-02', 'speak', 60);
    assert.equal(stored().rev, 3, 'other tab data kept');
    assert.equal(stored().days['2026-01-01'].speak, 999);
    assert.equal(store.get().days['2026-01-01'].speak, 999, 'this tab took the newer data');
    assert.ok(store.health().conflictAt > 0);
    assert.deepEqual(seen, ['conflict']);
    store.addSeconds('2026-01-02', 'speak', 60);
    assert.equal(stored().rev, 4);
    assert.equal(stored().days['2026-01-02'].speak, 60);
  });
});

describe('import, reset and undo', () => {
  const backup = (extra = {}) => JSON.stringify({ version: 1, rev: 1, days: { '2025-12-01': { speak: 600 } }, mistakes: [], ...extra });

  test('rejects files that are not backups', async () => {
    const store = await fresh();
    const bad = ['not json', '[]', 'null', '{}', '{"days": []}', '{"days": {"2026-01-01": 5}}',
      '{"days": {}, "mistakes": {}}', '{"days": {}, "calls": "x"}', '{"days": {}, "settings": []}',
      '{"days": {}, "version": "1"}', '{"days": {}, "version": 0}', '{"days": {}, "settings": {"readDays": 3}}'];
    for (const json of bad) assert.throws(() => store.importData(json), /not a Lang Hub backup/, json);
    assert.throws(() => store.importData('{"days": {}, "version": 2}'), /newer version/);
    assert.equal(localStorage.getItem(`${KEY}.before-import`), null, 'no snapshot for a rejected file');
  });

  test('imports a backup, clears the timer and keeps counting rev', async () => {
    const store = await fresh();
    for (let i = 0; i < 5; i++) store.save();
    const r = store.importData(backup({ timer: { skill: 'speak', startedAt: 1 } }));
    assert.deepEqual(r, { undo: true });
    assert.equal(store.get().timer, null);
    assert.equal(store.get().days['2025-12-01'].speak, 600);
    assert.equal(store.get().rev, 6);
    assert.equal(stored().days['2025-12-01'].speak, 600, 'written, not refused as stale');
  });

  test('import writes an undo snapshot, and undo restores it', async () => {
    const store = await fresh();
    store.addSeconds('2026-02-02', 'listen', 300);
    const before = JSON.stringify(store.get());
    store.importData(backup());
    assert.equal(localStorage.getItem(`${KEY}.before-import`), before);
    assert.equal(store.undo('import'), true);
    assert.equal(store.get().days['2026-02-02'].listen, 300);
    assert.equal(store.get().days['2025-12-01'], undefined);
    assert.equal(stored().days['2026-02-02'].listen, 300);
    assert.equal(localStorage.getItem(`${KEY}.before-import`), null);
    assert.equal(store.undo('import'), false);
  });

  test('reset writes an undo snapshot, and undo restores it', async () => {
    const store = await fresh();
    store.addSeconds('2026-02-02', 'review', 120);
    const r = store.resetAll();
    assert.deepEqual(r, { undo: true });
    assert.deepEqual(store.get().days, {});
    assert.equal(JSON.parse(localStorage.getItem(`${KEY}.before-reset`)).days['2026-02-02'].review, 120);
    assert.ok(store.undo('reset'));
    assert.equal(store.get().days['2026-02-02'].review, 120);
  });

  test('markExported records the time', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: at(2026, 4, 1) });
    const store = await fresh();
    store.markExported();
    assert.equal(stored().settings.lastExport, at(2026, 4, 1));
    assert.equal(JSON.parse(store.exportData()).settings.lastExport, at(2026, 4, 1));
  });
});

describe('streaks and timer', () => {
  const daysFrom = (keys) => JSON.stringify({ days: Object.fromEntries(keys.map((k) => [k, met])) });

  test('streak and best streak across the spring DST change and midnight', async (t) => {
    // Clocks went forward in Rome on 2026-03-29 (a 23 hour day).
    const store = await fresh({ [KEY]: daysFrom(['2026-03-20', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30']) });
    t.mock.timers.enable({ apis: ['Date'], now: at(2026, 3, 31, 0, 5) });
    assert.equal(store.streak(), 4, 'an unmet today just after midnight does not break it');
    assert.equal(store.bestStreak(), 4);
    t.mock.timers.setTime(at(2026, 4, 1, 0, 5));
    assert.equal(store.streak(), 0, 'a missed day breaks it');
  });

  test('streak across the autumn DST change', async (t) => {
    // Clocks went back on 2026-10-25 (a 25 hour day).
    const store = await fresh({ [KEY]: daysFrom(['2026-10-24', '2026-10-25', '2026-10-26']) });
    t.mock.timers.enable({ apis: ['Date'], now: at(2026, 10, 26, 23, 59) });
    assert.equal(store.streak(), 3);
    assert.equal(store.bestStreak(), 3);
  });

  test('a timer running past midnight counts for the day it started', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: at(2026, 3, 28, 23, 50) });
    const store = await fresh();
    store.startTimer('speak');
    t.mock.timers.setTime(at(2026, 3, 29, 0, 20));
    store.stopTimer();
    assert.equal(store.get().days['2026-03-28'].speak, 1800);
    assert.equal(store.get().days['2026-03-29'], undefined);
  });

  test('stopTimer caps a forgotten timer at 3 hours', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: at(2026, 5, 1, 9) });
    const store = await fresh();
    store.startTimer('listen');
    t.mock.timers.setTime(at(2026, 5, 1, 17));
    store.stopTimer();
    assert.equal(store.get().days['2026-05-01'].listen, 3 * 3600);
    assert.equal(store.get().timer, null);
  });

  test('a routine with no goal does not hang the streak', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: at(2026, 5, 3) });
    const store = await fresh({ [KEY]: JSON.stringify({ settings: { plan: { speak: 0, listen: 0, review: 0 } }, days: { '2026-05-02': { speak: 60 } } }) });
    assert.equal(store.streak(), 1);
  });
});

test('callSecondsThisMonth: calendar month by default, or since a date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at(2026, 6, 20) });
  const calls = [{ at: at(2026, 5, 25), seconds: 100 }, { at: at(2026, 6, 2), seconds: 200 }, { at: at(2026, 6, 15), seconds: 300 }];
  const store = await fresh({ [KEY]: JSON.stringify({ days: {}, calls }) });
  assert.equal(store.callSecondsThisMonth(), 500);
  assert.equal(store.callSecondsThisMonth(at(2026, 5, 20)), 600);
  assert.equal(store.callSecondsThisMonth(at(2026, 6, 10)), 300);
});

describe('review scheduling', () => {
  // review.js registers a click listener on document at import; nothing else needs a DOM.
  globalThis.document ??= { addEventListener() {} };
  const DAY = 864e5;

  test('good answers grow the interval, "again" resets it', async (t) => {
    globalThis.localStorage = new MemStorage();
    const review = await import('../js/review.js');
    const now = at(2026, 7, 1);
    t.mock.timers.enable({ apis: ['Date'], now });
    const m = { id: 'a', said: 'x', correct: 'y' };
    assert.ok(review.isDue(m));
    review.grade(m, 2);
    assert.equal(m.srs.interval, 1);
    assert.equal(m.srs.due, now + DAY);
    assert.ok(!review.isDue(m, now));
    review.grade(m, 2);
    assert.equal(m.srs.interval, 6);
    review.grade(m, 2);
    assert.equal(m.srs.interval, 15);
    review.grade(m, 3);
    assert.equal(m.srs.interval, Math.round(15 * 2.5 * 1.3));
    assert.equal(m.srs.ease, 2.65);
    review.grade(m, 0);
    assert.equal(m.srs.interval, 0);
    assert.equal(m.srs.reps, 0);
    assert.equal(m.srs.lapses, 1);
    assert.equal(m.srs.due, now + 10 * 60e3);
    assert.equal(m.srs.history.length, 5);
  });

  test('ease never drops below 1.3 and easy first answers wait 3 days', async () => {
    const review = await import('../js/review.js');
    const m = {};
    for (let i = 0; i < 10; i++) review.grade(m, 0);
    assert.equal(m.srs.ease, 1.3);
    const e = {};
    review.grade(e, 3);
    assert.equal(e.srs.interval, 3);
  });
});
