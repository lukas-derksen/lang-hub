// Live voice coach on ElevenLabs. The agent is private: each call needs a
// one-time signed URL, fetched with the API key stored on this device only.
import * as store from './store.js';

const API = 'https://api.elevenlabs.io/v1';
const SDK_URL = 'vendor/elevenlabs-client-1.35.0.js';

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

async function api(path, key) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers: { 'xi-api-key': key } });
  } catch (e) {
    throw new Error('Could not reach ElevenLabs. Check your internet connection.');
  }
  if (res.status === 401) throw new Error('ElevenLabs rejected the API key. Check it in Settings.');
  if (res.status === 403) throw new Error('This API key is missing a permission (see Settings for which ones it needs).');
  if (!res.ok) throw new Error(`ElevenLabs returned an error (${res.status}).`);
  return res.json();
}

/** Credits used and left this billing month, or null without a key. */
export async function usage(key = store.getApiKey()) {
  if (!key) return null;
  const s = await api('/user/subscription', key);
  return {
    used: s.character_count,
    limit: s.character_limit,
    resetsAt: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000) : null,
    tier: s.tier,
  };
}

/**
 * Start a live call. Returns a controller; callbacks report progress.
 * opts: { agentId, prompt, firstMessage, voiceId, maxSeconds, wrapUp, onStatus, onMode, onMessage, onMistake, onEnd, onError }
 */
export async function startCall(opts) {
  const key = store.getApiKey();
  if (!key) throw new Error('Add your ElevenLabs API key in Settings first.');

  // Ask for the mic first so a refusal is reported clearly.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    throw new Error('Microphone access is needed for a call. Allow it in your browser settings.');
  }

  opts.onStatus?.('connecting');
  const [{ signed_url: signedUrl }, SDK] = await Promise.all([
    api(`/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(opts.agentId)}`, key),
    loadSdk(),
  ]);

  const startedAt = Date.now();
  let ended = false, wrapTimer = null, hardTimer = null, conversation = null;

  const finish = (reason) => {
    if (ended) return;
    ended = true;
    clearTimeout(wrapTimer); clearTimeout(hardTimer);
    opts.onEnd?.({ seconds: Math.round((Date.now() - startedAt) / 1000), reason });
  };

  conversation = await SDK.Conversation.startSession({
    signedUrl,
    connectionType: 'websocket',
    overrides: {
      agent: { prompt: { prompt: opts.prompt }, firstMessage: opts.firstMessage },
      ...(opts.voiceId ? { tts: { voiceId: opts.voiceId } } : {}),
    },
    clientTools: {
      log_mistake: (params) => { opts.onMistake?.(params); return 'logged'; },
    },
    onConnect: () => opts.onStatus?.('connected'),
    onDisconnect: () => finish('disconnected'),
    onError: (message) => opts.onError?.(typeof message === 'string' ? message : 'Something went wrong in the call.'),
    onModeChange: ({ mode }) => opts.onMode?.(mode),
    onMessage: (m) => opts.onMessage?.(m),
  });

  // Credit guard: ask the coach to wrap up a minute before the cap, then hang up.
  if (opts.maxSeconds) {
    wrapTimer = setTimeout(() => { try { conversation.sendContextualUpdate(opts.wrapUp); } catch (e) { /* ignore */ } }, Math.max(0, opts.maxSeconds - 60) * 1000);
    hardTimer = setTimeout(() => { conversation.endSession(); }, (opts.maxSeconds + 20) * 1000);
  }

  return {
    end: async () => { try { await conversation.endSession(); } finally { finish('ended'); } },
    say: (text) => { try { conversation.sendContextualUpdate(text); } catch (e) { /* ignore */ } },
    mute: (m) => { try { conversation.setMicMuted(m); } catch (e) { /* ignore */ } },
    startedAt,
  };
}
