// Approximate SP-303 "Vinyl Sim"-style processing chain.
//
// This is an emulation *approximation* built from measured behaviour
// (spectral shape, level/noise response, dynamics) of test recordings.
// It is not a model of Roland's circuit or of the SP-303's sample codec.
//
// Chain: input gain -> tone shaping (EQ) -> feed-forward compressor
//        -> soft saturation -> vinyl noise (crackle + hiss) -> soft output limiter.
//
// Compressor behaviour (both unverified against hardware; see README):
//  - Transient preservation: the gain's attack is slowed by the Transient
//    control, so the first few milliseconds of a hit pass through before the
//    squash takes hold.
//  - Program-dependent release: the release lengthens when the compressor has
//    been working hard on average, and stays near the base time for brief hits.

export const DEFAULT_PARAMS = Object.freeze({
  volume: 1.0,   // 0..1  input level (maps to -40..0 dB)
  compress: 0.5, // 0..1  compressor depth (threshold and makeup gain)
  transient: 0.5, // 0..1 how much of each hit's attack passes through the compressor
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

// Keep filter frequencies safely below Nyquist. A corner at or above
// Nyquist makes the biquad unstable, which produced NaNs at low sample rates.
const MAX_CORNER_RATIO = 0.45;

function safeCorner(f0, sampleRate) {
  return Math.min(f0, MAX_CORNER_RATIO * sampleRate);
}

function biquadCoeffs(type, f0Requested, sampleRate, q, gainDb = 0) {
  const f0 = safeCorner(f0Requested, sampleRate);
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

// Gain reduction in dB (>= 0) for a detector level, with a soft knee.
function grDb(env, params) {
  const { thresholdDb, ratio, kneeDb } = params;
  const over = linToDb(env) - thresholdDb;
  if (over <= -kneeDb / 2) return 0;
  if (over >= kneeDb / 2) return over * (1 - 1 / ratio);
  const t = over + kneeDb / 2;
  return (t * t) / (2 * kneeDb) * (1 - 1 / ratio);
}

const COMP_DYN = {
  gainAttackMsMin: 0.2,   // transient = 0: near-instant gain attack
  gainAttackMsMax: 15,    // transient = 1: hits keep their first few ms
  grAvgMs: 300,           // how far back "program density" looks
  grAvgRef: 12,           // average GR (dB) that counts as dense material
  releaseScaleMax: 3,     // release is up to 3x longer on dense material
};

function compress(channels, sampleRate, compressAmt, transientAmt) {
  const n = channels[0].length;
  // compress 0..1 -> threshold -30..-6 dB, makeup 0..8 dB
  const thresholdDb = -30 + 24 * compressAmt;
  const makeup = dbToLin(8 * compressAmt);
  const curve = { thresholdDb, ratio: COMP.ratio, kneeDb: COMP.kneeDb };

  // detector: fast peak follower
  const aA = Math.exp(-1 / ((COMP.attackMs / 1000) * sampleRate));
  const aR = Math.exp(-1 / ((COMP.releaseMs / 1000) * sampleRate));
  // gain smoothing: attack set by transient amount
  const gainAttackMs = COMP_DYN.gainAttackMsMin +
    (COMP_DYN.gainAttackMsMax - COMP_DYN.gainAttackMsMin) * transientAmt;
  const aGA = Math.exp(-1 / ((gainAttackMs / 1000) * sampleRate));
  // slow average of gain reduction, used to make release program-dependent
  const aGrAvg = Math.exp(-1 / ((COMP_DYN.grAvgMs / 1000) * sampleRate));

  const out = channels.map((c) => new Float64Array(c.length));
  let env = 0;
  let gainDb = 0;   // smoothed gain (dB, <= 0)
  let grAvg = 0;    // smoothed gain reduction (dB, >= 0)
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const c of channels) peak = Math.max(peak, Math.abs(c[i]));
    const coef = peak > env ? aA : aR;
    env = coef * env + (1 - coef) * peak;

    const gr = grDb(env, curve);
    const target = -gr;
    grAvg = aGrAvg * grAvg + (1 - aGrAvg) * gr;

    let g;
    if (target < gainDb) {
      g = aGA;   // gain is falling: attack
    } else {
      // gain is recovering: release, longer on dense material
      const density = Math.min(1, grAvg / COMP_DYN.grAvgRef);
      const relMs = COMP.releaseMs * (1 + (COMP_DYN.releaseScaleMax - 1) * density);
      g = Math.exp(-1 / ((relMs / 1000) * sampleRate));
    }
    gainDb = g * gainDb + (1 - g) * target;

    const lin = dbToLin(gainDb) * makeup;
    for (let ch = 0; ch < channels.length; ch++) out[ch][i] = channels[ch][i] * lin;
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
  const a = Math.exp((-2 * Math.PI * safeCorner(6000, sampleRate)) / sampleRate);
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

// ---------- output limiter ----------
// Below the knee the signal passes unchanged. Above it, peaks bend smoothly
// towards full scale instead of being clipped flat, so the output never
// exceeds +/-1 and the top of a hot signal keeps a rounded shape.

const LIMIT_KNEE = 0.8;

function softLimitSample(v) {
  const a = Math.abs(v);
  if (a <= LIMIT_KNEE) return v;
  const room = 1 - LIMIT_KNEE;
  const y = LIMIT_KNEE + room * Math.tanh((a - LIMIT_KNEE) / room);
  return v < 0 ? -y : y;
}

function softLimit(x) {
  for (let i = 0; i < x.length; i++) x[i] = softLimitSample(x[i]);
  return x;
}

/** Soft-limit channels in place so no sample exceeds +/-1. Used after resampling, which can overshoot. */
export function limitChannels(channels) {
  for (const c of channels) softLimit(c);
  return channels;
}

// ---------- public API ----------

/**
 * Process an array of channels (Float32Array or Float64Array, values -1..1).
 * Returns a new array of Float64Array channels, soft-limited into -1..1.
 */
export function processSP303(channels, sampleRate, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const volume = clamp01(p.volume);
  const compressAmt = clamp01(p.compress);
  const transientAmt = clamp01(p.transient);
  const noiseAmt = clamp01(p.noise);
  const inGain = dbToLin(-40 + 40 * volume);

  // input gain + tone shaping, per channel
  const shaped = channels.map((c) => {
    const scaled = new Float64Array(c.length);
    for (let i = 0; i < c.length; i++) scaled[i] = c[i] * inGain;
    return toneShape(scaled, sampleRate);
  });

  const compressed = compress(shaped, sampleRate, compressAmt, transientAmt);

  const rng = makeRng(p.seed);
  return compressed.map((c) => {
    saturate(c);
    addVinylNoise(c, sampleRate, noiseAmt, rng);
    softLimit(c);
    return c;
  });
}
