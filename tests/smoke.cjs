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
  {
    const SRV = 'https://lang-hub-api.test.workers.dev';
    const clipsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/it/clips.json'), 'utf8'));
    const genClip = { ...clipsJson.clips[0], id: 'g261126-test-clip', title: 'Clip generato di prova', topics: ['food'] };
    const items = [
      { id: genClip.id, kind: 'clip', created_at: 1, data: genClip },
      { id: 'g261126-test-article', kind: 'article', created_at: 2, data: { id: 'g261126-test-article', title: 'Articolo generato di prova', topic: 'Cibo', level: 'B1', minutes: 3, topics: ['food'], paragraphs: ['Uno.', 'Due.', 'Tre.'], glossary: [['uno', 'one']], discussion: ['x'] } },
      { id: 'g261126-test-scene', kind: 'scene', created_at: 3, data: { id: 'g261126-test-scene', title: 'Scena generata di prova', subtitle: 'Test', icon: '🧪', minutes: 8, level: 'B1', topics: ['health'], firstMessage: 'Ciao!', instructions: 'Test.' } },
    ];
    const seen = { profile: null, audio: 0 };
    await ctx.route(`${SRV}/**`, async (route) => {
      const r = route.request(), u = new URL(r.url());
      const cors = { 'Access-Control-Allow-Origin': BASE.replace(/\/$/, ''), 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS' };
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (r.headers().authorization !== 'Bearer test-password-0123456789') return route.fulfill({ status: 401, headers: cors, json: { error: 'no' } });
      if (u.pathname === '/api/items') return route.fulfill({ headers: cors, json: { items: items.filter((x) => x.created_at > Number(u.searchParams.get('since') || 0)), now: 9 } });
      if (u.pathname === '/api/profile') { seen.profile = JSON.parse(r.postData()); return route.fulfill({ headers: cors, json: { ok: true } }); }
      if (u.pathname === '/api/status') return route.fulfill({ headers: cors, json: { ok: true, usage: { tts_chars: 1200 }, ttsLimit: 25000, generated: { clip: 1, article: 1, scene: 1 } } });
      if (u.pathname.startsWith('/api/audio/')) { seen.audio++; return route.fulfill({ headers: { ...cors, 'Content-Type': 'audio/mpeg' }, body: Buffer.alloc(10) }); }
      return route.fulfill({ status: 404, headers: cors, json: {} });
    });
    await page.goto(`${BASE}#/settings`);
    await page.waitForSelector('#server-form');
    await page.fill('#server-form input[name=url]', SRV);
    await page.fill('#server-form input[name=token]', 'test-password-0123456789');
    await page.click('#server-form button[type=submit]');
    await page.waitForFunction(() => /Connected/.test(document.getElementById('server-status')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    check(/Connected ✓/.test(await page.textContent('#server-status')), 'content server connects from Settings');
    check(!!seen.profile && Array.isArray(seen.profile.events) && seen.profile.used.some((k) => k.startsWith('scene:')), 'profile is synced to the server (events and done items)');
    await page.goto(`${BASE}#/listen`);
    await page.waitForTimeout(400);
    let t = await page.textContent('#view');
    check(t.includes('Clip generato di prova') && t.includes('New for you'), 'generated clip shows in Listening');
    await page.goto(`${BASE}#/read`);
    await page.waitForTimeout(400);
    check((await page.textContent('#view')).includes('Articolo generato di prova'), 'generated article shows in Reading');
    await page.goto(`${BASE}#/speak`);
    await page.waitForTimeout(400);
    check((await page.textContent('#view')).includes('Scena generata di prova'), 'generated scene shows in Speaking');
    // Audio for a clip that isn't cached comes from the server, not from ElevenLabs.
    const got = await page.evaluate(async (id) => {
      const s = await import('./js/server.js');
      const b = await s.segmentAudio(id, 0);
      return b.byteLength;
    }, genClip.id);
    check(got === 10 && seen.audio === 1, 'clip audio is fetched from the server');
  }

  const csp = await page.evaluate(() => window.__csp);
  check(csp.length === 0, `no CSP violations${csp.length ? `: ${csp.join(', ')}` : ''}`);
  const real = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e));
  check(real.length === 0, `no page errors${real.length ? `: ${real.join(' | ')}` : ''}`);

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
