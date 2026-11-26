// Settings → Content server: connect the app to your own server (server/ in the repo).
// Also the "Hide this" link on generated items.
import * as server from './server.js';

let H = {}; // helpers from app.js: render, toast, esc
export function init(helpers) { H = helpers; }
const esc = (s) => H.esc(s);
let note = ''; // result of the last test or status check (plain text, lines separated by \n)
let statusAt = 0; // when the status was last fetched for the settings screen

const fmtNum = (n) => (Number(n) || 0).toLocaleString('en-GB');
const fmtDate = (t) => new Date(Number(t)).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);

export function settingsCard() {
  const c = server.config();
  const on = server.enabled();
  const stale = !!c?.url && !server.checkUrl(c.url); // saved before the app was locked to one server
  const synced = server.lastSync();
  return `<form class="card" id="server-form" autocomplete="off">
    <h3>Content server</h3>
    <p class="muted">Your own server writes new articles, clips, scenes and cards around what you enjoy, at your level, and voices clips once for all your devices. The app password is the one you saved as <code>LANGHUB_APP_TOKEN</code>.</p>
    <label class="stack"><span>Server address</span>
      <input type="url" name="url" placeholder="${esc(server.ALLOWED_ORIGIN)}" value="${esc(on ? c.url : server.ALLOWED_ORIGIN)}" inputmode="url" spellcheck="false" autocapitalize="off"></label>
    <p class="muted small">This app only talks to <code>${esc(server.ALLOWED_ORIGIN)}</code>.</p>
    ${stale ? `<p class="small">${esc(`The saved address (${c.url}) isn't your server, so the app doesn't use it. ${server.wrongUrlMessage()}`)}</p>` : ''}
    <label class="stack"><span>App password</span>
      <input type="password" name="token" placeholder="${on ? 'Saved · leave empty to keep it' : 'Paste the app password'}" spellcheck="false" autocapitalize="off"></label>
    <div class="row">
      <button class="btn btn-primary" type="submit">Save and test</button>
      ${on ? '<button class="btn btn-ghost" type="button" data-action="server-topup">Check for new content now</button><button class="btn btn-ghost" type="button" data-action="server-remove">Disconnect</button>' : ''}
    </div>
    <p class="small" id="server-status">${esc(note).replace(/\n/g, '<br>')}</p>
    ${on ? `<p class="muted small">Stored only on this device, not in your backup.${synced ? ` Last synced ${fmtDate(synced)}.` : ''}</p>` : ''}
  </form>`;
}

function statusText(s) {
  const u = s.usage || {};
  const g = s.generated || {};
  const made = ['article', 'clip', 'scene'].map((k) => `${count(g[k])} ${k}${count(g[k]) === 1 ? '' : 's'}`).join(', ');
  const lines = [`Connected ✓ · written so far: ${made} · voice this month: ${fmtNum(u.tts_chars)} of ${fmtNum(s.ttsLimit)} characters`];
  const r = s.lastRun;
  if (r && r.at) {
    const errs = count(r.errors), skipped = count(r.skipped);
    const errText = errs ? `${errs} error${errs === 1 ? '' : 's'}${Array.isArray(r.errors) ? ` (${r.errors.slice(0, 3).map(String).join('; ')})` : ''}` : 'no errors';
    lines.push(`Last nightly run: ${fmtDate(r.at)}, made ${count(r.made)}, ${errText}${skipped ? `, skipped ${skipped}` : ''}.`);
  } else if (s.lastRun === null) lines.push('No nightly run yet.');
  const cl = s.claude; // { input, output, inputLimit, outputLimit }: tokens this month
  if (cl && typeof cl === 'object') {
    const part = (used, max) => `${fmtNum(used)}${Number(max) ? ` of ${fmtNum(max)}` : ''}`;
    lines.push(`Claude this month: ${part(cl.input, cl.inputLimit)} input tokens, ${part(cl.output, cl.outputLimit)} output tokens.`);
  }
  return lines.join('\n');
}

function showNote() {
  const el = document.getElementById('server-status');
  if (el) el.innerHTML = esc(note).replace(/\n/g, '<br>');
}

/** "Hide this" for a generated item (needs item.generated). `back` is where to go afterwards. */
export function hideLink(item, back = '') {
  if (!item?.generated || !server.enabled()) return '';
  return `<button type="button" class="link-btn hide-item" data-action="hide-item" data-id="${esc(item.serverId || item.id)}" data-back="${esc(back)}">Hide this</button>`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action=hide-item]');
  if (!btn) return;
  if (!btn.dataset.confirm) { btn.dataset.confirm = '1'; btn.textContent = 'Tap again to hide it for good'; return; }
  btn.disabled = true;
  try {
    const { local } = await server.hideItem(btn.dataset.id);
    H.toast(local ? 'Hidden on this device.' : 'Hidden. The server won\'t offer it again.');
    if (btn.dataset.back && location.hash !== btn.dataset.back) location.hash = btn.dataset.back;
    else H.render();
  } catch (err) {
    btn.disabled = false;
    H.toast(err.message);
  }
});

async function fillStatus() {
  try {
    const s = await (await server.api('/api/status')).json();
    note = statusText(s);
  } catch (err) { note = err.message; }
  statusAt = Date.now();
  showNote();
}

export function bind(r) {
  if (r !== 'settings') return;
  const form = document.getElementById('server-form');
  if (!form) return;
  // Show the server's state when Settings opens (at most once a minute).
  if (server.enabled() && navigator.onLine && Date.now() - statusAt > 60e3) { statusAt = Date.now(); fillStatus(); }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const url = String(f.get('url') || '').trim();
    const token = String(f.get('token') || '').trim() || server.config()?.token || '';
    if (!server.checkUrl(url)) { note = server.wrongUrlMessage(); showNote(); H.toast(note); return; }
    if (!token) { H.toast('Paste the app password.'); return; }
    server.setConfig(url, token);
    note = 'Testing…';
    statusAt = Date.now(); // tested below; bind() shouldn't fetch the status as well
    H.render();
    try {
      const s = await (await server.api('/api/status')).json();
      note = statusText(s);
      statusAt = Date.now();
      await server.syncProfile();
      const n = await server.refreshItems(true);
      H.toast(n ? `Connected. ${n} new item${n === 1 ? '' : 's'} downloaded.` : 'Connected ✓');
    } catch (err) {
      note = err.message;
      H.toast(err.message);
    }
    H.render();
  });
  form.querySelector('[data-action=server-remove]')?.addEventListener('click', () => {
    server.setConfig('');
    note = '';
    statusAt = 0;
    H.toast('Disconnected. Clips are voiced with your own key again.');
    H.render();
  });
  form.querySelector('[data-action=server-topup]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    H.toast('Asking the server for new content. This can take a minute or two…');
    try {
      await server.syncProfile();
      const res = await (await server.api('/api/topup', { method: 'POST', timeout: 240000 })).json();
      const n = await server.refreshItems(true);
      const errs = Array.isArray(res.errors) ? res.errors : [];
      note = errs.length ? `Some items failed: ${errs.map(String).join('; ')}` : n ? `${n} new item${n === 1 ? '' : 's'} ready.` : 'Nothing new needed right now: you still have enough unread content, or this week\'s budget is used.';
    } catch (err) {
      note = err.status === 409 ? 'The server is already writing new content. Check back in a few minutes.'
        : err.status === 429 ? 'The server checked for new content less than 10 minutes ago. Try again a bit later.'
          : err.message;
    }
    H.toast(note);
    H.render();
  });
}
