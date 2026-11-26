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

  // Offline: the installed app still opens.
  await ctx.setOffline(true);
  await page.goto(`${BASE}#/today`);
  await page.waitForTimeout(500);
  check(((await page.textContent('#view')) || '').length > 20, 'opens offline');
  await ctx.setOffline(false);

  const csp = await page.evaluate(() => window.__csp);
  check(csp.length === 0, `no CSP violations${csp.length ? `: ${csp.join(', ')}` : ''}`);
  const real = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e));
  check(real.length === 0, `no page errors${real.length ? `: ${real.join(' | ')}` : ''}`);

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
