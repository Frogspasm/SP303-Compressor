// Approximate SP-303 "Vinyl Sim"-style processing chain.
//
// This is an emulation *approximation* built from measured behaviour
// (spectral shape, level/noise response, dynamics) of test recordings.
// It is not a model of Roland's circuit or of the SP-303's sample codec.
//
// Chain: input gain -> tone shaping (EQ) -> feed-forward compressor
//        -> soft saturation -> vinyl noise (crackle + hiss) -> output clamp.

export const DEFAULT_PARAMS = Object.freeze({
  volume: 1.0,   // 0..1  input level (maps to -40..0 dB)
  compress: 0.5, // 0..1  compressor depth (threshold and makeup gain)
  noise: 0.5,    // 0..1  vinyl crackle + hiss level
  seed: 1,       // integer seed so the noise is repeatable
});

// ---------- small helpers ----------

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (x) => 20 * Math.log10(Math.max(x, 1e-9));

// Deterministic PRNG (mulberry32) so the same settings always give the same output.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- RBJ biquad filters ----------

function biquadCoeffs(type, f0, sampleRate, q, gainDb = 0) {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === 'peaking') {
    const A = Math.pow(10, gainDb / 40);
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  } else {
    throw new Error(`unknown filter type: ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquad(x, c) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = xi;
    y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

// ---------- tone shaping ----------
// Shape taken from the measured spectra: roughly flat below 500 Hz, a broad
// hump near 1.4 kHz, then a steep rolloff above ~9 kHz.
const TONE_LOWPASS = { f0: 9000, q: 0.7 };
const TONE_MIDCUT = { f0: 6500, q: 0.5 };
const TONE_HUMP = { f0: 1400, q: 0.9, gainDb: 3 };

function toneShape(x, sampleRate) {
  const lp = biquadCoeffs('lowpass', TONE_LOWPASS.f0, sampleRate, TONE_LOWPASS.q);
  const mid = biquadCoeffs('lowpass', TONE_MIDCUT.f0, sampleRate, TONE_MIDCUT.q);
  const pk = biquadCoeffs('peaking', TONE_HUMP.f0, sampleRate, TONE_HUMP.q, TONE_HUMP.gainDb);
  return applyBiquad(applyBiquad(applyBiquad(x, pk), lp), mid);
}

// ---------- compressor ----------
// Feed-forward, stereo-linked, soft knee. Fast attack, moderate release.

const COMP = { ratio: 8, kneeDb: 6, attackMs: 1, releaseMs: 120 };

function compressorGainCurve(env, params) {
  // env is a per-sample level (linear); returns gain in linear units
  const { thresholdDb, ratio, kneeDb } = params;
  const xdb = linToDb(env);
  const over = xdb - thresholdDb;
  let gr; // gain reduction in dB (>= 0)
  if (over <= -kneeDb / 2) {
    gr = 0;
  } else if (over >= kneeDb / 2) {
    gr = over * (1 - 1 / ratio);
  } else {
    const t = over + kneeDb / 2;
    gr = (t * t) / (2 * kneeDb) * (1 - 1 / ratio);
  }
  return dbToLin(-gr);
}

function compress(channels, sampleRate, compressAmt) {
  const n = channels[0].length;
  // compress 0..1 -> threshold -30..-6 dB, makeup 0..8 dB
  const thresholdDb = -30 + 24 * compressAmt;
  const makeup = dbToLin(8 * compressAmt);
  const aA = Math.exp(-1 / ((COMP.attackMs / 1000) * sampleRate));
  const aR = Math.exp(-1 / ((COMP.releaseMs / 1000) * sampleRate));
  const curve = { thresholdDb, ratio: COMP.ratio, kneeDb: COMP.kneeDb };

  const out = channels.map((c) => new Float64Array(c.length));
  let env = 0;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const c of channels) peak = Math.max(peak, Math.abs(c[i]));
    const coef = peak > env ? aA : aR;
    env = coef * env + (1 - coef) * peak;
    const g = compressorGainCurve(env, curve) * makeup;
    for (let ch = 0; ch < channels.length; ch++) out[ch][i] = channels[ch][i] * g;
  }
  return out;
}

// ---------- saturation ----------

function saturate(x) {
  // Gentle tanh curve, normalised so small signals pass near unity.
  const drive = 1.5;
  const norm = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(drive * x[i]) / norm;
  return x;
}

// ---------- vinyl noise ----------
// Crackle: sparse short decaying clicks. Hiss: low-passed white noise.

function addVinylNoise(x, sampleRate, noiseAmt, rng) {
  if (noiseAmt <= 0) return x;
  const hissAmp = noiseAmt * 0.004;      // about -48 dBFS at full setting
  const crackleAmp = noiseAmt * 0.08;    // peak click height at full setting
  const clicksPerSec = noiseAmt * 25;    // density at full setting
  const pClick = clicksPerSec / sampleRate;

  // hiss: one-pole low-pass on white noise
  const a = Math.exp((-2 * Math.PI * 6000) / sampleRate);
  let hiss = 0;

  let clickEnv = 0;
  const clickDecay = Math.exp(-1 / (0.0008 * sampleRate)); // ~0.8 ms decay
  for (let i = 0; i < x.length; i++) {
    hiss = a * hiss + (1 - a) * (rng() * 2 - 1);
    if (rng() < pClick) clickEnv = crackleAmp * (rng() * 2 - 1);
    x[i] += hissAmp * hiss * 4 + clickEnv;
    clickEnv *= clickDecay;
  }
  return x;
}

// ---------- public API ----------

/**
 * Process an array of channels (Float32Array or Float64Array, values -1..1).
 * Returns a new array of Float64Array channels, clamped to -1..1.
 */
export function processSP303(channels, sampleRate, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const volume = clamp01(p.volume);
  const compressAmt = clamp01(p.compress);
  const noiseAmt = clamp01(p.noise);
  const inGain = dbToLin(-40 + 40 * volume);

  // input gain + tone shaping, per channel
  const shaped = channels.map((c) => {
    const scaled = new Float64Array(c.length);
    for (let i = 0; i < c.length; i++) scaled[i] = c[i] * inGain;
    return toneShape(scaled, sampleRate);
  });

  const compressed = compress(shaped, sampleRate, compressAmt);

  const rng = makeRng(p.seed);
  return compressed.map((c) => {
    saturate(c);
    addVinylNoise(c, sampleRate, noiseAmt, rng);
    for (let i = 0; i < c.length; i++) {
      if (c[i] > 1) c[i] = 1;
      else if (c[i] < -1) c[i] = -1;
    }
    return c;
  });
}
