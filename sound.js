// The audio of the cash register page: Web Audio only, no sound file, no library. The bip is generated (two short sine notes, see
// BEEP in sound-logic.js). The rules (when to ring, what to say) are in sound-logic.js; this file only touches the audio.
//
// The sound is wanted by default, and the choice to cut it is remembered (`storage`, which never throws). Browsers refuse sound
// before a gesture on the page, so while the sound is wanted but the audio is not running, the first click, touch or key anywhere on
// the page creates or resumes the AudioContext (listeners put once, removed as soon as the audio runs). Nothing rings for that
// gesture: only the button plays a test bip.
import { BEEP, initialWanted } from "./sound-logic.js";

const STORAGE_KEY = "caisse-son";
// Events that count as a user gesture for audio in the browsers (touch and mouse have different ones).
const GESTURES = ["pointerdown", "pointerup", "touchend", "click", "keydown"];

// `AudioContextClass`: window.AudioContext (or webkitAudioContext), undefined when the browser has none. `storage`: { get(key), set(key, value) }
// that never throws. `gestureTarget`: the document (addEventListener / removeEventListener). `onChange`: called when something the page
// shows may have changed (the browser suspends or resumes the audio by itself, e.g. on a phone call).
export function createSound({ AudioContextClass, storage = { get: () => null, set: () => {} }, gestureTarget = null, onChange = () => {} }) {
  const supported = typeof AudioContextClass === "function";
  let context = null;
  let wanted = supported && initialWanted(storage.get(STORAGE_KEY));
  let armed = false;
  let unlocking = false;

  const audioState = () => (context ? String(context.state) : "none");
  const running = () => context !== null && context.state === "running";

  function play() {
    const start = context.currentTime + 0.02;
    for (const note of BEEP.notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = note.frequency;
      // A short rise and a fall to zero: no click at the start or the end of a note.
      gain.gain.setValueAtTime(0, start + note.start);
      gain.gain.linearRampToValueAtTime(BEEP.volume, start + note.start + 0.015);
      gain.gain.linearRampToValueAtTime(0, start + note.start + note.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start + note.start);
      oscillator.stop(start + note.start + note.duration + 0.02);
    }
  }

  function ensureContext() {
    if (!context) {
      context = new AudioContextClass();
      context.onstatechange = () => {
        // Suspended or interrupted by the browser while the sound is wanted: wait for the next gesture.
        if (running()) disarm();
        else arm();
        onChange();
      };
    }
    return context;
  }

  // The gesture: unlocks the audio, rings nothing. The listeners stay until the audio really runs (a touch fires several events, the
  // first ones may not count as a gesture for the browser).
  async function onGesture() {
    if (unlocking || !wanted) return;
    unlocking = true;
    try {
      await ensureContext().resume();
    } catch {
      // not allowed yet: the next gesture tries again
    } finally {
      unlocking = false;
    }
    if (running()) disarm();
    onChange();
  }

  function arm() {
    if (armed || !wanted || !gestureTarget || running()) return;
    armed = true;
    for (const type of GESTURES) gestureTarget.addEventListener(type, onGesture);
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    for (const type of GESTURES) gestureTarget.removeEventListener(type, onGesture);
  }

  arm();

  return {
    get supported() {
      return supported;
    },

    // What sound-logic.js needs to decide and to write.
    status() {
      return { supported, wanted, audioState: audioState() };
    },

    // To call from a click: turns the sound on (and remembers it), creates or resumes the context, plays the test bip if the audio runs.
    async enable({ testBeep = true } = {}) {
      if (!supported) return;
      wanted = true;
      storage.set(STORAGE_KEY, "on");
      try {
        await ensureContext().resume();
        if (running()) {
          disarm();
          if (testBeep) play();
        } else {
          arm();
        }
      } catch {
        arm();
      }
      onChange();
    },

    // The button "Couper le son": remembered.
    disable() {
      wanted = false;
      storage.set(STORAGE_KEY, "off");
      disarm();
      onChange();
    },

    // The bip of a batch of new payments (the caller checked shouldBeep()).
    beep() {
      if (!running()) return;
      try {
        play();
      } catch {
        // a sound that fails must never stop the page
      }
    },
  };
}
