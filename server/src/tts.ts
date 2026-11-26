// Clip audio: voiced once with ElevenLabs, kept in KV, served to every device.
// Same model and voice settings as the app (js/listen.js), so clips sound the same.
export const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.8, style: 0.25, speed: 1.0 };

/** FNV-1a 32-bit hash as 8 hex digits, matching js/listen.js. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const audioKey = (clipId: string, i: number, voiceId: string, text: string, model: string) =>
  `audio:${clipId}:${i}:${voiceId}:${fnv1a(`${text}\u0000${model}\u0000${JSON.stringify(VOICE_SETTINGS)}`)}`;

export class TtsError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function voice(apiKey: string, voiceId: string, text: string, model: string): Promise<ArrayBuffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model, voice_settings: VOICE_SETTINGS }),
  });
  if (!res.ok) {
    let detail = '';
    try { const j: any = await res.json(); detail = j?.detail?.status || j?.detail?.message || ''; } catch { /* not JSON */ }
    throw new TtsError(`ElevenLabs ${res.status}${detail ? ` (${detail})` : ''}`, res.status);
  }
  return res.arrayBuffer();
}
