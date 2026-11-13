// The audio of the cash register page: Web Audio only, no sound file, no library. The bip is generated (two short sine notes, see
// BEEP in sound-logic.js). The rules (when to ring, what to say) are in sound-logic.js; this file only touches the audio.
//
// The sound starts OFF on every load of the page and nothing is remembered: browsers refuse sound without a gesture, so
// enable() is meant to be called from a click, and creates or resumes the AudioContext right there.
import { BEEP } from "./sound-logic.js";

// `AudioContextClass`: window.AudioContext (or webkitAudioContext), undefined when the browser has none. `onChange`: called
// when something the page shows may have changed (the browser suspends or resumes the audio by itself, e.g. on a phone call).
export function createSound({ AudioContextClass, onChange = () => {} }) {
  let context = null;
  let wanted = false;

  const audioState = () => (context ? String(context.state) : "none");

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

  return {
    get supported() {
      return typeof AudioContextClass === "function";
    },

    // What sound-logic.js needs to decide and to write.
    status() {
      return { supported: typeof AudioContextClass === "function", wanted, audioState: audioState() };
    },

    // To call from a click. Creates or resumes the context, and only counts as enabled if the browser really runs it.
    async enable() {
      if (typeof AudioContextClass !== "function") return;
      try {
        if (!context) {
          context = new AudioContextClass();
          context.onstatechange = () => onChange();
        }
        await context.resume();
        wanted = context.state === "running";
        if (wanted) play(); // the test bip
      } catch {
        wanted = false;
      }
      onChange();
    },

    disable() {
      wanted = false;
      onChange();
    },

    // The bip of a batch of new payments (the caller checked shouldBeep()).
    beep() {
      if (!context || context.state !== "running") return;
      try {
        play();
      } catch {
        // a sound that fails must never stop the page
      }
    },
  };
}
