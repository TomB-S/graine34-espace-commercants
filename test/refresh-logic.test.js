// The "Actualiser" button (refresh-logic.js): pure logic, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canStartRefresh, pollFooterText, pollSettings, refreshState } from "../web/js/refresh-logic.js";

test("actualiser : au repos, « Actualiser » actif ; pendant la lecture, « Actualisation... » désactivé", () => {
  assert.deepEqual(refreshState(false), { text: "Actualiser", disabled: false });
  assert.deepEqual(refreshState(true), { text: "Actualisation...", disabled: true });
});

test("actualiser : un clic ne lance pas une seconde lecture pendant qu'une lecture demandée par le bouton est en cours", () => {
  assert.equal(canStartRefresh(false), true);
  assert.equal(canStartRefresh(true), false);
});

test("rythme : « 0 » = mode manuel ; sinon au moins 1 seconde, 3 par défaut si illisible", () => {
  assert.deepEqual(pollSettings("0"), { manual: true, pollMs: 0 });
  assert.deepEqual(pollSettings("60"), { manual: false, pollMs: 60_000 });
  assert.deepEqual(pollSettings("4"), { manual: false, pollMs: 4000 });
  for (const raw of [undefined, "", "abc", null]) assert.deepEqual(pollSettings(raw), { manual: false, pollMs: 3000 }, String(raw));
});

test("pied de page : phrase en mode manuel seulement, rien en mode automatique", () => {
  assert.equal(pollFooterText(0), "Mise à jour manuelle : cliquer sur Actualiser pour relire les paiements.");
  assert.equal(pollFooterText(1), "");
  assert.equal(pollFooterText(5), "");
});
