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
