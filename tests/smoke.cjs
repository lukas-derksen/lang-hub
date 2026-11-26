// Browser smoke test: every screen renders without errors or CSP violations,
// a (mocked) coach call starts and ends, and the app works offline.
// Run: node tests/smoke.cjs   (needs the `playwright` package and Chromium)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, p.endsWith('/') ? `${p}index.html` : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Fake ElevenLabs SDK, installed before the app loads.
function mockSdk() {
  navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
  const M = (window.__mock = { sessions: [] });
  window.ElevenLabsClient = { Conversation: { async startSession(o) {
    M.attempts = (M.attempts || 0) + 1;
    if (M.failWebrtc && o.connectionType === 'webrtc') throw new Error('could not establish pc connection');
    const s = { o, ended: false,
      endSession: async () => { if (s.ended) return; s.ended = true; o.onDisconnect?.({ reason: 'user' }); },
      sendUserMessage() {}, sendContextualUpdate() {}, setMicMuted() {} };
    M.sessions.push(s);
    o.onConnect?.({ conversationId: 'test' });
    setTimeout(() => o.onMessage?.({ source: 'ai', role: 'agent', message: 'Ciao!' }), 10);
    return s;
  } } };
}

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

(async () => {
  const server = await serve();
  const BASE = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('https://api.elevenlabs.io/**', (route) => {
    const u = route.request().url();
    if (u.includes('/convai/conversation/token')) return route.fulfill({ json: { token: 'test-token' } });
    if (u.includes('get-signed-url')) return route.fulfill({ json: { signed_url: 'wss://api.elevenlabs.io/test' } });
    if (u.includes('/user/subscription')) return route.fulfill({ json: { character_count: 1000, character_limit: 100000, tier: 'creator' } });
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(mockSdk);
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    if (!localStorage.getItem('langhub.secret')) localStorage.setItem('langhub.secret', 'sk_test_0000');
  });

  await page.goto(BASE);
  await page.evaluate(() => navigator.serviceWorker.ready);

  const routes = ['today', 'speak', 'cards', 'listen', 'read', 'review', 'drill', 'report', 'progress', 'settings'];
  for (const r of routes) {
    await page.goto(`${BASE}#/${r}`);
    await page.waitForTimeout(400);
    const text = (await page.textContent('#view')) || '';
    check(text.trim().length > 20 && !/Loading…$/.test(text.trim()), `#/${r} renders`);
  }
  // Today's picks: one card per block, with a reason, and "Something else" moves on.
  await page.goto(`${BASE}#/today`);
  await page.waitForSelector('.pick', { timeout: 5000 }).catch(() => {});
  const picks = await page.$$eval('.pick', (els) => els.map((e) => ({ title: e.querySelector('strong')?.textContent, reason: e.querySelector('.pick-reason')?.textContent })));
  check(picks.length >= 1 && picks.every((p) => p.title && p.reason), `today shows picks with reasons (${picks.map((p) => `${p.title}: ${p.reason}`).join(' | ')})`);
  if (picks.length) {
    await page.click('[data-action=pick-skip] >> nth=0');
    await page.waitForTimeout(200);
    const after = await page.$eval('.pick strong', (e) => e.textContent);
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('langhub.v1')));
    check(after !== picks[0].title && st.events.some((e) => e.type === 'skip') && st.picks?.day, '"Something else" shows another pick and is remembered');
  }

  const clip = await page.evaluate(() => fetch('content/it/clips.json').then((r) => r.json()).then((d) => d.clips[0].id));
  await page.goto(`${BASE}#/listen/${clip}`);
  await page.waitForSelector('[data-action=clip-play]');
  check(true, 'clip page renders');

  // A coach call starts, shows the call screen, and ends with a recap.
  await page.goto(`${BASE}#/speak`);
  await page.waitForSelector('[data-action=call-scene]:not([disabled])');
  await page.click('[data-action=call-scene] >> nth=0');
  await page.waitForFunction(() => location.hash === '#/call' && window.__mock.sessions.length === 1);
  const ov = await page.evaluate(() => window.__mock.sessions[0].o.overrides);
  const how = await page.evaluate(() => { const o = window.__mock.sessions[0].o; return { type: o.connectionType, token: o.conversationToken, url: o.signedUrl }; });
  check(how.type === 'webrtc' && how.token === 'test-token' && !how.url, `call connects over WebRTC with a conversation token (${JSON.stringify(how)})`);
  check(ov?.conversation?.maxDurationSeconds > 0 && ov.conversation.maxDurationSeconds <= 20 * 60 + 30, `call sends a max duration (${ov?.conversation?.maxDurationSeconds}s)`);
  await page.waitForTimeout(300);
  await page.click('[data-action=end-call]');
  await page.waitForFunction(() => location.hash === '#/recap');
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('langhub.v1')).calls.length === 1), 'call logged after ending');
  await page.click('[data-action=rate][data-value=up]');
  await page.click('[data-action=rate-level][data-value=right]');
  const evs = await page.evaluate(() => JSON.parse(localStorage.getItem('langhub.v1')).events);
  check(evs.some((e) => e.type === 'talk' && e.item.startsWith('scene:')) && evs.some((e) => e.type === 'rate' && e.w === 1) && evs.some((e) => e.type === 'rate-level' && e.skill === 'speak'),
    'call engagement and the recap rating are recorded');
  await page.goto(`${BASE}#/progress`);
  check(/What the app has learned/.test(await page.textContent('#view')), 'progress shows what the app has learned');

  // Offline: the installed app still opens.
  await ctx.setOffline(true);
  await page.goto(`${BASE}#/today`);
  await page.waitForTimeout(500);
  check(((await page.textContent('#view')) || '').length > 20, 'opens offline');
  await ctx.setOffline(false);

  // Content server: generated items show up, the profile is synced, audio comes from the server.
  const cspSeen = []; // CSP violations from before a reload (window.__csp starts empty on each load)
  const keepCsp = async () => cspSeen.push(...await page.evaluate(() => window.__csp.splice(0)));
  {
    const SRV = 'https://lang-hub-api.dark-bird-a775.workers.dev'; // ALLOWED_ORIGIN in js/server.js
    const clipsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/it/clips.json'), 'utf8'));
    const genClip = { ...clipsJson.clips[0], id: 'g261126-test-clip', title: 'Clip generato di prova', topics: ['food'] };
    const article = (id, title, at) => ({ id, kind: 'article', created_at: at, updated_at: at, data: { id, title, topic: 'Cibo', level: 'B1', minutes: '3', topics: ['food', 'made-up-topic'], paragraphs: ['Uno.', 'Due.', 'Tre.'], glossary: [['uno', 'one']], discussion: ['x'] } });
    const items = [
      { id: genClip.id, kind: 'clip', created_at: 1, updated_at: 1, data: genClip },
      article('g261126-test-article', 'Articolo generato di prova', 2),
      { id: 'g261126-test-scene', kind: 'scene', created_at: 3, updated_at: 3, data: { id: 'g261126-test-scene', title: 'Scena generata di prova', subtitle: 'Test', icon: '<img src=x>🧪', minutes: '8', level: 'B1', topics: ['health'], firstMessage: 'Ciao!', instructions: 'Test.' } },
      article('g261126-test-article2', 'Secondo articolo da nascondere', 4),
      // More than one page (limit 100) of card batches, so the app has to page through them.
      ...Array.from({ length: 105 }, (_, i) => ({ id: `g261126-cards-${i}`, kind: 'cards', created_at: 10 + i, updated_at: 10 + i, data: { id: `g261126-cards-${i}`, cards: [{ text: `Carta ${i}?`, type: 'quick', topics: ['food'] }] } })),
    ];
    const seen = { profile: null, profilePuts: 0, audio: [], itemsCalls: [], deleted: [] };
    const audioMode = { oldServer: false };
    await ctx.route(`${SRV}/**`, async (route) => {
      const r = route.request(), u = new URL(r.url());
      const cors = { 'Access-Control-Allow-Origin': BASE.replace(/\/$/, ''), 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS' };
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (r.headers().authorization !== 'Bearer test-password-0123456789') return route.fulfill({ status: 401, headers: cors, json: { error: 'no' } });
      if (u.pathname === '/api/items') {
        // The contract: since is inclusive on created_at, ascending, up to limit, with `more`;
        // hidden items come back as { id, kind, created_at, hidden: true } without data.
        const since = Number(u.searchParams.get('since') || 0), limit = Math.min(200, Number(u.searchParams.get('limit')) || 100);
        seen.itemsCalls.push({ since, limit });
        const all = items.filter((x) => x.hidden || x.created_at >= since).sort((a, b) => a.created_at - b.created_at);
        const rows = all.slice(0, limit).map((x) => (x.hidden ? { id: x.id, kind: x.kind, created_at: x.created_at, hidden: true } : x));
        return route.fulfill({ headers: cors, json: { items: rows, more: all.length > limit, now: 9 } });
      }
      const del = u.pathname.match(/^\/api\/items\/(.+)$/);
      if (del && r.method() === 'DELETE') {
        const id = decodeURIComponent(del[1]);
        seen.deleted.push(id);
        const it = items.find((x) => x.id === id);
        if (it) { it.hidden = true; it.updated_at = 5000; }
        return route.fulfill({ headers: cors, json: { ok: true } });
      }
      if (u.pathname === '/api/profile') { seen.profilePuts++; seen.profile = JSON.parse(r.postData()); return route.fulfill({ headers: cors, json: { ok: true } }); }
      if (u.pathname === '/api/status') {
        return route.fulfill({ headers: cors, json: { ok: true, usage: { tts_chars: 1200 }, ttsLimit: 25000, claude: { input: 120000, output: 30000, inputLimit: 2000000, outputLimit: 400000 },
          generated: { clip: 1, article: 1, scene: 1 }, lastRun: { at: Date.UTC(2026, 10, 26, 4, 30), made: ['a', 'b'], errors: [], skipped: ['scene'] } } });
      }
      const am = u.pathname.match(/^\/api\/audio\/([^/]+)\/(\d+)(?:\/([0-9a-f]{8}))?$/);
      if (am) {
        seen.audio.push(u.pathname);
        if (am[3] && audioMode.oldServer) return route.fulfill({ status: 404, headers: cors, json: { error: 'Not found' } });
        if (am[3] === '00000000') return route.fulfill({ status: 409, headers: cors, json: { error: 'Text differs' } });
        return route.fulfill({ headers: { ...cors, 'Content-Type': 'audio/mpeg' }, body: Buffer.alloc(10) });
      }
      return route.fulfill({ status: 404, headers: cors, json: {} });
    });
    const textOf = async (sel) => (await page.textContent(sel).catch(() => '')) || '';
    // Poll from Node: waitForFunction needs eval in some Playwright versions, which the CSP blocks.
    const until = async (fn, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await page.waitForTimeout(100); } return false; };

    // Another address is refused: the app only talks to its own server.
    await page.goto(`${BASE}#/settings`);
    await page.waitForSelector('#server-form');
    await page.fill('#server-form input[name=url]', 'https://evil.example.workers.dev');
    await page.fill('#server-form input[name=token]', 'test-password-0123456789');
    await page.click('#server-form button[type=submit]');
    await page.waitForTimeout(200);
    check(/only talks to your own server at https:\/\/lang-hub-api\.dark-bird-a775\.workers\.dev/.test(await textOf('#server-status')) && !(await page.evaluate(() => localStorage.getItem('langhub.server'))),
      'settings refuses another server address');

    await page.fill('#server-form input[name=url]', SRV);
    await page.fill('#server-form input[name=token]', 'test-password-0123456789');
    await page.click('#server-form button[type=submit]');
    await until(async () => /Connected/.test(await textOf('#server-status')) && seen.itemsCalls.length >= 2);
    await page.waitForTimeout(300);
    const status = await textOf('#server-status');
    check(/Connected ✓/.test(status), 'content server connects from Settings');
    check(/Last nightly run: .*made 2, no errors, skipped 1/.test(status) && /Claude this month: 120,000 of 2,000,000 input tokens, 30,000 of 400,000 output tokens/.test(status),
      `settings shows the last nightly run and Claude usage (${status.replace(/\s+/g, ' ')})`);
    check(!!seen.profile && Array.isArray(seen.profile.events) && seen.profile.used.some((k) => k.startsWith('scene:')), 'profile is synced to the server (events and done items)');
    check(seen.itemsCalls.length >= 2 && seen.itemsCalls[0].since === 0 && seen.itemsCalls[0].limit === 100 && seen.itemsCalls[1].since === 105,
      `items are fetched page by page (${seen.itemsCalls.map((c) => `since=${c.since}`).join(', ')})`);
    const stored = await page.evaluate(async () => {
      const s = await import('./js/server.js');
      return { cards: s.byKind('cards').length, ls: localStorage.getItem('langhub.serveritems') };
    });
    check(stored.cards === 105 && stored.ls === null, `all pages are kept, outside localStorage (${stored.cards} card batches)`);

    // Profile uploads are throttled: many saves, no upload; leaving the app uploads once.
    const putsBefore = seen.profilePuts;
    await page.evaluate(async () => {
      const st = await import('./js/store.js');
      for (let i = 0; i < 25; i++) st.logEvent({ item: 'clip:x', topics: ['food'], type: 'finish', w: 0.4 });
    });
    await page.waitForTimeout(6500);
    check(seen.profilePuts === putsBefore, `many saves don't upload the profile each time (${seen.profilePuts - putsBefore} uploads)`);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
    await until(async () => seen.profilePuts > putsBefore, 3000);
    await page.waitForTimeout(300);
    check(seen.profilePuts === putsBefore + 1, `leaving the app uploads the profile once (${seen.profilePuts - putsBefore})`);

    await page.goto(`${BASE}#/listen`);
    await page.waitForTimeout(400);
    let t = await page.textContent('#view');
    check(t.includes('Clip generato di prova') && t.includes('New for you'), 'generated clip shows in Listening');
    await page.goto(`${BASE}#/read`);
    await page.waitForTimeout(400);
    t = await page.textContent('#view');
    check(t.includes('Articolo generato di prova') && t.includes('3 min read'), 'generated article shows in Reading');
    await page.goto(`${BASE}#/speak`);
    await page.waitForTimeout(400);
    check((await page.textContent('#view')).includes('Scena generata di prova'), 'generated scene shows in Speaking');
    check(await page.evaluate(() => !document.querySelector('#view img') && [...document.querySelectorAll('.scene-ico')].some((e) => e.textContent.includes('<img src=x>'))),
      'a server-provided scene icon is shown as text, not HTML');
    // A call on a generated scene: the recap offers Hide this, and the profile is uploaded soon after.
    const putsBeforeCall = seen.profilePuts;
    await page.click('[data-action=call-scene][data-id="g261126-test-scene"]');
    await until(async () => (await page.evaluate(() => location.hash === '#/call' && window.__mock.sessions.length === 2)));
    await page.waitForTimeout(300);
    await page.click('[data-action=end-call]');
    await until(async () => (await textOf('#view')).includes('Recap'));
    check(!!(await page.$('#view [data-action=hide-item]')), 'the recap of a generated scene offers Hide this');
    await until(async () => seen.profilePuts > putsBeforeCall, 4000);
    check(seen.profilePuts === putsBeforeCall + 1, 'the profile is uploaded right after a call');
    await page.goto(`${BASE}#/progress`);
    await page.waitForTimeout(200);
    check(!/made-up-topic/.test(await textOf('#view')), 'what the app has learned ignores unknown topics');

    // Audio for a clip that isn't cached comes from the server, under a URL with the text hash.
    await page.goto(`${BASE}#/listen/${genClip.id}`);
    await page.waitForSelector('[data-action=clip-play]');
    check(!!(await page.$('#view [data-action=hide-item]')), 'Hide this shows on a generated clip');
    await page.click('[data-action=clip-play]');
    await until(async () => seen.audio.length > 0, 5000);
    const want = await page.evaluate(async (seg) => (await import('./js/listen.js')).segHash(seg), genClip.segments[0]);
    check(seen.audio[0] === `/api/audio/${genClip.id}/0/${want}`, `clip audio is fetched from the server with the text hash (${seen.audio[0]})`);
    // An older server without hashed URLs: falls back to the plain URL.
    audioMode.oldServer = true;
    seen.audio = [];
    const old = await page.evaluate(async (id) => (await (await import('./js/server.js')).segmentAudio(id, 0, 'abcdef12')).byteLength, genClip.id);
    check(old === 10 && seen.audio.join() === `/api/audio/${genClip.id}/0/abcdef12,/api/audio/${genClip.id}/0`, 'hashed audio URL falls back on an older server (404)');
    audioMode.oldServer = false;
    const changed = await page.evaluate(async (id) => (await import('./js/server.js')).segmentAudio(id, 0, '00000000').then(() => 'ok', (e) => e.message), genClip.id);
    check(changed === 'This clip changed on the server; refresh content', 'a 409 says the clip changed on the server');

    // Hide this: only on generated items; asks once more, hides it on the server and here.
    const builtin = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/it/articles.json'), 'utf8'))[0].id;
    await page.goto(`${BASE}#/read/${builtin}`);
    await page.waitForTimeout(300);
    check(!(await page.$('#view [data-action=hide-item]')), 'no Hide this on built-in articles');
    await page.goto(`${BASE}#/read/g261126-test-article2`);
    await page.waitForSelector('[data-action=hide-item]');
    await page.click('[data-action=hide-item]');
    await page.click('[data-action=hide-item]');
    await until(async () => (await page.evaluate(() => location.hash)) === '#/read');
    await page.waitForTimeout(300);
    t = await textOf('#view');
    check(seen.deleted.includes('g261126-test-article2') && !t.includes('Secondo articolo da nascondere') && t.includes('Articolo generato di prova'), 'Hide this removes the article on the server and here');

    // Items the server marks hidden (from another device, say) are dropped here.
    const a1 = items.find((x) => x.id === 'g261126-test-article');
    Object.assign(a1, { hidden: true, updated_at: 6000 });
    const left = await page.evaluate(async () => { const s = await import('./js/server.js'); await s.refreshItems(true); return s.byKind('article').map((a) => a.id); });
    check(!left.includes('g261126-test-article') && left.length === 0, `items hidden on the server are dropped (${left.join(', ')})`);

    // Items saved by an older version in localStorage move to IndexedDB once.
    await page.evaluate(() => localStorage.setItem('langhub.serveritems', JSON.stringify({ items: [{ id: 'g-legacy', kind: 'article', created_at: 7, data: { id: 'g-legacy', title: 'Articolo dal vecchio archivio', topic: 'x', level: 'B1', minutes: 2, topics: [], paragraphs: ['a'], glossary: [], discussion: [] } }], fetchedAt: Date.now() })));
    await keepCsp();
    await page.reload();
    await page.goto(`${BASE}#/read`);
    await until(async () => (await textOf('#view')).includes('Articolo dal vecchio archivio'), 3000);
    check((await textOf('#view')).includes('Articolo dal vecchio archivio') && (await page.evaluate(() => localStorage.getItem('langhub.serveritems'))) === null, 'old localStorage items are moved to IndexedDB');
    // And downloaded items are there offline.
    await ctx.setOffline(true);
    await keepCsp();
    await page.reload();
    await page.goto(`${BASE}#/read`);
    await until(async () => (await textOf('#view')).includes('Articolo dal vecchio archivio'), 3000);
    check((await textOf('#view')).includes('Articolo dal vecchio archivio'), 'downloaded items work offline');
    await ctx.setOffline(false);

    // CSP: only the exact server host is allowed; other workers.dev hosts are blocked.
    const blocked = await page.evaluate(() => fetch('https://someone-else.dark-bird-a775.workers.dev/api/status').then(() => 'reached', () => 'blocked'));
    await page.waitForTimeout(100);
    const v = await page.evaluate(() => { const all = window.__csp.splice(0); const mine = all.filter((x) => x.includes('someone-else')); window.__csp.push(...all.filter((x) => !x.includes('someone-else'))); return mine; });
    check(blocked === 'blocked' && v.length === 1 && /^connect-src/.test(v[0]), `a fetch to another workers.dev host is blocked by the CSP (${v.join(', ')})`);
  }

  // When WebRTC can't connect, the call falls back to WebSocket with a signed URL.
  {
    const p2 = await ctx.newPage();
    p2.on('pageerror', (e) => errors.push(`[fallback page] ${e.message}`));
    p2.on('console', (m) => { if (m.type() === 'error') errors.push(`[fallback page] ${m.text()}`); });
    await p2.addInitScript(mockSdk);
    await p2.addInitScript(() => { window.__mock.failWebrtc = true; });
    await p2.goto(`${BASE}#/speak`);
    await p2.waitForSelector('[data-action=call-scene]:not([disabled])');
    await p2.click('[data-action=call-scene] >> nth=0');
    // Poll with evaluate (not waitForFunction, which evaluates a string in the page and trips the CSP).
    const poll = async (fn, ms = 5000) => { for (let i = 0; i < ms / 100; i++) { if (await p2.evaluate(fn)) return true; await p2.waitForTimeout(100); } return false; };
    await poll(() => location.hash === '#/call' && window.__mock.sessions.length === 1);
    const fb = await p2.evaluate(() => { const s = window.__mock.sessions[0]; return { attempts: window.__mock.attempts, type: s?.o.connectionType, url: s?.o.signedUrl }; });
    check(fb.attempts === 2 && fb.type === 'websocket' && fb.url === 'wss://api.elevenlabs.io/test', `a failed WebRTC call retries over WebSocket (${JSON.stringify(fb)})`);
    if (fb.type) { await p2.click('[data-action=end-call]'); await poll(() => location.hash === '#/recap'); }
    await p2.close();
  }

  const csp = [...cspSeen, ...await page.evaluate(() => window.__csp)];
  check(csp.length === 0, `no CSP violations${csp.length ? `: ${csp.join(', ')}` : ''}`);
  // The blocked fetch to another host above logs a CSP error on purpose.
  const real = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|someone-else\.dark-bird/.test(e));
  check(real.length === 0, `no page errors${real.length ? `: ${real.join(' | ')}` : ''}`);

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
