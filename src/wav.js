// Minimal WAV helpers. Browser decoding of arbitrary files uses decodeAudioData;
// decodeWav16 exists so the test suite can round-trip without a browser.

export function encodeWav16(channels, sampleRate) {
  const numCh = channels.length;
  const numFrames = channels[0].length;
  const dataBytes = numFrames * numCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);            // PCM fmt chunk size
  v.setUint16(20, 1, true);             // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * 2, true);
  v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      v.setInt16(off, Math.round(s < 0 ? s * 32768 : s * 32767), true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

export function decodeWav16(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readStr = (off, n) => String.fromCharCode(...bytes.subarray(off, off + n));
  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') throw new Error('not a WAV file');

  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= bytes.length) {
    const id = readStr(off, 4);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { start: body, size };
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('only 16-bit PCM is supported here');

  const frames = Math.floor(data.size / (fmt.channels * 2));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  let p = data.start;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < fmt.channels; ch++) {
      channels[ch][i] = v.getInt16(p, true) / 32768;
      p += 2;
    }
  }
  return { sampleRate: fmt.sampleRate, channels };
}
