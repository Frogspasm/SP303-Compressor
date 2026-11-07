import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resampleChannel, resampleChannels, SUPPORTED_RATES, EXPORT_RATES } from '../src/resample.js';

function sine(freq, rate, seconds, amp = 0.5) {
  const n = Math.round(rate * seconds);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return x;
}

// RMS over the middle of a signal, away from filter edge effects
function midRms(x) {
  const a = Math.floor(x.length * 0.25);
  const b = Math.floor(x.length * 0.75);
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

test('supported and export rate lists', () => {
  assert.deepEqual([...SUPPORTED_RATES], [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000]);
  assert.deepEqual([...EXPORT_RATES], [44100, 48000]);
});

test('identity when rates match', () => {
  const x = sine(1000, 48000, 0.1);
  const y = resampleChannel(x, 48000, 48000);
  assert.deepEqual(Array.from(y), Array.from(x));
});

test('output length scales with the rate ratio', () => {
  const x = new Float64Array(48000); // 1 s
  assert.equal(resampleChannel(x, 48000, 44100).length, 44100);
  assert.equal(resampleChannel(x, 48000, 8000).length, 8000);
  assert.equal(resampleChannel(new Float64Array(8000), 8000, 48000).length, 48000);
});

test('DC input stays at DC after resampling', () => {
  const x = new Float64Array(8000).fill(0.7);
  for (const to of [8000, 16000, 44100, 48000]) {
    const y = resampleChannel(x, 8000, to);
    // check interior samples; the edges are normalised but kept close
    for (let i = 100; i < y.length - 100; i++) {
      assert.ok(Math.abs(y[i] - 0.7) < 1e-6, `DC drifted at ${to} Hz: ${y[i]}`);
    }
  }
});

test('a 1 kHz tone keeps its level when going 48k -> 44.1k', () => {
  const x = sine(1000, 48000, 1, 0.5);
  const y = resampleChannel(x, 48000, 44100);
  const expected = 0.5 / Math.SQRT2;
  assert.ok(Math.abs(midRms(y) - expected) < 0.01, `rms ${midRms(y)} vs ${expected}`);
});

test('a 1 kHz tone keeps its frequency when going 44.1k -> 48k', () => {
  const x = sine(1000, 44100, 1, 0.5);
  const y = resampleChannel(x, 44100, 48000);
  // compare against a reference 1 kHz sine at 48 kHz, offset by the filter delay (~0)
  const ref = sine(1000, 48000, 1, 0.5);
  let err = 0;
  const a = Math.floor(y.length * 0.25);
  const b = Math.floor(y.length * 0.75);
  for (let i = a; i < b; i++) err = Math.max(err, Math.abs(y[i] - ref[i]));
  assert.ok(err < 0.02, `max deviation ${err}`);
});

test('downsampling suppresses content above the new Nyquist (anti-aliasing)', () => {
  // 12 kHz is above 8 kHz Nyquist, so it must not fold back as an alias
  const x = sine(12000, 48000, 1, 0.5);
  const y = resampleChannel(x, 48000, 8000);
  assert.ok(midRms(y) < 0.005, `aliased energy too high: ${midRms(y)}`);
});

test('content inside the band survives downsampling', () => {
  const x = sine(2000, 48000, 1, 0.5);
  const y = resampleChannel(x, 48000, 16000);
  assert.ok(Math.abs(midRms(y) - 0.5 / Math.SQRT2) < 0.01);
});

test('round trip 44.1k -> 48k -> 44.1k keeps a mid-band tone', () => {
  const x = sine(1500, 44100, 1, 0.5);
  const back = resampleChannel(resampleChannel(x, 44100, 48000), 48000, 44100);
  assert.ok(Math.abs(midRms(back) - 0.5 / Math.SQRT2) < 0.01);
});

test('every supported rate converts to both export rates without error', () => {
  const x = sine(500, 16000, 0.1, 0.3);
  for (const from of SUPPORTED_RATES) {
    for (const to of EXPORT_RATES) {
      const y = resampleChannel(x, from, to);
      assert.ok(y.length > 0);
      for (const v of y) assert.ok(Number.isFinite(v));
    }
  }
});

test('resampleChannels handles stereo and keeps channels independent', () => {
  const l = sine(1000, 48000, 0.2, 0.5);
  const r = new Float64Array(l.length);
  const [outL, outR] = resampleChannels([l, r], 48000, 44100);
  assert.equal(outL.length, outR.length);
  assert.ok(midRms(outL) > 0.2);
  assert.ok(midRms(outR) < 1e-9);
});

test('invalid rates are rejected', () => {
  assert.throws(() => resampleChannel(new Float64Array(10), 0, 44100));
  assert.throws(() => resampleChannel(new Float64Array(10), 48000, NaN));
});
