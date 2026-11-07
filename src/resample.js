// Band-limited (windowed-sinc) sample-rate conversion.
//
// When downsampling, the filter cutoff drops to just under the new Nyquist
// frequency so aliasing is suppressed. When upsampling, the cutoff stays at
// the source Nyquist. Each output sample's kernel is normalised so a DC input
// stays exactly constant.

// Rates a user is likely to meet, grouped by use.
export const SUPPORTED_RATES = Object.freeze([
  8000,    // telephone and some legacy voice systems
  11025,   // quarter-rate CD-derived
  16000,   // speech recognition and wideband VoIP
  22050,   // half-rate CD-derived
  24000,   // some speech codecs and low-bitrate streaming
  32000,   // broadcast, DVB, older camcorders
  44100,   // CD audio and most music distribution
  48000,   // video and professional audio
]);

// Rates offered for export.
export const EXPORT_RATES = Object.freeze([44100, 48000]);

const HALF_ZEROS = 32;   // filter half-length in zero crossings
const PASSBAND = 0.96;   // fraction of Nyquist kept before the stopband

function blackman(x) {
  // x in -1..1, zero outside
  if (x <= -1 || x >= 1) return 0;
  const p = Math.PI * (x + 1);
  return 0.42 - 0.5 * Math.cos(p) + 0.08 * Math.cos(2 * p);
}

function sinc(x) {
  if (x === 0) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

/**
 * Resample one channel.
 * @param {ArrayLike<number>} input  samples at fromRate
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float64Array} samples at toRate
 */
export function resampleChannel(input, fromRate, toRate) {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error('sample rates must be positive numbers');
  }
  if (fromRate === toRate) return Float64Array.from(input);

  const ratio = toRate / fromRate;           // output samples per input sample
  const outLen = Math.floor(input.length * ratio);
  const out = new Float64Array(outLen);

  // cutoff in cycles per input sample; never above the lower Nyquist
  const fc = 0.5 * Math.min(1, ratio) * PASSBAND;
  // half-width in input samples; wider when downsampling to keep the transition sharp
  const half = HALF_ZEROS / (2 * fc);
  const inLen = input.length;

  for (let i = 0; i < outLen; i++) {
    const t = i / ratio;                     // position in input samples
    const jStart = Math.max(0, Math.ceil(t - half));
    const jEnd = Math.min(inLen - 1, Math.floor(t + half));
    let acc = 0;
    let wsum = 0;
    for (let j = jStart; j <= jEnd; j++) {
      const d = j - t;
      const w = blackman(d / half);
      const h = 2 * fc * sinc(2 * fc * d) * w;
      acc += input[j] * h;
      wsum += h;
    }
    // normalise so DC gain is exactly 1 (also fixes edge truncation)
    out[i] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
}

/**
 * Resample all channels of a buffer to a new rate.
 * @param {ArrayLike<number>[]} channels
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float64Array[]}
 */
export function resampleChannels(channels, fromRate, toRate) {
  return channels.map((c) => resampleChannel(c, fromRate, toRate));
}
