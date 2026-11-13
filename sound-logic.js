// When to ring and what to say about the sound: pure logic, no audio, no page, no import but the fixed texts, so that the
// browser loads this very file and the tests run it as it is. The audio itself is in sound.js, the button in caisse-view.js.
//
// The sound is wanted only after a click on this page (never remembered from an earlier visit), and it is ACTIVE only while the
// browser really lets the audio run: an audio context the browser suspended (or interrupted) is never shown as "activé".
import { TEXTS } from "./caisse-texts.js";

// The bip: two short notes, well under a second, moderate volume (peak gain of the oscillators, 1 = full scale).
export const BEEP = Object.freeze({
  volume: 0.2,
  notes: Object.freeze([
    Object.freeze({ frequency: 660, start: 0, duration: 0.16 }),
    Object.freeze({ frequency: 880, start: 0.2, duration: 0.22 }),
  ]),
});

// Total length of a bip in seconds.
export function beepLength(beep = BEEP) {
  return Math.max(...beep.notes.map((note) => note.start + note.duration));
}

// `state`: { supported, wanted, audioState } where audioState is the state of the AudioContext ("running", "suspended",
// "interrupted", "closed", or "none" before any click).
export function isSoundActive({ supported, wanted, audioState }) {
  return Boolean(supported && wanted && audioState === "running");
}

// What the page shows: the status line, the label of the button, and whether the sound is on.
export function soundLabel(state) {
  if (!state.supported) return { text: TEXTS.soundUnsupported, buttonText: null, active: false };
  const active = isSoundActive(state);
  return {
    text: active ? TEXTS.soundOn : TEXTS.soundOff,
    buttonText: active ? TEXTS.soundDisableButton : TEXTS.soundEnableButton,
    active,
  };
}

// One bip per batch: `newCount` is the number of new payments found in ONE reading (the detector never counts the
// payments of the first load nor the ones of the opening history), so any positive count gives exactly one bip.
export function shouldBeep(state, newCount) {
  return isSoundActive(state) && Number.isInteger(newCount) && newCount > 0;
}
