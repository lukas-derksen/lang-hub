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

- The agent is private (authentication on), so a call needs a one-time conversation token (or a signed URL for the WebSocket fallback). The app gets it with the ElevenLabs API key you paste in **Settings**, which is stored only in that browser (`localStorage`, key `langhub.secret`) and never in the repo or the backup export.
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

## Shadowing

Every listening clip has a **Shadow it** button (`#/shadow/<clip>`, `js/shadow.js`). You go through the clip sentence by sentence: *Repeat after* plays the sentence and then records you, *Along with* records you while it plays (use headphones). Speed 0.75×, 0.9× or 1×, text hidden until you ask for it.

- Feedback runs on the device, free (`js/shadowkit.js`, pure functions with tests): both recordings are trimmed to the speech and stretched to the same length, then compared on **rhythm** (loudness shape: beats, stress, pauses), **melody** (pitch contour in semitones around each voice's own median, so a deeper voice doesn't matter) and **pace**, plus pauses the speaker didn't make. It shows both melody lines and one or two tips. It's a rough guide, not a pronunciation grade.
- **Check words** sends your attempt to ElevenLabs speech to text (`STT_MODEL` in `js/shadow.js`, `scribe_v1`) with your key, which needs the *Speech to Text* permission, and marks the words it didn't recognise. Only when you tap it.
- Sentences are cut from each speaker's turn at sentence punctuation, with the cut moved to the nearest pause in the audio.
- Shadowing counts as speaking time, and attempts are kept in your progress (`shadowing`, best score per sentence).

## Real Italian (YouTube)

The Listening page lists real Italian videos (`content/it/videos.json`: street interviews, a podcast, RAI news) and lets you add any YouTube link, including RAI's YouTube channels. RaiPlay itself can't be embedded.

- Videos play in YouTube's own embedded player (`youtube-nocookie.com`). Nothing is downloaded or rehosted, and it needs a connection.
- `js/yt.js` drives the player through YouTube's postMessage protocol, without loading YouTube's script, so the CSP only adds `frame-src https://www.youtube-nocookie.com` (and `img-src https://i.ytimg.com` for thumbnails).
- Speed 0.75×, 1× or 1.25×, Italian captions on or off (YouTube's captions, where the channel has them), and distracted mode noise on top.
- **✂ Mark phrase** saves the bit since your previous mark (at most 8 seconds back) as a phrase to practise; nudge either end by half a second. Phrases can be played, looped and shadowed. Because the browser can't read the sound inside a YouTube player, shadowing a video gives you your recording next to the original, your speaking time against the phrase, *What did I sound like?* (speech to text, your key) and a self-rating, but no rhythm or melody scores.
- The video ids in `videos.json` were found by web search and couldn't be opened from the build sandbox. A video that can't be embedded shows the reason and a link to YouTube.

## Personal picks

- Today shows one pick for the speaking (or reading) block and one for listening, each with a one-line reason and a *Something else* button. Picks are chosen once a day and kept.
- Every scene, clip, article and card has `topics` and a CEFR `level` in `content/<lang>/`. Topic names are listed in `js/recommend.js`.
- The app learns from what you do, stored as `events` in your progress data (and in the backup): finishing or replaying a clip, leaving one halfway, how long and how much you talked in a call, *Something else*, and the *How was it?* card (liked it or not, and too easy, just right or too hard). Liking and difficulty are kept apart.
- Ranking (`js/recommend.js`, pure functions with tests): interest per topic fades with a three-week half-life; items are aimed slightly above your estimated level per skill; recently done items rest, hard ones come back after a few days; about a quarter of picks explore topics with little data; practical topics (health, errands, travel, home) come up at least every two weeks; a topic you liked in the last three days is followed up. Conversation cards lean toward topics you enjoy.
- Progress → *What the app has learned* shows the topic scores and level estimates.

## Content server (optional)

`server/` is a small TypeScript backend on Cloudflare Workers (free plan) that keeps the library growing around what you enjoy:

- **Writes new content** with Claude (`MODEL` in `server/wrangler.toml`, default `claude-opus-5-5`): articles, listening clips, speaking scenes and batches of conversation cards, in the same JSON shapes as `content/it/`. The topic follows your interest profile (the same model as Today's picks, imported from `js/recommend.js`), with some exploration and the practical topics; the level is just above your estimate for that skill; your frequent mistake categories are woven in.
- **Tops up daily** (cron, 04:30 UTC) when you have fewer than 3 unplayed clips, 2 unread articles or 2 new scenes, within a weekly budget: 3 clips, 2 articles, 1 scene and 1 batch of 20 cards (`*_PER_WEEK` vars). Settings → *Check for new content now* runs it on demand.
- **Voices clips once** with ElevenLabs (same model and settings as the app) and keeps the audio in KV, so every device gets it without spending credits again. Capped at `TTS_MONTHLY_CHARS` (25,000) per month.
- **Spends carefully**: Claude tokens are capped per month (`CLAUDE_MONTHLY_INPUT_TOKENS` 2M, `CLAUDE_MONTHLY_OUTPUT_TOKENS` 300k), counted even when a reply can't be used; a kind that fails twice in a UTC day is skipped until the next day; only one run writes at a time; *Check for new content now* runs at most every 10 minutes. `/api/status` reports this month's usage against the limits and the last run (made, errors, skipped).
- **Hides bad items** everywhere: `DELETE /api/items/{id}` keeps the row but every device drops it on its next refresh.
- **Stores** your synced events, done items and mistake categories (D1), so it knows what to write. Nothing else from your progress leaves the device. The app uploads them at most every 10 minutes, when you leave the app, and right after a call or a drill.
- **Downloaded items** are kept in the browser's IndexedDB (`langhub` → `kv` → `serveritems`), not in `localStorage`, and work offline. Generated items show *New for you*; a bad one can be removed with *Hide this* (article page, clip page, call recap), which hides it on the server too.
- Settings → *Content server* shows the last nightly run and Claude usage this month against the server's limits.
- Every route except `/api/health` needs the app password (`LANGHUB_APP_TOKEN`) as a bearer token; CORS allows only `ALLOWED_ORIGINS`.

Deploy: add the repository secrets `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" plus D1 Edit), `ANTHROPIC_API_KEY`, `ELEVENLABS_TTS_KEY` (Text to Speech only) and `LANGHUB_APP_TOKEN` (32+ random characters), then run *Actions → Deploy content server*. The first run creates the database and KV namespace. The run's summary shows the server address; enter it with the app password in Settings → *Content server*. The app only accepts the address in `ALLOWED_ORIGIN` (`js/server.js`).

Develop: `cd server && npm ci && npm test && npx tsc --noEmit`. The tests run the Worker's routes and nightly run in Node (22.13 or later) against the real migrations on `node:sqlite`, with Claude and ElevenLabs stubbed. Migrations in `server/migrations/` must stay additive: the deploy applies them to the live database. Locally: put `APP_TOKEN`, `ANTHROPIC_API_KEY` and `ELEVENLABS_TTS_KEY` in `server/.dev.vars`, then `npx wrangler d1 migrations apply lang-hub --local` and `npx wrangler dev`.

## Security

`index.html` sets a Content Security Policy:

```
default-src 'self';
script-src 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net/npm/@alexanderolsen/libsamplerate-js@2.1.2/dist/libsamplerate.worklet.js;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://i.ytimg.com;
media-src 'self' blob:;
connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io https://livekit.rtc.elevenlabs.io wss://livekit.rtc.elevenlabs.io https://lang-hub-api.dark-bird-a775.workers.dev;
worker-src 'self' blob:;
frame-src https://www.youtube-nocookie.com;
object-src 'none'; base-uri 'self'; form-action 'self'
```

- No inline scripts or event handlers: all code is in `js/` and `vendor/`. Keep it that way.
- `style-src 'unsafe-inline'` is only there for `style="width:…"` attributes in the templates (progress bars).
- `connect-src` allows only ElevenLabs (REST calls on `https://api.elevenlabs.io`, WebRTC call signalling on `livekit.rtc.elevenlabs.io`, and the WebSocket fallback on `wss://api.elevenlabs.io`) and your own content server, `https://lang-hub-api.dark-bird-a775.workers.dev`, by its exact address (not `*.workers.dev`, which anyone can deploy to). Calls use WebRTC (`connectionType: 'webrtc'` with a conversation token) and fall back to WebSocket (signed URL) if WebRTC can't connect. The audio itself flows over WebRTC media, which `connect-src` doesn't govern.
- The content server's address is `ALLOWED_ORIGIN` in `js/server.js`; Settings refuses any other address. If the server moves, change it there and in `index.html`'s `connect-src` together.
- Everything from the content server (titles, icons, ids, numbers) is escaped or coerced before it goes into the page, and generated items with a broken shape are skipped.
- The voice SDK loads its audio worklets from `blob:` URLs, which `script-src blob:` allows. When the device can't record at 16 kHz it also loads a resampler worklet (WebAssembly) from jsDelivr, so that exact URL and `'wasm-unsafe-eval'` are allowed too. To drop them, vendor the worklets and pass `workletPaths` / `libsampleratePath` to `startSession` in `js/coach.js`.
- A `<meta>` CSP can't set `frame-ancestors` (GitHub Pages doesn't allow custom headers).

## Tests

- `node --test tests/*.test.mjs`: unit tests for storage and review scheduling (no dependencies).
- `node tests/smoke.cjs`: opens every screen in Chromium with the ElevenLabs SDK mocked, runs a call, checks offline start and the Content Security Policy. Needs the `playwright` package.
- Both run on every pull request (`.github/workflows/test.yml`). Real ElevenLabs behaviour can't be tested there: use the manual checklist in `TESTING.md`.
