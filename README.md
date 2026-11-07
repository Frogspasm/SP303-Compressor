# Vinyl Sim

A browser app that applies an approximation of SP-303-style "Vinyl Sim" processing
to your own audio: input level, a tone curve, a compressor, soft saturation, and
vinyl crackle and hiss.

It is an approximation built from measured spectral and dynamic behaviour of
test recordings. It is not a model of Roland's circuit or of the SP-303's
sample codec.

## Run it

No build step. Serve the folder and open it in a browser:

```sh
npm start        # python3 -m http.server 8080
# then open http://localhost:8080
```

Audio stays in your browser. Nothing is uploaded.

## Controls

- **Volume**: input level (-40 dB to 0 dB).
- **Compress**: compressor depth. Raises the threshold from -30 to -6 dB and adds up to 8 dB of makeup gain.
- **Noise**: crackle density and hiss level. Seeded, so the same settings give the same output.

## Layout

- `src/sp303-dsp.js`: the processing chain (`processSP303`), with no browser dependencies. Controls: `volume`, `compress`, `transient`, `noise`.
- `src/wav.js`: 16-bit WAV encoder, plus a decoder used by the tests.
- `src/resample.js`: band-limited (windowed-sinc) resampling between any pair of rates. `SUPPORTED_RATES` lists 8, 11.025, 16, 22.05, 24, 32, 44.1 and 48 kHz. The app's "Working rate" menu offers all of them. `EXPORT_RATES` (44.1 and 48 kHz) is the list for the "Export rate" menu.
- `src/app.js`, `index.html`: the browser UI.
- `test/sp303-dsp.test.js`: unit tests for the DSP and WAV code.

## Resampling

```js
import { resampleChannels } from './src/resample.js';
const out = resampleChannels(channels, 8000, 44100); // Float64Array[]
```

Downsampling applies an anti-aliasing filter below the new Nyquist frequency, so tones above it are removed rather than folded back. Upsampling does not add detail that wasn't there.

## Tests

```sh
npm test
```

## Known gaps

- The tone curve matches the measured 1–4 kHz hump and the top-end rolloff, but the 4–10 kHz band is about 2–3 dB brighter than measured. Tuning is in `src/sp303-dsp.js`.
- The compressor's threshold, ratio, and timing are chosen by hand. They are not derived from hardware measurements.
- **Transient** and **program-dependent release** are modelled from forum and video descriptions, not measured. The Transient slider slows the gain attack, so a hit's first 4–20 ms pass through. Release lengthens after sustained compression, so a dense section recovers more slowly than a brief hit. Neither has been checked against the hardware, since the test recordings contain no drum hits.
- No dry (unprocessed) reference recordings have been compared sample by sample, so the chain has not been checked against the hardware.
- **Working rate** (any supported rate): the sample is resampled to this rate before processing, so the effect works at that bandwidth.
- **Export rate** (44.1 or 48 kHz): the processed audio is resampled to this rate for "Play processed" and the download.
