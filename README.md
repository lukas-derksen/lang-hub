# Lang Hub

A personal PWA for daily language practice, built around a 30 minute routine of speaking, listening and review, with reading as an extra. It starts with Italian, and other languages can be added in `js/languages.js`. It installs on a phone or laptop and works offline.

## Roadmap

1. **App shell and daily routine** (this version): "Today" screen with timers per skill, streak, weekly view, progress page, settings, backup.
2. **Speaking coach** (done): live calls with Elena, a private ElevenLabs voice agent. Role play scenes, reading discussions and conversation cards, a mistake log, a recap after each call and a credit meter.
3. **Listening and reading** (listening done): the listening trainer: clips in different voices, accents and speeds, dictation and a "distracted mode" with background noise. The reading section has an article with some depth, followed by a live conversation with a coach about it.
4. **Grammar through use**: spaced repetition drills built from the mistake log, plus a weekly summary for the tutor.

## Running locally

It's plain HTML, CSS and JavaScript modules, with no build step.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Hosting

Served by GitHub Pages from the root of `main` (branch deploy, no build step).

When you change anything in `index.html`, `js/`, `css/`, `content/` or another file in the `SHELL` list of `sw.js`, bump `VERSION` in `sw.js` (`v8` → `v9`). A GitHub Actions check (`.github/workflows/sw-version.yml`) fails pull requests that change those files without a bump.

## Offline and updates

- `sw.js` precaches the app shell (the `SHELL` list) on install. It fetches with `cache: 'reload'`, so the browser's HTTP cache (GitHub Pages sends `max-age=600`) can't fill a new version with old files.
- **Pages and content** (`index.html`, `content/**/*.json`) are network first: the app waits up to 3 seconds for the network, then falls back to the cached copy, and updates the cache whenever the network answers. Edited content shows up on the next load without a version bump; the bump is still needed for the rest of the shell.
- **Everything else** (JS, CSS, icons) is cache first. Other same-origin files, such as the 1 MB voice SDK in `vendor/`, are cached the first time they're used. Error and opaque responses are never cached, and clip audio (`clips-cache/…`) lives in its own cache.
- **Updates**: a new version installs in the background and waits. The app shows a "New version · Reload" bar; tapping Reload activates it and reloads. The app never reloads by itself, and never during a live call (the reload waits until the call screen is closed). When the app comes back to the foreground it checks for a new version, at most once an hour.

## Data

Progress is stored in the browser's `localStorage` on each device. Use **Settings → Export** to back it up or move it to another device.

## Coach (ElevenLabs)

- The agent is private (authentication on), so a call needs a one-time signed URL. The app gets it with the ElevenLabs API key you paste in **Settings**, which is stored only in that browser (`localStorage`, key `langhub.secret`) and never in the repo or the backup export.
- Use a restricted key (ElevenAgents + User: read) with a monthly credit limit.
- **Coach voice** (Settings): pick one of the Italian voices in `js/languages.js` (`coach.voices`), or a different voice each call. The coach's name and home town follow the voice. The agent allows the client to override `tts.voice_id` for this.
- The agent id, persona and wrap-up message live in `js/languages.js`; scenes, conversation cards and articles in `content/it/`.
- Calls stop on their own at the scene's time limit, and the agent hangs up after 45 seconds of silence. The agent itself allows one call at a time and 15 calls a day.
- Calls last at most 20 minutes (`MAX_CALL_MINUTES` in `js/coach.js`). Each call asks the server for its own cap (`conversation.max_duration_seconds` override, the activity limit + 30 s); without it the agent cuts calls at 600 s.
- **Coach minutes per day** (Settings, default 30, 0 = no limit) blocks new calls once today's calls reach it. With fewer than 5,000 credits left (last reading) the app asks before starting a call.
- The ElevenLabs browser SDK is vendored in `vendor/` (v1.35.0) so the app needs no build step. It carries one small patch, marked "Lang Hub patch", that forwards `overrides.conversation.maxDurationSeconds`, which 1.35.0 drops.
- `TESTING.md` has a 10 minute checklist for real calls.

## Listening

- Clip scripts, questions and dictation sentences are in `content/it/clips.json`, with a voice (and accent) per speaker.
- The first time a clip is played, the app voices it with ElevenLabs text to speech using your key, then keeps the audio in the browser's Cache Storage (`lhclips-v1`). Replays are free and work offline.
- The model is `TTS_MODEL` in `js/listen.js`: `eleven_multilingual_v2` by default (best quality, about 1 credit per character, roughly 600 to 800 per clip). `eleven_flash_v2_5` costs about half (0.5 credits per character) but sounds less natural; it's your call. Changing the model voices clips again on their next play.
- Cached audio is keyed by clip, segment, voice and a short hash of the text, model and voice settings, so editing a clip's text voices it again instead of playing the old audio. Audio that no longer matches any clip is removed from the cache after the clips load.
- If the browser cleared a clip's audio (for example to free space), the app asks before voicing it again and says roughly how many credits it costs. The list of clips voiced on this device is in `localStorage` (`langhub.voiced`), not in the backup.
- Speed changes are done in the browser (pitch preserved), so they cost nothing. Distracted mode noise (café, street, TV) is synthesised in the browser; the "chatter" is the clip itself played backwards, so it sounds like speech but can't be understood.

## Security

`index.html` sets a Content Security Policy:

```
default-src 'self';
script-src 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net/npm/@alexanderolsen/libsamplerate-js@2.1.2/dist/libsamplerate.worklet.js;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
media-src 'self' blob:;
connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io;
worker-src 'self' blob:;
object-src 'none'; base-uri 'self'; form-action 'self'
```

- No inline scripts or event handlers: all code is in `js/` and `vendor/`. Keep it that way.
- `style-src 'unsafe-inline'` is only there for `style="width:…"` attributes in the templates (progress bars).
- `connect-src` allows only ElevenLabs: REST calls (`https://api.elevenlabs.io`) and the call's WebSocket (`wss://api.elevenlabs.io`). Calls use `connectionType: 'websocket'`; the SDK's WebRTC mode would also need `wss://livekit.rtc.elevenlabs.io`.
- The voice SDK loads its audio worklets from `blob:` URLs, which `script-src blob:` allows. When the device can't record at 16 kHz it also loads a resampler worklet (WebAssembly) from jsDelivr, so that exact URL and `'wasm-unsafe-eval'` are allowed too. To drop them, vendor the worklets and pass `workletPaths` / `libsampleratePath` to `startSession` in `js/coach.js`.
- A `<meta>` CSP can't set `frame-ancestors` (GitHub Pages doesn't allow custom headers).

## Tests

- `node --test tests/*.test.mjs`: unit tests for storage and review scheduling (no dependencies).
- `node tests/smoke.cjs`: opens every screen in Chromium with the ElevenLabs SDK mocked, runs a call, checks offline start and the Content Security Policy. Needs the `playwright` package.
- Both run on every pull request (`.github/workflows/test.yml`). Real ElevenLabs behaviour can't be tested there: use the manual checklist in `TESTING.md`.
