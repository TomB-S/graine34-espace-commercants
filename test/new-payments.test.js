// The detection of new payments (new-payments.js), which the sound and the notification will use: pure logic, no server.
// Intention: the first load never reports anything, then only a ticket none of whose keys was seen is new.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNewPaymentDetector } from "../web/js/new-payments.js";

const ticket = (keys, extra = {}) => ({ keys: [].concat(keys), initial: false, ...extra });

test("détection : le premier chargement ne déclenche rien, même avec des paiements récents", () => {
  const detector = createNewPaymentDetector();
  assert.equal(detector.started, false);
  assert.deepEqual(detector.update([ticket("a", { isNew: true }), ticket("b")]), []);
  assert.equal(detector.started, true);
});

test("détection : une clé inconnue après le premier chargement est un nouveau paiement, une seule fois", () => {
  const detector = createNewPaymentDetector();
  detector.update([ticket("a")]);
  const c = ticket("c");
  assert.deepEqual(detector.update([c, ticket("a")]), [c]);
  assert.deepEqual(detector.update([c, ticket("a")]), [], "already reported");
});

test("détection : plusieurs paiements d'un coup = un lot, dans l'ordre reçu", () => {
  const detector = createNewPaymentDetector();
  detector.update([ticket("a")]);
  const [x, y] = [ticket("x"), ticket("y")];
  assert.deepEqual(detector.update([x, y, ticket("a")]), [x, y]);
});

test("détection : premier chargement pas prêt (historique pas encore lu) = rien appris, rien annoncé, puis le premier chargement prêt est silencieux", () => {
  const detector = createNewPaymentDetector();
  assert.deepEqual(detector.update([], { ready: false }), []);
  assert.equal(detector.started, false);
  // The history arrives: it is the first ready answer, so it is only learned, however old the payments are.
  assert.deepEqual(detector.update([ticket("h1", { initial: true }), ticket("h2", { initial: true })], { ready: true }), []);
  assert.equal(detector.started, true);
  const fresh = ticket("n1");
  assert.deepEqual(detector.update([fresh, ticket("h1", { initial: true })]), [fresh]);
});

test("détection : un ticket de l'historique que la page n'a jamais vu est nouveau, un déjà vu ne l'est pas", () => {
  const detector = createNewPaymentDetector();
  detector.update([ticket("a", { initial: true })]); // first load: learned
  // The listening was stopped during a pause and restarted: its history holds the old payment and a payment made meanwhile.
  const meanwhile = ticket("z", { initial: true });
  assert.deepEqual(detector.update([meanwhile, ticket("a", { initial: true })]), [meanwhile]);
  assert.deepEqual(detector.update([meanwhile, ticket("a", { initial: true })]), [], "announced once");
});

test("marque « Nouveau » : posée sur ce que la page a trouvé nouveau pendant une minute, même venu de l'historique", () => {
  const detector = createNewPaymentDetector();
  detector.update([ticket("a")], { nowMs: 0 });
  const found = ticket("z", { initial: true, isNew: false });
  detector.update([found], { nowMs: 1000 });
  const again = ticket("z", { initial: true, isNew: false });
  const old = ticket("a", { isNew: false });
  detector.markNew([again, old], 30_000);
  assert.equal(again.isNew, true);
  assert.equal(old.isNew, false, "learned at the first load, never marked");
  const later = ticket("z", { initial: true, isNew: false });
  detector.markNew([later], 61_001);
  assert.equal(later.isNew, false, "the mark goes after a minute");
});

test("détection : un ticket complété (il gagne une clé) n'est pas un nouveau paiement", () => {
  const detector = createNewPaymentDetector();
  detector.update([]);
  const first = ticket("entity-1");
  assert.deepEqual(detector.update([first]), [first]);
  assert.deepEqual(detector.update([ticket(["tx-1", "entity-1"])]), []);
  assert.deepEqual(detector.update([ticket(["tx-1"])]), [], "known by its number later");
});

test("détection : redémarrage de l'écoute côté serveur = l'historique rechargé ne sonne que pour ce que la page n'a pas vu", () => {
  const detector = createNewPaymentDetector();
  detector.update([ticket("a"), ticket("b")]);
  const z = ticket("z", { initial: true });
  assert.deepEqual(detector.update([ticket("a", { initial: true }), ticket("b", { initial: true }), z]), [z]);
});

test("détection : ticket sans clé ou données bizarres ignorés sans erreur", () => {
  const detector = createNewPaymentDetector();
  detector.update([{}, { keys: "x" }]);
  assert.deepEqual(detector.update([{}, { keys: null }]), []);
});

test("détection : une lecture ratée n'est pas donnée à update(), rien ne change au retour", () => {
  const detector = createNewPaymentDetector();
  detector.update([ticket("a")]);
  // (network error: update() is not called)
  const b = ticket("b");
  assert.deepEqual(detector.update([b, ticket("a")]), [b]);
});
