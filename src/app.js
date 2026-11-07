import { processSP303, DEFAULT_PARAMS } from './sp303-dsp.js';
import { encodeWav16 } from './wav.js';
import { resampleChannels } from './resample.js';

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file'), drop: $('drop'), status: $('status'),
  volume: $('volume'), compress: $('compress'), noise: $('noise'),
  playOriginal: $('play-original'), playProcessed: $('play-processed'),
  stop: $('stop'), download: $('download'),
};

let ctx = null;
let source = null;      // AudioBuffer of the loaded file
let processed = null;   // { channels: Float64Array[], sampleRate }
let fileName = 'audio';
let activeNode = null;

const fmtPct = (v) => `${Math.round(v * 100)}%`;

function readParams() {
  return {
    volume: parseFloat(els.volume.value),
    compress: parseFloat(els.compress.value),
    noise: parseFloat(els.noise.value),
    seed: DEFAULT_PARAMS.seed,
  };
}

function updateOutputs() {
  for (const k of ['volume', 'compress', 'noise']) {
    els[k].nextElementSibling.textContent = fmtPct(parseFloat(els[k].value));
  }
}

function setStatus(msg) { els.status.textContent = msg; }

function setReady(ready) {
  els.playOriginal.disabled = !ready;
  els.playProcessed.disabled = !ready;
  els.download.disabled = !ready;
}

function runProcess() {
  if (!source) return;
  const channels = [];
  for (let c = 0; c < source.numberOfChannels; c++) channels.push(source.getChannelData(c));
  const t0 = performance.now();
  const out = processSP303(channels, source.sampleRate, readParams());
  processed = { channels: out, sampleRate: source.sampleRate };
  const ms = Math.round(performance.now() - t0);
  setStatus(`${fileName}: processed in ${ms} ms`);
}

function audioContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function playBuffer(channels, sampleRate) {
  stopPlayback();
  const ac = audioContext();
  const buf = ac.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(Float32Array.from(c), i));
  const node = ac.createBufferSource();
  node.buffer = buf;
  node.connect(ac.destination);
  node.start();
  activeNode = node;
  node.onended = () => { if (activeNode === node) activeNode = null; };
}

function stopPlayback() {
  if (activeNode) {
    try { activeNode.stop(); } catch (_) { /* already stopped */ }
    activeNode = null;
  }
}

async function loadFile(file) {
  setStatus(`Decoding ${file.name}…`);
  setReady(false);
  try {
    const bytes = await file.arrayBuffer();
    const ac = audioContext();
    source = await ac.decodeAudioData(bytes);
    fileName = file.name;
    setStatus(`${file.name}: ${source.duration.toFixed(1)} s, ${source.numberOfChannels} ch, ${source.sampleRate} Hz`);
    runProcess();
    setReady(true);
  } catch (err) {
    source = null;
    setStatus(`Could not decode that file: ${err.message || err}`);
  }
}

function download() {
  if (!processed) return;
  const exportRate = parseInt($('export-rate').value, 10);
  const channels = resampleChannels(processed.channels, processed.sampleRate, exportRate);
  const wav = encodeWav16(channels, exportRate);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = fileName.replace(/\.[^.]+$/, '');
  a.href = url;
  a.download = `${base}-vinylsim-${exportRate / 1000}k.wav`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----- wiring -----

els.file.addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadFile(f);
});

for (const ev of ['dragenter', 'dragover']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('over'); });
}
els.drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

for (const k of ['volume', 'compress', 'noise']) {
  els[k].addEventListener('input', updateOutputs);
  els[k].addEventListener('change', runProcess);
}

els.playOriginal.addEventListener('click', () => {
  if (!source) return;
  const channels = [];
  for (let c = 0; c < source.numberOfChannels; c++) channels.push(source.getChannelData(c));
  playBuffer(channels, source.sampleRate);
});
els.playProcessed.addEventListener('click', () => {
  if (processed) playBuffer(processed.channels, processed.sampleRate);
});
els.stop.addEventListener('click', stopPlayback);
els.download.addEventListener('click', download);

updateOutputs();
