// The audio code (sound.js) against a stand-in for the AudioContext: nothing is created before the click, the sound only counts as
// wanted if the browser really runs the audio, the notes are short, no audio file is ever fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSound } from "../sound.js";
import { BEEP, beepLength } from "../sound-logic.js";

function fakeContext(resumeTo = "running") {
  const log = { created: 0, oscillators: [], gains: [], changes: 0, context: null };
  class FakeContext {
    constructor() {
      this.state = "suspended";
      this.currentTime = 10;
      this.destination = { destination: true };
      log.created += 1;
      log.context = this;
    }
    async resume() {
      this.state = resumeTo;
    }
    createOscillator() {
      const osc = { frequency: {}, type: "", connect() {}, starts: [], stops: [], start(t) { this.starts.push(t); }, stop(t) { this.stops.push(t); } };
      log.oscillators.push(osc);
      return osc;
    }
    createGain() {
      const calls = [];
      const gain = { gain: { setValueAtTime: (...a) => calls.push(["set", ...a]), linearRampToValueAtTime: (...a) => calls.push(["ramp", ...a]) }, connect() {}, calls };
      log.gains.push(gain);
      return gain;
    }
  }
  return { FakeContext, log };
}

test("audio : rien n'est créé avant le clic, l'état de départ est « désactivé »", () => {
  const { FakeContext, log } = fakeContext();
  const sound = createSound({ AudioContextClass: FakeContext });
  assert.equal(log.created, 0);
  assert.deepEqual(sound.status(), { supported: true, wanted: false, audioState: "none" });
  sound.beep();
  assert.equal(log.oscillators.length, 0, "no bip without an enabled sound");
});

test("audio : le clic crée et reprend le contexte, joue le bip d'essai, deux notes courtes à volume modéré", async () => {
  const { FakeContext, log } = fakeContext();
  let changes = 0;
  const sound = createSound({ AudioContextClass: FakeContext, onChange: () => (changes += 1) });
  await sound.enable();
  assert.equal(log.created, 1);
  assert.deepEqual(sound.status(), { supported: true, wanted: true, audioState: "running" });
  assert.equal(log.oscillators.length, 2);
  assert.deepEqual(log.oscillators.map((o) => o.frequency.value), BEEP.notes.map((n) => n.frequency));
  assert.ok(log.oscillators.every((o) => o.type === "sine"));
  const end = Math.max(...log.oscillators.map((o) => o.stops[0])) - Math.min(...log.oscillators.map((o) => o.starts[0]));
  assert.ok(end < 1, `${end} s`);
  assert.ok(end >= beepLength());
  // Each note rises to the volume and falls back to zero: no click, never above BEEP.volume.
  for (const gain of log.gains) {
    const levels = gain.calls.map((call) => call[1]);
    assert.ok(Math.max(...levels) <= BEEP.volume);
    assert.equal(gain.calls.at(-1)[1], 0);
  }
  assert.ok(changes >= 1);
});

test("audio : un deuxième clic réutilise le même contexte", async () => {
  const { FakeContext, log } = fakeContext();
  const sound = createSound({ AudioContextClass: FakeContext });
  await sound.enable();
  sound.disable();
  assert.equal(sound.status().wanted, false);
  await sound.enable();
  assert.equal(log.created, 1);
});

test("audio : si le navigateur laisse l'audio suspendu, le son n'est pas considéré comme voulu et rien ne sonne", async () => {
  const { FakeContext, log } = fakeContext("suspended");
  const sound = createSound({ AudioContextClass: FakeContext });
  await sound.enable();
  assert.deepEqual(sound.status(), { supported: true, wanted: false, audioState: "suspended" });
  assert.equal(log.oscillators.length, 0);
  sound.beep();
  assert.equal(log.oscillators.length, 0);
});

test("audio : bip refusé quand le navigateur suspend le contexte après coup ; l'état suit le contexte", async () => {
  const { FakeContext, log } = fakeContext();
  let changes = 0;
  const sound = createSound({ AudioContextClass: FakeContext, onChange: () => (changes += 1) });
  await sound.enable();
  const before = log.oscillators.length;
  sound.beep();
  assert.equal(log.oscillators.length, before + 2, "one bip is two notes");
  log.context.state = "interrupted";
  log.context.onstatechange();
  assert.equal(sound.status().audioState, "interrupted");
  assert.ok(changes >= 2, "the page is told");
  sound.beep();
  assert.equal(log.oscillators.length, before + 2);
});

test("audio : un contexte qui échoue ne casse pas la page", async () => {
  class Broken {
    constructor() {
      throw new Error("no audio device");
    }
  }
  const sound = createSound({ AudioContextClass: Broken });
  await sound.enable();
  assert.equal(sound.status().wanted, false);
  sound.beep();
});

test("audio : navigateur sans Web Audio = non pris en charge, aucune erreur", async () => {
  const sound = createSound({ AudioContextClass: undefined });
  assert.equal(sound.supported, false);
  await sound.enable();
  sound.beep();
  assert.deepEqual(sound.status(), { supported: false, wanted: false, audioState: "none" });
});

// Intention: no sound file, nothing stored, nothing fetched: the bip is generated.
test("audio : aucun fichier audio, aucune dépendance, aucun stockage dans sound.js", async () => {
  const code = await readFile(new URL("../sound.js", import.meta.url), "utf8");
  assert.ok(!/\.(mp3|wav|ogg|m4a)|new Audio\(|<audio|fetch\(|decodeAudioData|localStorage|sessionStorage|indexedDB/i.test(code));
  assert.deepEqual([...code.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]), ["./sound-logic.js"]);
});
