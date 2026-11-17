// When to ring and what to say about the sound: pure logic, no audio, no page, no import but the fixed texts, so that the
// browser loads this very file and the tests run it as it is. The audio itself is in sound.js, the button in caisse-view.js.
//
// The sound is wanted by default (unless the user cut it, which is remembered), but browsers refuse sound before a gesture on the
// page: it is ACTIVE only while the browser really lets the audio run. An audio context not running yet, suspended or interrupted
// is never shown as "activé": it is "en attente" until a touch on the page unlocks it.
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

// The status line of the sound, always in words. "Son activé" only while the browser really runs the audio: a sound that is
// wanted (the default) but whose audio context is not running yet or any more is "en attente" (a touch on the page unlocks it).
export function soundText(state) {
  if (!state.supported) return TEXTS.soundUnsupported;
  if (!state.wanted) return TEXTS.soundOff;
  return isSoundActive(state) ? TEXTS.soundOn : TEXTS.soundWaiting;
}

// What the page shows for the sound line: the text and whether the sound is on (the button is worked out with the
// notifications, see controls-logic.js).
export function soundLabel(state) {
  return { text: soundText(state), active: isSoundActive(state) };
}

// Is the sound wanted at the start? Yes, unless the user cut it on this browser (stored as "off"). Anything else, or a storage
// that does not answer, means yes: the default is "on".
export function initialWanted(stored) {
  return stored !== "off";
}

// One bip per batch: `newCount` is the number of new payments found in ONE reading (the detector never counts the
// payments of the first load nor the ones of the opening history), so any positive count gives exactly one bip.
export function shouldBeep(state, newCount) {
  return isSoundActive(state) && Number.isInteger(newCount) && newCount > 0;
}
