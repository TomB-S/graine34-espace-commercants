// === WHAT THIS FILE CHECKS ===
// age.js: the short text "à l'instant", "il y a N min", "il y a N h", at every limit (59 s, 60 s, 59 min, 60 min, 23 h, 24 h,
// a negative gap). Pure function, no network, no clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ageText } from "../web/js/age.js";

const NOW = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const at = (gapMs) => ageText(NOW - gapMs, NOW);

// Intention: under one minute, and a date in the future (clocks that disagree), both read "à l'instant".
test("âge : moins de 60 secondes ou négatif = à l'instant", () => {
  assert.equal(at(0), "à l'instant");
  assert.equal(at(59 * SECOND), "à l'instant");
  assert.equal(at(59_999), "à l'instant");
  assert.equal(at(-5 * MINUTE), "à l'instant");
});

// Intention: from 60 seconds to 59 minutes: minutes, rounded down.
test("âge : de 1 à 59 minutes", () => {
  assert.equal(at(60 * SECOND), "il y a 1 min");
  assert.equal(at(119 * SECOND), "il y a 1 min");
  assert.equal(at(2 * MINUTE), "il y a 2 min");
  assert.equal(at(59 * MINUTE), "il y a 59 min");
  assert.equal(at(HOUR - 1), "il y a 59 min");
});

// Intention: from 60 minutes to 23 hours: hours, rounded down; 24 hours and more: no text at all.
test("âge : de 1 à 23 heures, rien à partir de 24 heures", () => {
  assert.equal(at(60 * MINUTE), "il y a 1 h");
  assert.equal(at(90 * MINUTE), "il y a 1 h");
  assert.equal(at(23 * HOUR), "il y a 23 h");
  assert.equal(at(24 * HOUR - 1), "il y a 23 h");
  assert.equal(at(24 * HOUR), "");
  assert.equal(at(10 * 24 * HOUR), "");
});

// Intention: a value that is not a number gives no text, never "NaN".
test("âge : valeur illisible = aucun texte", () => {
  assert.equal(ageText(undefined, NOW), "");
  assert.equal(ageText(NaN, NOW), "");
  assert.equal(ageText(NOW, null), "");
});
