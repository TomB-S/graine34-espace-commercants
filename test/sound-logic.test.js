// When to ring and what to say about the sound (sound-logic.js): pure logic, no audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BEEP, beepLength, isSoundActive, soundLabel, shouldBeep } from "../sound-logic.js";

const state = (extra = {}) => ({ supported: true, wanted: true, audioState: "running", ...extra });

test("son : actif seulement si pris en charge, voulu (clic) et audio réellement en marche", () => {
  assert.equal(isSoundActive(state()), true);
  assert.equal(isSoundActive(state({ supported: false })), false);
  assert.equal(isSoundActive(state({ wanted: false })), false);
  for (const audioState of ["suspended", "interrupted", "closed", "none", undefined]) {
    assert.equal(isSoundActive(state({ audioState })), false, String(audioState));
  }
});

test("son : jamais « Son activé » quand l'audio est suspendu, même si l'utilisateur l'a demandé", () => {
  assert.equal(soundLabel(state()).text, "Son activé");
  assert.equal(soundLabel(state()).buttonText, "Couper le son");
  assert.equal(soundLabel(state()).active, true);
  for (const audioState of ["suspended", "interrupted", "closed"]) {
    const label = soundLabel(state({ audioState }));
    assert.equal(label.text, "Son désactivé : cliquer pour activer", audioState);
    assert.equal(label.buttonText, "Activer le son");
    assert.equal(label.active, false);
  }
});

test("son : au chargement (rien voulu, pas de contexte) = désactivé ; navigateur sans audio = message et pas de bouton", () => {
  assert.deepEqual(soundLabel({ supported: true, wanted: false, audioState: "none" }), {
    text: "Son désactivé : cliquer pour activer",
    buttonText: "Activer le son",
    active: false,
  });
  assert.deepEqual(soundLabel({ supported: false, wanted: false, audioState: "none" }), {
    text: "Son non disponible sur ce navigateur",
    buttonText: null,
    active: false,
  });
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
