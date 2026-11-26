# Lang Hub

A personal PWA for daily language practice, built around a 30 minute routine of speaking, listening and review, with reading as an extra. It starts with Italian, and other languages can be added in `js/languages.js`. It installs on a phone or laptop and works offline.

## Roadmap

1. **App shell and daily routine** (this version): "Today" screen with timers per skill, streak, weekly view, progress page, settings, backup.
2. **Speaking partner**: live conversations with an ElevenLabs voice agent, with a mistake log and recap.
3. **Listening and reading**: the listening trainer: clips in different voices, accents and speeds, dictation and a "distracted mode" with background noise. The reading section has an article with some depth, followed by a live conversation with a coach about it.
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
