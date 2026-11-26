// Tests for js/shadowkit.js (shadowing analysis). Run: node --test tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as k from '../js/shadowkit.js';

const SR = 16000;
/** Synthetic "speech": voiced bursts (syllables) at a pitch that follows `hz(t)`, with silences. */
function speech(parts, hz = () => 150) {
  const out = [];
  let phase = 0, t = 0;
  for (const [kind, sec] of parts) {
    const n = Math.round(sec * SR);
    for (let i = 0; i < n; i++, t += 1 / SR) {
      if (kind === 'v') { phase += (2 * Math.PI * hz(t)) / SR; const syl = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * i) / SR); out.push(0.5 * syl * Math.sin(phase)); }
      else out.push((Math.random() - 0.5) * 0.002);
    }
  }
  return Float32Array.from(out);
}

describe('sentences', () => {
  test('splits on sentence punctuation, keeps it', () => {
    assert.deepEqual(k.splitSentences('Ciao! Come stai? Bene, grazie.  E tu…'), ['Ciao!', 'Come stai?', 'Bene, grazie.', 'E tu…']);
    assert.deepEqual(k.splitSentences('«Vieni?» Sì.'), ['«Vieni?»', 'Sì.']);
  });
  test('from word timestamps, with a cap on length', () => {
    const w = (text, start) => ({ text, start, end: start + 0.3 });
    const s = k.sentencesFromWords([w('Allora', 0), w('vediamo.', 0.4), w('Sì', 1), w('certo!', 1.3)]);
    assert.deepEqual(s.map((x) => x.text), ['Allora vediamo.', 'Sì certo!']);
    assert.equal(s[1].start, 1);
    const long = Array.from({ length: 40 }, (_, i) => w(`p${i}`, i));
    assert.ok(k.sentencesFromWords(long).every((x) => x.text.split(' ').length <= 26));
  });
});

describe('speech and pauses', () => {
  test('finds the speech span and a pause in the middle', () => {
    const s = speech([['s', 0.5], ['v', 0.8], ['s', 0.5], ['v', 0.8], ['s', 0.5]]);
    const a = k.analyse(s, SR);
    assert.ok(Math.abs(a.seconds - 2.1) < 0.15, `seconds ${a.seconds}`);
    assert.equal(a.pauses.length, 1);
    assert.ok(Math.abs(a.pauses[0].at - 0.38) < 0.08);
  });
  test('silence is reported as silent', () => {
    assert.equal(k.analyse(new Float32Array(SR), SR).silent, true);
  });
  test('pitch track follows the voice', () => {
    const a = k.analyse(speech([['s', 0.2], ['v', 1], ['s', 0.2]], () => 200), SR);
    assert.ok(Math.abs(a.medianHz - 200) < 10, `median ${a.medianHz}`);
  });
});

describe('compare', () => {
  const rising = (t) => 120 + 80 * t;  // question-like
  const falling = (t) => 200 - 80 * t;
  const parts = [['s', 0.3], ['v', 0.6], ['s', 0.3], ['v', 0.6], ['s', 0.3]];
  test('same melody in a higher voice scores high on intonation', () => {
    const m = k.analyse(speech(parts, rising), SR);
    const y = k.analyse(speech(parts, (t) => rising(t) * 1.6), SR);
    const c = k.compare(m, y);
    assert.ok(c.intonation >= 80, `intonation ${c.intonation}`);
    assert.ok(Math.abs(c.pace - 1) < 0.1);
  });
  test('opposite melody scores low', () => {
    const c = k.compare(k.analyse(speech(parts, rising), SR), k.analyse(speech(parts, falling), SR));
    assert.ok(c.intonation < 40, `intonation ${c.intonation}`);
  });
  test('slower with extra pauses gets a tip about it', () => {
    const m = k.analyse(speech([['s', 0.2], ['v', 1.5], ['s', 0.2]]), SR);
    const y = k.analyse(speech([['s', 0.2], ['v', 0.5], ['s', 0.5], ['v', 0.5], ['s', 0.5], ['v', 0.5], ['s', 0.2]]), SR);
    const c = k.compare(m, y);
    assert.ok(c.pace > 1.35);
    assert.equal(c.pauses.extra.length, 2);
    assert.ok(c.tips.some((t) => /longer/.test(t)));
  });
});

describe('sentence frames', () => {
  test('cuts snap to the quiet gap between sentences', () => {
    const s = speech([['v', 1.0], ['s', 0.4], ['v', 2.0]]);
    const env = k.envelope(s, SR);
    const f = k.sentenceFrames(env, 0, env.length - 1, ['Uno due tre.', 'Quattro cinque sei sette otto nove dieci undici.']);
    const cut = f[0][1] * k.FRAME;
    assert.ok(cut > 1.0 && cut < 1.4, `cut at ${cut}`);
  });
});

describe('word check', () => {
  test('marks missing words, ignores accents and case', () => {
    const d = k.wordDiff('Però lì non prendono prenotazioni.', 'pero li prendono prenotazioni');
    assert.deepEqual(d.map((x) => x.ok), [true, true, false, true, true]);
  });
});
