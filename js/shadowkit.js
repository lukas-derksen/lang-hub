// Shadowing analysis: pure functions on plain arrays of samples, no DOM or Web Audio,
// so they run in the browser and in Node tests alike.
//
// Feedback compares your attempt with the speaker's sentence on three things a
// learner can act on: pace (how long your speech took), pauses (where you broke
// the sentence up), and the shapes of loudness (rhythm, stress) and pitch
// (intonation) over the sentence. Both recordings are trimmed to the speech and
// stretched to the same length before comparing, so starting late doesn't count.

const FRAME = 0.01; // seconds per analysis frame (10 ms)

/** Split text into sentences, keeping the punctuation. */
export function splitSentences(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…]["»”)]?)\s+(?=[^\s])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** RMS loudness per 10 ms frame. */
export function envelope(samples, sr) {
  const hop = Math.max(1, Math.round(sr * FRAME));
  const n = Math.floor(samples.length / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) s += samples[i] * samples[i];
    out[f] = Math.sqrt(s / hop);
  }
  return out;
}

/** Threshold between silence and speech for an envelope: a fraction of its loud frames. */
function speechThreshold(env) {
  if (!env.length) return 0;
  const sorted = Float32Array.from(env).sort();
  const loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
  return Math.max(floor * 2, loud * 0.12, 1e-4);
}

/** First and last speech frame (inclusive), or null when it's all silence. */
export function speechSpan(env) {
  const th = speechThreshold(env);
  let a = -1, b = -1;
  for (let i = 0; i < env.length; i++) if (env[i] > th) { if (a < 0) a = i; b = i; }
  return a < 0 ? null : [a, b];
}

/** Silences inside the speech of at least `minMs`: [{ start, end }] in frames. */
export function pauses(env, minMs = 250) {
  const span = speechSpan(env);
  if (!span) return [];
  const th = speechThreshold(env), minF = Math.round(minMs / 1000 / FRAME), out = [];
  let run = -1;
  for (let i = span[0]; i <= span[1]; i++) {
    if (env[i] <= th) { if (run < 0) run = i; } else if (run >= 0) { if (i - run >= minF) out.push({ start: run, end: i }); run = -1; }
  }
  return out;
}

/** Average groups of samples to bring the rate down to about 11 kHz (for pitch). */
function downsample(samples, sr, target = 11025) {
  const k = Math.max(1, Math.floor(sr / target));
  if (k === 1) return { x: samples, sr };
  const n = Math.floor(samples.length / k), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < k; j++) s += samples[i * k + j]; x[i] = s / k; }
  return { x, sr: sr / k };
}

/**
 * Pitch per 10 ms frame in Hz (0 = unvoiced or silent), by normalised
 * autocorrelation over 75–450 Hz. Good enough to follow an intonation contour.
 */
export function pitchTrack(samples, sr) {
  const { x, sr: r } = downsample(samples, sr);
  const hop = Math.round(r * FRAME), win = Math.round(r * 0.04);
  const minLag = Math.floor(r / 450), maxLag = Math.ceil(r / 75);
  const env = envelope(samples, sr), th = speechThreshold(env);
  const n = Math.min(env.length, Math.floor((x.length - win - maxLag) / hop) + 1);
  const out = new Float32Array(Math.max(0, env.length));
  for (let f = 0; f < n; f++) {
    if (env[f] <= th * 1.5) continue;
    const o = f * hop;
    let e0 = 0;
    for (let i = 0; i < win; i++) e0 += x[o + i] * x[o + i];
    if (e0 <= 0) continue;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0, e1 = 0;
      for (let i = 0; i < win; i++) { const y = x[o + i + lag]; c += x[o + i] * y; e1 += y * y; }
      const v = e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
      if (v > best) { best = v; bestLag = lag; }
    }
    if (best > 0.6 && bestLag) out[f] = r / bestLag;
  }
  return out;
}

/** Resample values[a..b] to n points (linear); zeros are gaps filled from neighbours. */
export function resample(values, a, b, n, { fillGaps = false } = {}) {
  let v = Array.from(values.slice(a, b + 1));
  if (fillGaps) {
    const idx = v.map((y, i) => (y ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) return null;
    v = v.map((y, i) => {
      if (y) return y;
      const r = idx.find((j) => j > i), l = [...idx].reverse().find((j) => j < i);
      if (l == null) return v[r];
      if (r == null) return v[l];
      return v[l] + ((v[r] - v[l]) * (i - l)) / (r - l);
    });
  }
  if (v.length < 2) return null;
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (v.length - 1), k = Math.floor(t), fr = t - k;
    return k + 1 < v.length ? v[k] * (1 - fr) + v[k + 1] * fr : v[k];
  });
}

export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Correlation after letting one curve shift up to `maxShift` points either way.
 * Shadowers naturally run a little ahead or behind inside the sentence.
 */
function bestShiftCorr(a, b, maxShift) {
  let best = -1;
  for (let s = -maxShift; s <= maxShift; s++) {
    const x = s >= 0 ? a.slice(s) : a.slice(0, a.length + s);
    const y = s >= 0 ? b.slice(0, b.length - s) : b.slice(-s);
    best = Math.max(best, pearson(x, y));
  }
  return best;
}

const semitones = (hz, ref) => 12 * Math.log2(hz / ref);
const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const smooth = (v, k = 3) => v.map((_, i) => { let s = 0, c = 0; for (let j = i - k; j <= i + k; j++) if (j >= 0 && j < v.length) { s += v[j]; c++; } return s / c; });

/** Everything the feedback needs about one recording. */
export function analyse(samples, sr) {
  const env = envelope(samples, sr);
  const span = speechSpan(env);
  if (!span) return { silent: true };
  const pitch = pitchTrack(samples, sr);
  const voiced = Array.from(pitch.slice(span[0], span[1] + 1)).filter(Boolean);
  return {
    silent: false,
    env, pitch, span,
    seconds: (span[1] - span[0] + 1) * FRAME,
    pauses: pauses(env).map((p) => ({ at: (p.start - span[0]) / (span[1] - span[0] + 1), ms: (p.end - p.start) * FRAME * 1000 })),
    medianHz: median(voiced),
    voicedShare: voiced.length / (span[1] - span[0] + 1),
  };
}

const POINTS = 60;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Compare your attempt with the model sentence. Returns null fields where a
 * measure can't be computed (for example no voiced frames for pitch).
 * Scores are 0–100.
 */
export function compare(model, you) {
  if (you.silent) return { silent: true };
  const pace = you.seconds / model.seconds; // 1 = same length, > 1 = slower
  // Rhythm: loudness shape (syllable beats, stressed syllables, pauses).
  const me = resample(smooth(Array.from(model.env), 2), model.span[0], model.span[1], POINTS);
  const ye = resample(smooth(Array.from(you.env), 2), you.span[0], you.span[1], POINTS);
  const rhythm = me && ye ? Math.round(clamp01(bestShiftCorr(me, ye, 4)) * 100) : null;
  // Intonation: pitch shape in semitones around each speaker's own median, so a
  // lower or higher voice than the model doesn't matter, only the melody does.
  const mp = resample(model.pitch, model.span[0], model.span[1], POINTS, { fillGaps: true });
  const yp = resample(you.pitch, you.span[0], you.span[1], POINTS, { fillGaps: true });
  let intonation = null, contour = null;
  if (mp && yp && model.medianHz && you.medianHz) {
    const ms = smooth(mp.map((h) => semitones(h, model.medianHz)), 2);
    const ys = smooth(yp.map((h) => semitones(h, you.medianHz)), 2);
    intonation = Math.round(clamp01(bestShiftCorr(ms, ys, 4)) * 100);
    contour = { model: ms, you: ys };
  }
  const shape = {
    model: me ? normalise(me) : null,
    you: ye ? normalise(ye) : null,
  };
  return {
    silent: false,
    pace,
    rhythm,
    intonation,
    contour,
    shape,
    pauses: { model: model.pauses.length, you: you.pauses.length, extra: extraPauses(model.pauses, you.pauses) },
    tips: tips({ pace, rhythm, intonation, model, you }),
  };
}
const normalise = (v) => { const m = Math.max(...v) || 1; return v.map((x) => x / m); };

/** Your pauses that don't line up with one of the speaker's (within 12% of the sentence). */
function extraPauses(mp, yp) {
  return yp.filter((p) => !mp.some((q) => Math.abs(q.at - p.at) < 0.12)).map((p) => p.at);
}

/** One or two plain-language things to try next time. */
export function tips({ pace, rhythm, intonation, model, you }) {
  const out = [];
  if (pace > 1.35) out.push('You took quite a bit longer than the speaker. Try linking words together instead of saying them one by one.');
  else if (pace < 0.75) out.push('You rushed it. Keep up with the speaker, not ahead of them.');
  const extra = extraPauses(model.pauses, you.pauses).length;
  if (extra >= 2) out.push(`You stopped ${extra} times where the speaker didn't. Aim for one breath per phrase.`);
  if (intonation != null && intonation < 45) out.push('Your melody was flatter or went another way. Exaggerate the rise and fall a little, like the speaker.');
  if (rhythm != null && rhythm < 45 && out.length < 2) out.push('The beat was different. Lean on the stressed syllables and let the others go quicker.');
  if (!out.length) out.push(rhythm != null && rhythm >= 70 ? 'Close match. Try it at full speed, or without the text.' : 'Good. Once more, staying right behind the speaker.');
  return out.slice(0, 2);
}

/**
 * Where to cut a segment into sentences. `env` covers the whole clip; the segment
 * runs from frame a to b. Boundaries start out proportional to the sentence
 * lengths and then move to the middle of the nearest quiet stretch (±0.7 s).
 * Returns [start, end] frame pairs, one per sentence.
 */
export function sentenceFrames(env, a, b, sentences) {
  if (sentences.length <= 1) return [[a, b]];
  const total = sentences.reduce((s, x) => s + x.length, 0);
  const th = speechThreshold(env.slice(a, b + 1));
  const reach = Math.round(0.7 / FRAME);
  const cuts = [];
  let acc = 0;
  for (let i = 0; i < sentences.length - 1; i++) {
    acc += sentences[i].length;
    const guess = a + Math.round(((b - a) * acc) / total);
    // Longest quiet run near the guess; its middle is the cut.
    let best = null, run = -1;
    const lo = Math.max(a + 1, guess - reach, cuts.at(-1) ?? a), hi = Math.min(b - 1, guess + reach);
    for (let f = lo; f <= hi + 1; f++) {
      const quiet = f <= hi && env[f] <= th;
      if (quiet && run < 0) run = f;
      if (!quiet && run >= 0) {
        const len = f - run, mid = Math.round((run + f - 1) / 2);
        const score = len - Math.abs(mid - guess) * 0.15;
        if (!best || score > best.score) best = { mid, score };
        run = -1;
      }
    }
    cuts.push(best ? best.mid : guess);
  }
  const bounds = [a, ...cuts, b];
  return sentences.map((_, i) => [bounds[i], bounds[i + 1]]);
}

/**
 * Sentences from word timestamps (speech to text): [{ text, start, end }] in
 * seconds, cut at sentence punctuation, and also after 18 words so a sentence
 * stays short enough to repeat.
 */
export function sentencesFromWords(words, maxWords = 18) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map((w) => w.text).join(' ').replace(/\s+([,.!?;:…])/g, '$1'), start: cur[0].start, end: cur.at(-1).end });
    cur = [];
  };
  for (const w of words) {
    if (!w || typeof w.text !== 'string' || !w.text.trim()) continue;
    cur.push(w);
    if (/[.!?…]["»”]?$/.test(w.text) || (cur.length >= maxWords && /[,;:]$/.test(w.text)) || cur.length >= maxWords + 8) flush();
  }
  flush();
  return out;
}

export { FRAME };

const normWord = (w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9']/g, '');

/**
 * Which words of the sentence were heard in your attempt, in order (longest
 * common subsequence on normalised words). [{ w, ok }] for each target word.
 */
export function wordDiff(target, heard) {
  const t = target.split(/\s+/).filter(Boolean), tn = t.map(normWord);
  const h = heard.split(/\s+/).map(normWord).filter(Boolean);
  const L = Array.from({ length: t.length + 1 }, () => new Int16Array(h.length + 1));
  for (let i = t.length - 1; i >= 0; i--) for (let j = h.length - 1; j >= 0; j--) {
    L[i][j] = tn[i] && tn[i] === h[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < t.length) {
    if (!tn[i]) { out.push({ w: t[i], ok: true }); i++; continue; }
    if (j < h.length && tn[i] === h[j]) { out.push({ w: t[i], ok: true }); i++; j++; }
    else if (j < h.length && L[i][j + 1] >= L[i + 1][j]) j++;
    else { out.push({ w: t[i], ok: false }); i++; }
  }
  return out;
}
