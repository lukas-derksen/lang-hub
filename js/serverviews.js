// Settings → Content server: connect the app to your own server (server/ in the repo).
import * as server from './server.js';

let H = {}; // helpers from app.js: render, toast, esc
export function init(helpers) { H = helpers; }
const esc = (s) => H.esc(s);
let note = ''; // result of the last test

export function settingsCard() {
  const c = server.config();
  const on = server.enabled();
  const synced = server.lastSync();
  return `<form class="card" id="server-form" autocomplete="off">
    <h3>Content server</h3>
    <p class="muted">Your own server writes new articles, clips, scenes and cards around what you enjoy, at your level, and voices clips once for all your devices. The address is shown after the server deploys (GitHub → Actions → Deploy content server). The app password is the one you saved as <code>LANGHUB_APP_TOKEN</code>.</p>
    <label class="stack"><span>Server address</span>
      <input type="url" name="url" placeholder="https://lang-hub-api.….workers.dev" value="${esc(c?.url || '')}" inputmode="url" spellcheck="false" autocapitalize="off"></label>
    <label class="stack"><span>App password</span>
      <input type="password" name="token" placeholder="${on ? 'Saved · leave empty to keep it' : 'Paste the app password'}" spellcheck="false" autocapitalize="off"></label>
    <div class="row">
      <button class="btn btn-primary" type="submit">Save and test</button>
      ${on ? '<button class="btn btn-ghost" type="button" data-action="server-topup">Check for new content now</button><button class="btn btn-ghost" type="button" data-action="server-remove">Disconnect</button>' : ''}
    </div>
    <p class="small" id="server-status">${esc(note)}</p>
    ${on ? `<p class="muted small">Stored only on this device, not in your backup.${synced ? ` Last synced ${new Date(synced).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.` : ''}</p>` : ''}
  </form>`;
}

function statusText(s) {
  const u = s.usage || {};
  const g = s.generated || {};
  const made = ['article', 'clip', 'scene'].map((k) => `${g[k] || 0} ${k}${g[k] === 1 ? '' : 's'}`).join(', ');
  return `Connected ✓ · written so far: ${made} · voice this month: ${(u.tts_chars || 0).toLocaleString('en-GB')} of ${(s.ttsLimit || 0).toLocaleString('en-GB')} characters`;
}

export function bind(r) {
  if (r !== 'settings') return;
  const form = document.getElementById('server-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const url = String(f.get('url') || '').trim();
    const token = String(f.get('token') || '').trim() || server.config()?.token || '';
    if (!/^https:\/\/[^/]+/.test(url)) { H.toast('Enter the server address, starting with https://'); return; }
    if (!token) { H.toast('Paste the app password.'); return; }
    server.setConfig(url, token);
    note = 'Testing…';
    H.render();
    try {
      const s = await (await server.api('/api/status')).json();
      note = statusText(s);
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
      note = res.errors?.length ? `Some items failed: ${res.errors.join('; ')}` : n ? `${n} new item${n === 1 ? '' : 's'} ready.` : 'Nothing new needed right now: you still have enough unread content, or this week\'s budget is used.';
    } catch (err) { note = err.message; }
    H.toast(note);
    H.render();
  });
}
