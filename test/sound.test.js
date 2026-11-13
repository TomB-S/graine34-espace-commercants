// The audio code (sound.js) against a stand-in for the AudioContext: wanted by default but nothing is created before a gesture, the
// choice to cut is remembered, the unlocking gesture rings nothing, the notes are short, no audio file is ever fetched.
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

const memory = (initial = {}) => {
  const values = { ...initial };
  return { values, get: (key) => (key in values ? values[key] : null), set: (key, value) => (values[key] = value) };
};

// A stand-in for the document: records which gesture listeners are on.
function fakeTarget() {
  const on = new Map();
  return {
    on,
    addEventListener: (type, fn) => on.set(type, fn),
    removeEventListener: (type, fn) => {
      if (on.get(type) === fn) on.delete(type);
    },
  };
}

test("audio : voulu par défaut, rien n'est créé avant un geste, les cinq gestes sont écoutés une seule fois", () => {
  const { FakeContext, log } = fakeContext();
  const target = fakeTarget();
  const sound = createSound({ AudioContextClass: FakeContext, storage: memory(), gestureTarget: target });
  assert.equal(log.created, 0);
  assert.deepEqual(sound.status(), { supported: true, wanted: true, audioState: "none" });
  assert.deepEqual([...target.on.keys()].sort(), ["click", "keydown", "pointerdown", "pointerup", "touchend"]);
  sound.beep();
  assert.equal(log.oscillators.length, 0, "no bip while the audio does not run");
});

test("audio : le premier geste crée et reprend le contexte, ne sonne pas, retire les écouteurs", async () => {
  const { FakeContext, log } = fakeContext();
  const target = fakeTarget();
  let changes = 0;
  const sound = createSound({ AudioContextClass: FakeContext, storage: memory(), gestureTarget: target, onChange: () => (changes += 1) });
  await target.on.get("click")();
  assert.equal(log.created, 1);
  assert.deepEqual(sound.status(), { supported: true, wanted: true, audioState: "running" });
  assert.equal(log.oscillators.length, 0, "the unlocking gesture rings nothing");
  assert.equal(target.on.size, 0, "listeners removed");
  assert.ok(changes >= 1);
});

test("audio : geste non accepté par le navigateur = reste en attente, écouteurs gardés ; le suivant débloque", async () => {
  const { FakeContext, log } = fakeContext("suspended");
  const target = fakeTarget();
  const sound = createSound({ AudioContextClass: FakeContext, storage: memory(), gestureTarget: target });
  await target.on.get("pointerdown")();
  assert.equal(sound.status().audioState, "suspended");
  assert.equal(target.on.size, 5, "still listening");
  assert.equal(log.created, 1, "same context reused");
  log.context.resumeTo = "running";
  FakeContext.prototype.resume = async function () {
    this.state = "running";
  };
  await target.on.get("pointerup")();
  assert.equal(sound.status().audioState, "running");
  assert.equal(target.on.size, 0);
  assert.equal(log.created, 1);
});

test("audio : choix « off » mémorisé = non voulu, aucun écouteur ; le bouton active et mémorise « on » ; couper mémorise « off »", async () => {
  const { FakeContext } = fakeContext();
  const target = fakeTarget();
  const storage = memory({ "caisse-son": "off" });
  const sound = createSound({ AudioContextClass: FakeContext, storage, gestureTarget: target });
  assert.equal(sound.status().wanted, false);
  assert.equal(target.on.size, 0);
  await sound.enable();
  assert.equal(storage.values["caisse-son"], "on");
  assert.deepEqual(sound.status(), { supported: true, wanted: true, audioState: "running" });
  sound.disable();
  assert.equal(storage.values["caisse-son"], "off");
  assert.equal(sound.status().wanted, false);
  assert.equal(target.on.size, 0);
});

test("audio : le bouton joue le bip d'essai (deux notes brèves à volume modéré), sauf si on le lui interdit", async () => {
  const { FakeContext, log } = fakeContext();
  const sound = createSound({ AudioContextClass: FakeContext, storage: memory(), gestureTarget: fakeTarget() });
  await sound.enable();
  assert.equal(log.oscillators.length, 2);
  assert.deepEqual(log.oscillators.map((o) => o.frequency.value), BEEP.notes.map((n) => n.frequency));
  assert.ok(log.oscillators.every((o) => o.type === "sine"));
  const end = Math.max(...log.oscillators.map((o) => o.stops[0])) - Math.min(...log.oscillators.map((o) => o.starts[0]));
  assert.ok(end < 1 && end >= beepLength(), `${end} s`);
  for (const gain of log.gains) {
    assert.ok(Math.max(...gain.calls.map((call) => call[1])) <= BEEP.volume);
    assert.equal(gain.calls.at(-1)[1], 0, "falls back to zero: no click");
  }
  const quiet = fakeContext();
  const other = createSound({ AudioContextClass: quiet.FakeContext, storage: memory(), gestureTarget: fakeTarget() });
  await other.enable({ testBeep: false });
  assert.equal(quiet.log.oscillators.length, 0);
});

test("audio : si le navigateur laisse l'audio suspendu après le bouton, le son reste « en attente » (voulu, pas en marche) et rien ne sonne", async () => {
  const { FakeContext, log } = fakeContext("suspended");
  const target = fakeTarget();
  const sound = createSound({ AudioContextClass: FakeContext, storage: memory(), gestureTarget: target });
  await sound.enable();
  assert.deepEqual(sound.status(), { supported: true, wanted: true, audioState: "suspended" });
  assert.equal(log.oscillators.length, 0);
  assert.equal(target.on.size, 5, "a later gesture will try again");
  sound.beep();
  assert.equal(log.oscillators.length, 0);
});

test("audio : le navigateur suspend le contexte après coup = écouteurs reposés et pas de bip ; l'état suit le contexte", async () => {
  const { FakeContext, log } = fakeContext();
  const target = fakeTarget();
  let changes = 0;
  const sound = createSound({ AudioContextClass: FakeContext, storage: memory(), gestureTarget: target, onChange: () => (changes += 1) });
  await target.on.get("click")();
  assert.equal(target.on.size, 0);
  sound.beep();
  assert.equal(log.oscillators.length, 2, "one bip is two notes");
  log.context.state = "interrupted";
  log.context.onstatechange();
  assert.equal(sound.status().audioState, "interrupted");
  assert.equal(target.on.size, 5, "listening again");
  assert.ok(changes >= 2, "the page is told");
  sound.beep();
  assert.equal(log.oscillators.length, 2);
});

test("audio : un contexte qui échoue ne casse pas la page, le geste suivant réessaie", async () => {
  class Broken {
    constructor() {
      throw new Error("no audio device");
    }
  }
  const target = fakeTarget();
  const sound = createSound({ AudioContextClass: Broken, storage: memory(), gestureTarget: target });
  await target.on.get("click")();
  assert.equal(sound.status().audioState, "none");
  assert.equal(target.on.size, 5);
  await sound.enable();
  sound.beep();
});

test("audio : navigateur sans Web Audio = non pris en charge, non voulu, aucun écouteur, aucune erreur", async () => {
  const target = fakeTarget();
  const sound = createSound({ AudioContextClass: undefined, storage: memory(), gestureTarget: target });
  assert.equal(sound.supported, false);
  await sound.enable();
  sound.beep();
  assert.deepEqual(sound.status(), { supported: false, wanted: false, audioState: "none" });
  assert.equal(target.on.size, 0);
});

test("audio : sans stockage ni cible de gestes (valeurs par défaut) rien ne casse", async () => {
  const { FakeContext } = fakeContext();
  const sound = createSound({ AudioContextClass: FakeContext });
  assert.equal(sound.status().wanted, true);
  await sound.enable();
  sound.disable();
});

// Intention: no sound file, nothing fetched, and no direct access to the storage (it is given, and its wrapper never throws).
test("audio : aucun fichier audio, aucune dépendance, aucun accès direct au stockage dans sound.js", async () => {
  const code = await readFile(new URL("../sound.js", import.meta.url), "utf8");
  assert.ok(!/\.(mp3|wav|ogg|m4a)|new Audio\(|<audio|fetch\(|decodeAudioData|localStorage|sessionStorage|indexedDB/i.test(code));
  assert.deepEqual([...code.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]), ["./sound-logic.js"]);
});
