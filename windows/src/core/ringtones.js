// Ringtones synthesised in memory as 16-bit mono WAV, so the app ships no audio files.
// Ported from Sipper/Audio/Ringer.swift (RingtoneSynth); the renderer plays the result.

export const RINGTONE_SAMPLE_RATE = 22050;

const cache = new Map();

export function ringtoneWAV(choice) {
  if (!cache.has(choice)) cache.set(choice, wav(samplesFor(choice)));
  return cache.get(choice);
}

function samplesFor(choice) {
  switch (choice) {
    case 'classicUS':
      return cadence([[2.0, true], [4.0, false]], (t) => dualTone(t, 440, 480));
    case 'digital':
      return cadence([[0.5, true], [0.25, false], [0.5, true], [1.75, false]], (t) => {
        const warble = Math.floor(t / 0.04) % 2 === 0;
        return Math.sin(2 * Math.PI * (warble ? 1200 : 1600) * t) * 0.7;
      });
    case 'marimba':
      return marimba();
    case 'silent':
      return new Float32Array(RINGTONE_SAMPLE_RATE);
    case 'classicUK':
    default:
      return cadence([[0.4, true], [0.2, false], [0.4, true], [2.0, false]], (t) => dualTone(t, 400, 450));
  }
}

function dualTone(t, f1, f2) {
  return (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t)) * 0.45;
}

/** One loop of on/off segments with 5 ms fades to avoid clicks. */
function cadence(segments, tone) {
  const out = [];
  const fade = Math.floor(RINGTONE_SAMPLE_RATE * 0.005);
  for (const [duration, on] of segments) {
    const count = Math.floor(duration * RINGTONE_SAMPLE_RATE);
    for (let i = 0; i < count; i++) {
      if (!on) {
        out.push(0);
        continue;
      }
      let amplitude = tone(i / RINGTONE_SAMPLE_RATE);
      if (i < fade) amplitude *= i / fade;
      if (i > count - fade) amplitude *= (count - i) / fade;
      out.push(amplitude);
    }
  }
  return Float32Array.from(out);
}

function marimba() {
  const notes = [659.25, 783.99, 987.77, 1318.51, 987.77, 783.99];
  const out = [];
  const count = Math.floor(0.22 * RINGTONE_SAMPLE_RATE);
  for (const note of notes) {
    for (let i = 0; i < count; i++) {
      const t = i / RINGTONE_SAMPLE_RATE;
      out.push((Math.sin(2 * Math.PI * note * t) * 0.6 + Math.sin(2 * Math.PI * note * 4 * t) * 0.15) * Math.exp(-t * 9));
    }
  }
  for (let i = 0; i < Math.floor(1.6 * RINGTONE_SAMPLE_RATE); i++) out.push(0);
  return Float32Array.from(out);
}

function wav(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RINGTONE_SAMPLE_RATE, true);
  view.setUint32(28, RINGTONE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32000), true);
  });
  return bytes;
}
