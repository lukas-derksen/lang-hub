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

Served by GitHub Pages from the root of `main`. When you change a file listed in `sw.js`, bump `VERSION` there so installed apps pick up the update.

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
- The first time a clip is played, the app voices it with ElevenLabs text to speech (`eleven_multilingual_v2`, about 1 credit per character, roughly 600 to 800 per clip) using your key, then keeps the audio in the browser's Cache Storage (`lhclips-v1`). Replays are free and work offline.
- Speed changes are done in the browser (pitch preserved), so they cost nothing. Distracted mode noise (café, street, TV) is synthesised in the browser; the "chatter" is the clip itself played backwards, so it sounds like speech but can't be understood.
