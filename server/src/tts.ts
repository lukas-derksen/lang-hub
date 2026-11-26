// Clip audio: voiced once with ElevenLabs, kept in KV, served to every device.
// Same model and voice settings as the app (js/listen.js), so clips sound the same.
// Similarity 0.7 (not higher) so a voice's recording noise isn't copied; style 0 as
// ElevenLabs recommends (anything else makes the model less stable).
export const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.7, style: 0, speed: 1.0, use_speaker_boost: true };

/** FNV-1a 32-bit hash as 8 hex digits, matching js/listen.js. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Hash of what a segment sounds like: its text, the model and the voice settings.
 * Same input as segHash in js/listen.js; the app puts it in the audio URL
 * (/api/audio/{clipId}/{i}/{hash}) so it never caches audio for text that changed.
 */
export const segHash = (text: string, model: string) => fnv1a(`${text}\u0000${model}\u0000${JSON.stringify(VOICE_SETTINGS)}`);

export const audioKey = (clipId: string, i: number, voiceId: string, text: string, model: string) =>
  `audio:${clipId}:${i}:${voiceId}:${segHash(text, model)}`;

export class TtsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
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
