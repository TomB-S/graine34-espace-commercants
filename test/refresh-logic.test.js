// The "Actualiser" button (refresh-logic.js): pure logic, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canStartRefresh, refreshState } from "../refresh-logic.js";

test("actualiser : au repos, « Actualiser » actif ; pendant la lecture, « Actualisation... » désactivé", () => {
  assert.deepEqual(refreshState(false), { text: "Actualiser", disabled: false });
  assert.deepEqual(refreshState(true), { text: "Actualisation...", disabled: true });
});

test("actualiser : un clic ne lance pas une seconde lecture pendant qu'une lecture demandée par le bouton est en cours", () => {
  assert.equal(canStartRefresh(false), true);
  assert.equal(canStartRefresh(true), false);
});
