// Browser test for shadowing and real Italian videos, with a fake microphone
// (Chromium's built-in test device), fake ElevenLabs audio and a stand-in for the
// YouTube embed that speaks the same postMessage protocol.
// Run: node tests/shadow-smoke.cjs   (needs the `playwright` package and Chromium)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, p.endsWith('/') ? `${p}index.html` : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A WAV of "speech": voiced bursts with a gliding pitch and short pauses, like 2–3 sentences. */
function speechWav(seconds = 4, sr = 22050) {
  const n = Math.round(seconds * sr), d = new Int16Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, inSentence = (t % 1.6) < 1.2;
    const hz = 140 + 60 * ((t % 1.6) / 1.2);
    ph += (2 * Math.PI * hz) / sr;
    const syl = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    d[i] = inSentence ? Math.round(12000 * syl * Math.sin(ph)) : 0;
  }
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  Buffer.from(d.buffer).copy(b, 44);
  return b;
}

// Stand-in for https://www.youtube-nocookie.com/embed/<id>: answers "listening" with
// onReady, and plays/pauses/seeks a fake clock, reporting it like the real player.
const FAKE_EMBED = `<!doctype html><html><body style="background:#000;color:#fff">fake player<script>
let t = Number(new URLSearchParams(location.search).get('start')) || 0, state = -1, rate = 1, last = performance.now(), parentOrigin = '*';
const send = (o) => parent.postMessage(JSON.stringify(o), parentOrigin);
const info = () => send({ event: 'infoDelivery', info: { currentTime: t, playerState: state, playbackRate: rate, duration: 120 } });
setInterval(() => { const now = performance.now(); if (state === 1) t += ((now - last) / 1000) * rate; last = now; if (state >= 0) info(); }, 100);
addEventListener('message', (e) => {
  let d; try { d = JSON.parse(e.data); } catch (err) { return; }
  if (d.event === 'listening') { parentOrigin = e.origin; send({ event: 'onReady', info: null }); state = 5; info(); return; }
  if (d.event !== 'command') return;
  window.__cmds = (window.__cmds || 0) + 1;
  if (d.func === 'playVideo') { state = 1; last = performance.now(); send({ event: 'onStateChange', info: 1 }); }
  if (d.func === 'pauseVideo') { state = 2; send({ event: 'onStateChange', info: 2 }); }
  if (d.func === 'seekTo') t = d.args[0];
  if (d.func === 'setPlaybackRate') rate = d.args[0];
  info();
});
</script></body></html>`;

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

(async () => {
  const server = await serve();
  const BASE = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const wav = speechWav();
  const seen = { tts: 0, stt: 0 };
  await ctx.route('https://api.elevenlabs.io/**', (route) => {
    const u = route.request().url();
    if (u.includes('/text-to-speech/')) { seen.tts++; return route.fulfill({ headers: { 'Content-Type': 'audio/mpeg' }, body: wav }); }
    if (u.includes('/speech-to-text')) { seen.stt++; return route.fulfill({ json: { text: 'Ciao sono' } }); }
    if (u.includes('/user/subscription')) return route.fulfill({ json: { character_count: 1000, character_limit: 100000, tier: 'creator' } });
    return route.fulfill({ status: 404, body: '' });
  });
  await ctx.route('https://www.youtube-nocookie.com/embed/**', (route) => route.fulfill({ contentType: 'text/html', body: FAKE_EMBED }));
  await ctx.route('https://i.ytimg.com/**', (route) => route.fulfill({ contentType: 'image/png', body: fs.readFileSync(path.join(ROOT, 'icons/icon-192.png')) }));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    if (!localStorage.getItem('langhub.secret')) localStorage.setItem('langhub.secret', 'sk_test_0000');
  });

  // ---- shadowing an app clip ----
  const clip = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/it/clips.json'), 'utf8')).clips[0];
  await page.goto(`${BASE}#/listen/${clip.id}`);
  await page.waitForSelector('a[href="#/shadow/' + clip.id + '"]');
  check(true, 'clip page links to shadowing');
  await page.click(`a[href="#/shadow/${clip.id}"]`);
  await page.waitForSelector('[data-action=sh-go]', { timeout: 15000 });
  const label = await page.textContent('.sh-nav span');
  const total = Number((label.match(/of (\d+)/) || [])[1]);
  check(total >= clip.segments.length, `clip is split into sentences (${label.trim()})`);
  check(seen.tts === clip.segments.length, `audio voiced once per segment (${seen.tts})`);
  check(/·/.test(await page.textContent('.sh-text')), 'text is hidden at first');
  await page.click('[data-action=sh-text]');
  check(clip.segments[0].text.startsWith((await page.textContent('.sh-text')).trim().slice(0, 10)), 'Show text reveals the first sentence');
  // Repeat after: the sentence plays, then the (fake) mic records until Done.
  await page.click('[data-action=sh-go]');
  await page.waitForSelector('[data-action=sh-done]', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.click('[data-action=sh-done]');
  await page.waitForSelector('.attempt', { timeout: 10000 });
  const att = await page.textContent('.attempt');
  check(/Rhythm/.test(att) && /Melody/.test(att) && /Pace/.test(att), 'attempt shows rhythm, melody and pace');
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('langhub.v1')));
  check(st.shadowing?.[clip.id]?.tries === 1, 'attempt is saved in progress');
  check(st.timer?.skill === 'speak', 'shadowing counts as speaking time');
  await page.click('[data-action=sh-words]');
  await page.waitForSelector('.attempt .dict', { timeout: 5000 });
  check(seen.stt === 1 && (await page.$$('.attempt .dict mark')).length > 0, 'Check words transcribes and marks missed words');
  await page.click('[data-action=sh-next]');
  check((await page.textContent('.sh-nav span')).includes('Sentence 2'), 'next sentence');

  // ---- real Italian videos ----
  await page.goto(`${BASE}#/listen`);
  await page.waitForSelector('.video-row');
  const vids = await page.$$eval('.video-row', (els) => els.length);
  check(vids >= 3, `Listening lists real Italian videos (${vids})`);
  await page.fill('#video-url', 'https://youtu.be/dQw4w9WgXcQ?t=30');
  await page.fill('#video-name', 'Test video');
  await page.click('#add-video button[type=submit]');
  await page.waitForFunction(() => location.hash.startsWith('#/video/dQw4w9WgXcQ'));
  await page.waitForSelector('#video-frame iframe');
  const src = await page.getAttribute('#video-frame iframe', 'src');
  check(src.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?') && src.includes('start=30') && src.includes('enablejsapi=1'), 'added video opens in the nocookie embed at its start time');
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('langhub.v1')).videos[0]?.title === 'Test video'), 'added video is saved');
  // Play through the fake player, then mark a phrase.
  const frame = page.frames().find((f) => f.url().includes('youtube-nocookie'));
  for (let i = 0; i < 30 && !(await page.textContent('#vid-time')); i++) await page.waitForTimeout(100);
  check(!!(await page.textContent('#vid-time')), 'player reports ready and time');
  await frame.evaluate(() => window.postMessage('{"event":"command","func":"playVideo","args":[]}', '*'));
  await page.waitForTimeout(2500);
  await page.click('[data-action=vid-mark]');
  await page.waitForSelector('.phrase');
  const ph = await page.evaluate(() => JSON.parse(localStorage.getItem('langhub.v1')).phrases.dQw4w9WgXcQ[0]);
  check(ph && ph.end > 31.5 && ph.end - ph.start <= 8.1, `phrase marked (${ph?.start}–${ph?.end})`);
  // Playing a phrase stops at its end.
  await page.click('[data-action=vid-pplay][data-i="0"]');
  await page.waitForTimeout((ph.end - ph.start) * 1000 + 900);
  const tAfter = await frame.evaluate(() => t);
  const stateAfter = await frame.evaluate(() => state);
  check(stateAfter === 2 && Math.abs(tAfter - ph.end) < 0.6, `phrase playback pauses at the end (t=${tAfter.toFixed(2)}, end=${ph.end})`);
  // Shadow it: repeat after, Done, then rate.
  await page.click('[data-action=vid-sel][data-i="0"]');
  await page.click('[data-action=vid-go]');
  await page.waitForSelector('[data-action=vid-done]', { timeout: (ph.end - ph.start) * 1000 + 5000 });
  check(await frame.evaluate(() => state === 2), 'video pauses before your turn');
  await page.waitForTimeout(1000);
  await page.click('[data-action=vid-done]');
  await page.waitForSelector('[data-action=vid-rate]', { timeout: 10000 });
  await page.click('[data-action=vid-rate][data-r="1"]');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('langhub.v1')));
  check(after.phrases.dQw4w9WgXcQ[0].rating === 1 && after.shadowing['yt:dQw4w9WgXcQ'].best[0] === 65, 'video shadowing rating is saved');
  check(!!page.frames().find((f) => f.url().includes('youtube-nocookie')) && (await frame.evaluate(() => window.__cmds > 0)), 'player kept across phrase updates (no reload)');

  const csp = await page.evaluate(() => window.__csp);
  check(csp.length === 0, `no CSP violations${csp.length ? `: ${csp.join(', ')}` : ''}`);
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  check(real.length === 0, `no page errors${real.length ? `: ${real.join(' | ')}` : ''}`);

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
