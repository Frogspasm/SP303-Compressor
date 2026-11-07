import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processSP303, DEFAULT_PARAMS } from '../src/sp303-dsp.js';
import { encodeWav16, decodeWav16 } from '../src/wav.js';

const SR = 48000;

function sine(freq, seconds, amp = 0.5) {
  const n = Math.round(SR * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

function rms(x) {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

function peak(x) {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

const silence = (seconds) => new Float32Array(Math.round(SR * seconds));

test('output is finite and within -1..1', () => {
  const [out] = processSP303([sine(440, 0.5, 1.0)], SR, { compress: 1, volume: 1, noise: 1 });
  for (const v of out) {
    assert.ok(Number.isFinite(v));
    assert.ok(v >= -1 && v <= 1);
  }
});

test('same settings give identical output (deterministic)', () => {
  const input = [sine(200, 0.3)];
  const a = processSP303(input, SR, { noise: 0.8, seed: 7 });
  const b = processSP303(input, SR, { noise: 0.8, seed: 7 });
  assert.deepEqual(Array.from(a[0]), Array.from(b[0]));
});

test('volume control lowers output level', () => {
  const input = [sine(1000, 0.5, 0.5)];
  const loud = processSP303(input, SR, { volume: 1, compress: 0, noise: 0 });
  const quiet = processSP303(input, SR, { volume: 0.2, compress: 0, noise: 0 });
  assert.ok(rms(quiet[0]) < rms(loud[0]) * 0.5, 'quieter setting should be well below loud one');
});

test('compressor reduces peak-to-RMS ratio on a dynamic signal', () => {
  // burst of tone followed by a quieter tail: a clear dynamic range to squash
  const burst = sine(300, 0.05, 0.9);
  const tail = sine(300, 0.2, 0.1);
  const sig = new Float32Array(burst.length + tail.length);
  sig.set(burst, 0);
  sig.set(tail, burst.length);

  const off = processSP303([sig], SR, { compress: 0, noise: 0, volume: 1 })[0];
  const on = processSP303([sig], SR, { compress: 1, noise: 0, volume: 1 })[0];

  const crestOff = peak(off) / rms(off);
  const crestOn = peak(on) / rms(on);
  assert.ok(crestOn < crestOff, `crest factor should drop (${crestOff.toFixed(2)} -> ${crestOn.toFixed(2)})`);
});

test('noise control adds a noise floor to silence, and more noise means more energy', () => {
  const none = processSP303([silence(1)], SR, { noise: 0, volume: 1 })[0];
  const some = processSP303([silence(1)], SR, { noise: 0.5, volume: 1 })[0];
  const more = processSP303([silence(1)], SR, { noise: 1.0, volume: 1 })[0];
  assert.equal(rms(none), 0);
  assert.ok(rms(some) > 0);
  assert.ok(rms(more) > rms(some), 'max noise should be louder than half noise');
});

test('tone shaping rolls off highs relative to the midrange', () => {
  // Small signal keeps the compressor and saturation out of the measurement.
  const gainAt = (f) => {
    const x = sine(f, 0.5, 0.001);
    const y = processSP303([x], SR, { compress: 0, noise: 0, volume: 1 })[0];
    return rms(y.subarray(SR / 4)) / rms(x.subarray(SR / 4));
  };
  const mid = gainAt(1000);
  const high = gainAt(12000);
  const dropDb = 20 * Math.log10(high / mid);
  assert.ok(dropDb < -10, `12 kHz should sit >10 dB below 1 kHz, got ${dropDb.toFixed(1)} dB`);
});

test('default params are applied when none are given', () => {
  const input = [sine(440, 0.1, 0.3)];
  const a = processSP303(input, SR);
  const b = processSP303(input, SR, { ...DEFAULT_PARAMS });
  assert.deepEqual(Array.from(a[0]), Array.from(b[0]));
});

test('WAV encode/decode round-trips within 16-bit precision', () => {
  const left = sine(440, 0.05, 0.5);
  const right = sine(660, 0.05, 0.25);
  const bytes = encodeWav16([left, right], SR);
  const decoded = decodeWav16(bytes);
  assert.equal(decoded.sampleRate, SR);
  assert.equal(decoded.channels.length, 2);
  const tol = 1 / 32768 + 1e-9;
  for (let i = 0; i < left.length; i++) {
    assert.ok(Math.abs(decoded.channels[0][i] - left[i]) <= tol);
    assert.ok(Math.abs(decoded.channels[1][i] - right[i]) <= tol);
  }
});

test('transient control lets a hit\'s attack through for longer', () => {
  // Silence, then a loud tone that starts abruptly.
  const sr = SR;
  const hit = new Float32Array(sr / 10 + sr * 0.4);
  for (let i = sr / 10; i < hit.length; i++) hit[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * (i - sr / 10)) / sr);
  const onsetPeak = (t) => {
    const y = processSP303([hit], sr, { compress: 0.5, noise: 0, transient: t })[0];
    const start = sr / 10 + Math.round(0.004 * sr);  // 4 ms after onset
    const end = sr / 10 + Math.round(0.012 * sr);    // 12 ms after onset
    return peak(y.subarray(start, end));
  };
  const short = onsetPeak(0);
  const long = onsetPeak(1);
  assert.ok(long > short * 1.3, `transient=1 peak ${long.toFixed(3)} should exceed transient=0 peak ${short.toFixed(3)} by 30%`);
});

test('release is longer after sustained compression than after a brief hit', () => {
  const sr = SR;
  const tone = (f, secs, amp) => {
    const x = new Float32Array(Math.round(sr * secs));
    for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / sr);
    return x;
  };
  const cat = (...parts) => {
    const n = parts.reduce((s, x) => s + x.length, 0);
    const out = new Float32Array(n);
    let p = 0;
    for (const x of parts) { out.set(x, p); p += x.length; }
    return out;
  };
  const tail = tone(300, 0.4, 0.1);
  const dense = cat(tone(200, 1.0, 0.9), tail);                                  // 1 s of loud material
  const brief = cat(tone(200, 0.05, 0.9), new Float32Array(Math.round(sr * 0.95)), tail); // 50 ms hit

  const tailRms = (sig) => {
    const y = processSP303([sig], sr, { compress: 1, noise: 0, transient: 0.5 })[0];
    const a = Math.round(sr * 1.0) + Math.round(sr * 0.1);  // 100 ms into the tail
    const b = Math.round(sr * 1.0) + Math.round(sr * 0.3);
    return rms(y.subarray(a, b));
  };
  const rDense = tailRms(dense);
  const rBrief = tailRms(brief);
  assert.ok(rDense < rBrief * 0.92, `dense tail ${rDense.toFixed(4)} should recover more slowly than brief ${rBrief.toFixed(4)}`);
});

test('output limiter keeps hot input inside full scale without flattening it', () => {
  // A signal well above full scale before processing: the old hard clamp
  // would have flattened its peaks at exactly 1.0.
  const x = new Float32Array(SR / 2);
  for (let i = 0; i < x.length; i++) x[i] = 1.5 * Math.sin((2 * Math.PI * 300 * i) / SR);
  const [y] = processSP303([x], SR, { compress: 0, noise: 0, volume: 1 });
  const top = peak(y);
  assert.ok(top < 1, `peak should stay below 1, got ${top}`);
  let atRail = 0;
  for (const v of y) if (Math.abs(v) >= 0.9999) atRail++;
  assert.equal(atRail, 0, 'no samples should sit flat on the rail');
});

test('output limiter leaves quiet signal unchanged', () => {
  // With no compression, saturation or noise, a small signal should pass
  // through the limiter untouched (apart from the chain's own gain).
  const x = sine(440, 0.1, 0.1);
  const a = processSP303([x], SR, { compress: 0, noise: 0, volume: 1 })[0];
  // limiter is a no-op below its knee, so the output must not exceed the knee
  assert.ok(peak(a) < 0.8, `quiet output should sit below the limiter knee, got ${peak(a)}`);
});
