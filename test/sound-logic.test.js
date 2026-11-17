// When to ring and what to say about the sound (sound-logic.js): pure logic, no audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BEEP, beepLength, initialWanted, isSoundActive, soundLabel, soundText, shouldBeep } from "../web/js/sound-logic.js";

const state = (extra = {}) => ({ supported: true, wanted: true, audioState: "running", ...extra });

test("son : actif seulement si pris en charge, voulu (clic) et audio réellement en marche", () => {
  assert.equal(isSoundActive(state()), true);
  assert.equal(isSoundActive(state({ supported: false })), false);
  assert.equal(isSoundActive(state({ wanted: false })), false);
  for (const audioState of ["suspended", "interrupted", "closed", "none", undefined]) {
    assert.equal(isSoundActive(state({ audioState })), false, String(audioState));
  }
});

test("son : « Son activé » seulement si l'audio tourne vraiment ; voulu mais pas en marche = « en attente »", () => {
  assert.deepEqual(soundLabel(state()), { text: "Son activé", active: true });
  for (const audioState of ["none", "suspended", "interrupted", "closed"]) {
    const label = soundLabel(state({ audioState }));
    assert.equal(label.text, "Son en attente : toucher la page pour l'activer", audioState);
    assert.equal(label.active, false);
  }
});

test("son : jamais « Son activé » avec un contexte suspendu, quoi qu'on ait voulu", () => {
  for (const wanted of [true, false]) {
    for (const audioState of ["none", "suspended", "interrupted", "closed", undefined]) {
      assert.notEqual(soundText(state({ wanted, audioState })), "Son activé", `${wanted} ${audioState}`);
    }
  }
});

test("son : coupé = « désactivé », même si le contexte tourne ; navigateur sans audio = message", () => {
  assert.equal(soundText(state({ wanted: false })), "Son désactivé : cliquer pour activer");
  assert.equal(soundText(state({ wanted: false, audioState: "none" })), "Son désactivé : cliquer pour activer");
  assert.equal(soundText({ supported: false, wanted: false, audioState: "none" }), "Son non disponible sur ce navigateur");
  assert.equal(soundText({ supported: false, wanted: true, audioState: "none" }), "Son non disponible sur ce navigateur");
});

test("son : voulu par défaut, coupé seulement si le choix « off » est mémorisé", () => {
  assert.equal(initialWanted(null), true);
  assert.equal(initialWanted(undefined), true);
  assert.equal(initialWanted("on"), true);
  assert.equal(initialWanted(""), true);
  assert.equal(initialWanted("off"), false);
});

test("son : sonne une fois dès qu'il y a au moins un nouveau paiement, jamais sinon", () => {
  assert.equal(shouldBeep(state(), 1), true);
  assert.equal(shouldBeep(state(), 5), true, "a batch is one bip: the caller rings once");
  assert.equal(shouldBeep(state(), 0), false);
  assert.equal(shouldBeep(state(), -1), false);
  assert.equal(shouldBeep(state(), undefined), false);
  assert.equal(shouldBeep(state(), 1.5), false);
});

test("son : pas de bip quand le son est coupé, non demandé, suspendu ou absent", () => {
  assert.equal(shouldBeep(state({ wanted: false }), 3), false);
  assert.equal(shouldBeep(state({ audioState: "suspended" }), 3), false);
  assert.equal(shouldBeep(state({ audioState: "interrupted" }), 3), false);
  assert.equal(shouldBeep(state({ supported: false }), 3), false);
});

test("bip : deux notes brèves, moins d'une seconde, volume modéré", () => {
  assert.equal(BEEP.notes.length, 2);
  assert.ok(beepLength() < 1, `${beepLength()} s`);
  assert.ok(beepLength() > 0.2);
  assert.ok(BEEP.volume > 0 && BEEP.volume <= 0.3, "moderate volume");
  for (const note of BEEP.notes) assert.ok(note.frequency >= 200 && note.frequency <= 2000 && note.duration > 0);
  assert.ok(BEEP.notes[1].start >= BEEP.notes[0].start + BEEP.notes[0].duration, "notes do not overlap");
});

test("bip : les réglages ne peuvent pas être modifiés par le reste du code", () => {
  assert.ok(Object.isFrozen(BEEP) && Object.isFrozen(BEEP.notes));
});
