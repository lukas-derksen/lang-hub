// Live voice coach on ElevenLabs. The agent is private: each call needs a
// one-time signed URL, fetched with the API key stored on this device only.
import * as store from './store.js';

const API = 'https://api.elevenlabs.io/v1';
const SDK_URL = 'vendor/elevenlabs-client-1.35.0.js';

/** Longest call the app will start, whatever the activity asks for. */
export const MAX_CALL_MINUTES = 20;
/** Extra seconds the server allows past the app's own limit, so our graceful wrap-up runs first. */
const SERVER_GRACE_SECONDS = 30;

let sdkPromise = null;
function loadSdk() {
  if (window.ElevenLabsClient) return Promise.resolve(window.ElevenLabsClient);
  sdkPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.onload = () => (window.ElevenLabsClient ? resolve(window.ElevenLabsClient) : reject(new Error('Voice library failed to load.')));
    s.onerror = () => { sdkPromise = null; reject(new Error('Could not load the voice library. Are you online?')); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

// ---------- errors ----------
const NEEDS = {
  call: 'ElevenAgents (to start calls)',
  usage: 'User: read (for the credit meter)',
  tts: 'Text to Speech (to voice listening clips)',
};

/**
 * A clear message for a failed ElevenLabs API response.
 * res: the fetch Response; body: its parsed JSON (or null); context: 'call' | 'usage' | 'tts'.
 * ElevenLabs puts the reason in body.detail.status (invalid_api_key, missing_permissions,
 * quota_exceeded, ...) and returns 401 for all three of those.
 */
export function explainError(res, body, context = '') {
  const detail = body && typeof body.detail === 'object' ? body.detail : {};
  const status = String(detail.status || '');
  const text = String(detail.message || (typeof body?.detail === 'string' ? body.detail : '') || '');
  const need = NEEDS[context];
  if (status === 'invalid_api_key') return 'ElevenLabs rejected the API key. Check it in Settings.';
  if (status === 'missing_permissions') return `This API key is missing a permission${need ? `: it needs ${need}` : ''}. Edit the key in ElevenLabs.`;
  if (status === 'quota_exceeded' || /quota|credits?\b.*(left|remaining|exceed)/i.test(text)) return 'Out of ElevenLabs credits, or the key reached its credit limit. Check your plan or the key\'s limit in ElevenLabs.';
  if (res.status === 429) {
    if (/concurren/i.test(status + text)) return 'Too many requests at once on your ElevenLabs account. Wait a moment and try again.';
    if (status === 'system_busy') return 'ElevenLabs is busy right now. Try again in a minute.';
    return 'ElevenLabs is limiting requests right now. Wait a minute and try again.';
  }
  if (res.status === 401) return 'ElevenLabs rejected the API key. Check it in Settings.';
  if (res.status === 403) return `This API key is missing a permission${need ? `: it needs ${need}` : ''}.`;
  if (res.status === 404 && context === 'call') return 'The coach agent was not found. Is this key from the account that owns the agent?';
  if (res.status >= 500) return `ElevenLabs is having problems (${res.status}). Try again later.`;
  return `ElevenLabs returned an error (${res.status})${text ? `: ${text}` : ''}.`;
}

async function api(path, key, context) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers: { 'xi-api-key': key } });
  } catch (e) {
    throw new Error('Could not reach ElevenLabs. Check your internet connection.');
  }
  if (res.ok) return res.json();
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  const err = new Error(explainError(res, body, context));
  err.status = res.status;
  err.code = body?.detail?.status || '';
  throw err;
}

/**
 * Why a live call ended or was refused, in plain words. Takes the SDK's
 * disconnect details ({ reason, message, closeCode, closeReason, context })
 * or an error thrown by startSession ({ message, closeCode, closeReason }).
 */
export function explainDisconnect(d = {}) {
  const raw = `${d.closeReason || ''} ${d.message || ''}`.trim();
  if (/daily|per day|today/i.test(raw)) return 'The coach has reached its limit of calls for today. Try again tomorrow.';
  if (/concurren|already (active|running|in progress)|too many (active|calls|conversations)/i.test(raw)) return 'Another call with the coach is still running (maybe on another device or tab). End it, or wait a minute, then try again.';
  if (/quota|credit|insufficient|limit.*(reached|exceeded)|exceeded.*limit/i.test(raw)) return 'Out of ElevenLabs credits, or the key reached its credit limit.';
  if (/override/i.test(raw)) return 'The coach agent refused a call setting. Check the agent\'s override settings in ElevenLabs.';
  if (/auth|signature|token|origin|allowlist|forbidden|unauthori[sz]ed|expired/i.test(raw) || d.closeCode === 1008) return `ElevenLabs refused the connection${raw ? ` (${raw})` : ''}. Check the key and the agent's security settings.`;
  if (/before session could be established/i.test(raw)) return 'ElevenLabs closed the connection before the call started. Maybe another call is still running, or today\'s call limit is reached. Try again in a minute.';
  if (!navigator.onLine || d.closeCode === 1006 || /socket error|network|closed unexpectedly/i.test(raw)) return 'The connection to the coach was lost. Check your internet connection.';
  return raw ? `The call stopped: ${raw}` : 'The call stopped unexpectedly.';
}

/** Credits used and left this billing month, or null without a key. */
export async function usage(key = store.getApiKey()) {
  if (!key) return null;
  const s = await api('/user/subscription', key, 'usage');
  return {
    used: s.character_count,
    limit: s.character_limit,
    resetsAt: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000) : null,
    tier: s.tier,
  };
}

const signedUrl = (key, agentId) => api(`/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, key, 'call');
const callToken = (key, agentId) => api(`/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, key, 'call');

// How calls connect. WebRTC is what ElevenLabs recommends for voice: Opus audio at
// 48 kHz with a jitter buffer, packet-loss concealment and the browser's echo
// cancellation, so the coach doesn't stutter when the network hiccups. The older
// WebSocket mode streams raw 16 to 24 kHz PCM over TCP, where one late packet
// stalls everything behind it (audible as glitches and gaps). If WebRTC can't
// connect (some networks block it), the call falls back to WebSocket, and the
// rest of this session uses WebSocket straight away.
let preferWebSocket = false;

/**
 * Test a key the way calls use it: request a call token for the agent (this
 * throws when calls won't work), then read the credits as an extra.
 * Returns { usage, usageError } where usageError is a message or ''.
 */
export async function testKey(key, agentId) {
  await callToken(key, agentId);
  try {
    return { usage: await usage(key), usageError: '' };
  } catch (e) {
    const noRead = e.code === 'missing_permissions' || e.status === 403;
    return { usage: null, usageError: noRead ? 'Key works for calls. Add User: read to the key to see your credits here.' : e.message };
  }
}

/**
 * Start a live call. Returns a controller, or null when opts.signal was
 * aborted while connecting (the session is then closed straight away).
 * opts: { agentId, prompt, firstMessage, voiceId, maxSeconds, wrapUp, signal,
 *         onStatus, onMode, onMessage, onMistake, onEnd, onError }
 * onEnd gets { seconds, reason, error } where error is a message when the
 * call dropped or was refused, '' otherwise.
 */
export async function startCall(opts) {
  const key = store.getApiKey();
  if (!key) throw new Error('Add your ElevenLabs API key in Settings first.');
  const aborted = () => !!opts.signal?.aborted;
  const maxSeconds = Math.min(opts.maxSeconds || MAX_CALL_MINUTES * 60, MAX_CALL_MINUTES * 60);

  // Ask for the mic first so a refusal is reported clearly.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    throw new Error('Microphone access is needed for a call. Allow it in your browser settings.');
  }
  if (aborted()) return null;

  opts.onStatus?.('connecting');
  const SDK = await loadSdk();
  if (aborted()) return null;

  const startedAt = Date.now();
  let ended = false, wrapTimer = null, hardTimer = null, conversation = null;

  const finish = (reason, error = '') => {
    if (ended) return;
    ended = true;
    clearTimeout(wrapTimer); clearTimeout(hardTimer);
    if (!aborted()) opts.onEnd?.({ seconds: Math.round((Date.now() - startedAt) / 1000), reason, error });
  };

  // Callbacks for one connection attempt. A WebRTC attempt that failed may still
  // fire callbacks; only the attempt in use may report to the app.
  let attempt = 0;
  const sessionFor = (n) => {
    const live = () => n === attempt && !aborted();
    return {
      overrides: {
        agent: { prompt: { prompt: opts.prompt }, firstMessage: opts.firstMessage },
        ...(opts.voiceId ? { tts: { voiceId: opts.voiceId } } : {}),
        // Server-side cap (the agent's default is 600 s). Sent as
        // conversation_config_override.conversation.max_duration_seconds.
        conversation: { maxDurationSeconds: maxSeconds + SERVER_GRACE_SECONDS },
      },
      clientTools: {
        log_mistake: (params) => { if (live()) opts.onMistake?.(params); return 'logged'; },
      },
      onConnect: () => { if (live()) opts.onStatus?.('connected'); },
      onDisconnect: (details = {}) => {
        // Ignore a drop while connecting: startSession then throws and we retry or report it.
        if (n !== attempt || !conversation) return;
        // The server ending at its time cap is a normal end, not a drop.
        const timeUp = details.context?.type === 'max_duration_exceeded';
        finish(details.reason || 'disconnected', details.reason === 'error' && !timeUp ? explainDisconnect(details) : '');
      },
      onError: (message) => {
        if (!live() || ended) return;
        opts.onError?.(typeof message === 'string' ? explainDisconnect({ message: message.replace(/^Server error:\s*/, '') }) : 'Something went wrong in the call.');
      },
      onModeChange: ({ mode }) => { if (live()) opts.onMode?.(mode); },
      onMessage: (m) => { if (live()) opts.onMessage?.(m); },
    };
  };
  const viaWebSocket = async () => {
    const { signed_url: signedUrlValue } = await signedUrl(key, opts.agentId);
    if (aborted()) return null;
    attempt++;
    return SDK.Conversation.startSession({ ...sessionFor(attempt), signedUrl: signedUrlValue, connectionType: 'websocket' });
  };

  try {
    if (preferWebSocket) {
      conversation = await viaWebSocket();
    } else {
      const { token } = await callToken(key, opts.agentId);
      if (aborted()) return null;
      try {
        attempt++;
        conversation = await SDK.Conversation.startSession({ ...sessionFor(attempt), conversationToken: token, connectionType: 'webrtc' });
      } catch (e) {
        if (aborted()) return null;
        // WebRTC blocked or failed on this network: try the WebSocket connection once.
        console.warn('[coach] WebRTC call failed, retrying over WebSocket:', e?.message || e);
        conversation = await viaWebSocket();
        preferWebSocket = true;
      }
    }
    if (!conversation) return null; // aborted while connecting
  } catch (e) {
    if (aborted()) return null;
    if (e?.status) throw e; // an API error from fetching the token or signed URL, already explained
    const err = new Error(explainDisconnect({ message: e?.message, closeCode: e?.closeCode, closeReason: e?.closeReason }));
    err.refused = true;
    throw err;
  }

  // Ended while connecting: close the session that just opened, quietly.
  if (aborted()) {
    ended = true;
    try { await conversation.endSession(); } catch (e) { /* ignore */ }
    return null;
  }

  // Credit guard: ask the coach to wrap up a minute before the cap, then hang up.
  wrapTimer = setTimeout(() => { try { conversation.sendContextualUpdate(opts.wrapUp); } catch (e) { /* ignore */ } }, Math.max(0, maxSeconds - 60) * 1000);
  hardTimer = setTimeout(() => { finish('time'); conversation.endSession().catch(() => {}); }, (maxSeconds + 20) * 1000);

  return {
    // Report the end first (synchronously), so it is logged even if the page is closing.
    end: async () => { finish('ended'); try { await conversation.endSession(); } catch (e) { /* ignore */ } },
    // Context for the coach that doesn't need an answer.
    note: (text) => { try { conversation.sendContextualUpdate(text); } catch (e) { /* ignore */ } },
    // A message the coach answers (e.g. the next card).
    say: (text) => { try { conversation.sendUserMessage(text); } catch (e) { /* ignore */ } },
    mute: (m) => { try { conversation.setMicMuted(m); } catch (e) { /* ignore */ } },
    startedAt,
  };
}
