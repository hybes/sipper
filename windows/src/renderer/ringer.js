// Plays the incoming-call ringtone in the main window (which keeps running while hidden).
// Ported from Sipper/Audio/Ringer.swift; the tones are synthesised by core/ringtones.js.

import { hangupToneWAV, ringtoneWAV } from '../core/ringtones.js';

const urls = new Map();
let hangupURL = null;
let audio = null;
let playing = null;
let previewTimer = null;
const listeners = new Set();

function urlFor(ringtone) {
  if (!urls.has(ringtone)) urls.set(ringtone, URL.createObjectURL(new Blob([ringtoneWAV(ringtone)], { type: 'audio/wav' })));
  return urls.get(ringtone);
}

const notify = () => listeners.forEach((listener) => listener(isRinging()));

export function ring(ringtone, volume) {
  const level = Math.max(0, Math.min(1, volume));
  if (ringtone === 'silent') {
    stopRinging();
    return;
  }
  if (audio && playing === ringtone && !audio.paused) {
    audio.volume = level;
    return;
  }
  stopRinging();
  audio = new Audio(urlFor(ringtone));
  audio.loop = true;
  audio.volume = level;
  playing = ringtone;
  audio.play().catch(() => {});
  notify();
}

export function stopRinging() {
  clearTimeout(previewTimer);
  previewTimer = null;
  if (audio) {
    audio.pause();
    audio = null;
  }
  playing = null;
  notify();
}

/** A few seconds of a ringtone, from Settings. */
export function previewRingtone(ringtone, volume) {
  ring(ringtone, volume);
  previewTimer = setTimeout(stopRinging, 3500);
}

export function isRinging() {
  return Boolean(audio && !audio.paused);
}

export function onRingingChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The short call-ended tone. It does not interrupt a ringtone for another call. */
export function playHangupTone(volume) {
  if (isRinging()) return;
  hangupURL ??= URL.createObjectURL(new Blob([hangupToneWAV()], { type: 'audio/wav' }));
  const tone = new Audio(hangupURL);
  tone.volume = Math.max(0, Math.min(1, volume));
  tone.play().catch(() => {});
}
