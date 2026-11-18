// === WHAT THIS FILE CHECKS ===
// The whitelist of merchants (src/allowed-users.js): refusal by default, internal number or e-mail address (without case
// and without the spaces around), nothing else accepted, and the log line of a refused account. Fictitious identities only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAllowedUsers, refusedAccountLine } from "../src/allowed-users.js";
import { readCaisseConfig } from "../src/caisse-config.js";

const ENV = { CAISSE_ENABLED: "true", CAISSE_CYCLOS_LOGIN: "ecouteur-test", CAISSE_CYCLOS_PASSWORD: "mdp-fictif-pour-test", CAISSE_MULTI_MERCHANT: "true" };
const fromEnv = (list) => createAllowedUsers(readCaisseConfig({ ...ENV, CAISSE_ALLOWED_USERS: list }).allowedUsers);

// Intention: refusal by default. An empty list, a missing list or no argument refuse everyone.
test("liste autorisée : vide ou absente, personne n'est autorisé", () => {
  for (const list of [createAllowedUsers({ ids: [], emails: [] }), createAllowedUsers(undefined), fromEnv(""), fromEnv(" , ,")]) {
    assert.equal(list.isAllowed({ id: "1234", email: "marie@exemple.test" }), false);
    assert.equal(list.isAllowed({}), false);
    assert.equal(list.isAllowed(), false);
    assert.equal(list.size, 0);
  }
});

// Intention: an internal number in the list opens the door, a number not in the list does not (exact text, no prefix match).
test("liste autorisée : numéro interne, correspondance exacte", () => {
  const list = fromEnv("1234567890,42");
  assert.equal(list.isAllowed({ id: "1234567890" }), true);
  assert.equal(list.isAllowed({ id: "42" }), true);
  for (const id of ["123456789", "12345678901", "4", "042", "-42", ""]) assert.equal(list.isAllowed({ id }), false, id);
});

// Intention: an e-mail address in the list opens the door, without case and without spaces around.
test("liste autorisée : adresse e-mail sans tenir compte des majuscules ni des espaces", () => {
  const list = fromEnv("Marie@Exemple.TEST");
  for (const email of ["marie@exemple.test", "MARIE@EXEMPLE.TEST", "  marie@exemple.test  ", "Marie@Exemple.Test\n"]) {
    assert.equal(list.isAllowed({ email }), true, JSON.stringify(email));
  }
  for (const email of ["marie@exemple.tes", "xmarie@exemple.test", "marie@exemple.test.org", "marie @exemple.test"]) {
    assert.equal(list.isAllowed({ email }), false, email);
  }
});

// Intention: either way is enough, and the two sorts do not mix (an e-mail is not an id, a number is not an e-mail).
test("liste autorisée : l'un ou l'autre suffit, les deux sortes ne se mélangent pas", () => {
  const list = fromEnv("1234,paul@exemple.test");
  assert.equal(list.isAllowed({ id: "1234", email: "inconnu@exemple.test" }), true);
  assert.equal(list.isAllowed({ id: "9999", email: "paul@exemple.test" }), true);
  assert.equal(list.isAllowed({ id: "9999", email: "inconnu@exemple.test" }), false);
  assert.equal(list.isAllowed({ id: "paul@exemple.test" }), false);
  assert.equal(list.isAllowed({ email: "1234" }), false);
  assert.equal(list.size, 2);
});

// Intention: an identity that cannot be read with certainty is refused: wrong types, odd characters.
test("liste autorisée : identité illisible, refus", () => {
  const list = fromEnv("1234,marie@exemple.test");
  for (const bad of [{ id: 1234 }, { id: null }, { id: ["1234"] }, { id: "1234/../x" }, { id: " 1234" }, { email: 5 }, { email: null }, { email: {} }, { email: "" }]) {
    assert.equal(list.isAllowed(bad), false, JSON.stringify(bad));
  }
});

// Intention: the list given to the function is copied: changing it afterwards changes nothing (read once, restart to change).
test("liste autorisée : copiée au démarrage, une modification ultérieure est sans effet", () => {
  const source = { ids: ["1234"], emails: [] };
  const list = createAllowedUsers(source);
  source.ids.push("9999");
  assert.equal(list.isAllowed({ id: "9999" }), false);
});

// Intention: the log line of a refused account gives the internal number, and nothing else about the person.
test("liste autorisée : ligne de journal d'un compte refusé, numéro interne seulement", () => {
  assert.equal(refusedAccountLine("1234567890"), "compte refusé (absent de CAISSE_ALLOWED_USERS), numéro interne Cyclos : 1234567890");
  for (const bad of [null, undefined, 12, "a b", "x@exemple.test", "<script>"]) {
    const line = refusedAccountLine(bad);
    assert.match(line, /numéro interne Cyclos : illisible$/);
    assert.equal(line.includes("@"), false);
  }
});
