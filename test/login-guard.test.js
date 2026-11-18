// === WHAT THIS FILE CHECKS ===
// The brakes on the logins of the multi-merchant mode (src/login-guard.js), with a clock the test moves by hand:
// limit per identifier, limit per address, circuit breaker on Cyclos, bounded memory. Identifiers and addresses are fictitious.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoginGuard } from "../src/login-guard.js";

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function guard(options = {}) {
  const clock = { at: T0 };
  const instance = createLoginGuard({ now: () => clock.at, ...options });
  return { clock, ...instance };
}

const who = (identifier, address = "203.0.113.5") => ({ identifier, address });

// Intention: 5 refused passwords on one identifier block it, even from a new address, and the answer says how long to wait.
test("garde : 5 mots de passe refusés sur un identifiant le bloquent, quelle que soit l'adresse", () => {
  const g = guard();
  for (let i = 0; i < 4; i += 1) {
    g.recordRefusal(who("marie", `203.0.113.${i + 1}`));
    assert.equal(g.check(who("marie", "198.51.100.1")).blocked, false, `après ${i + 1}`);
  }
  g.recordRefusal(who("marie", "203.0.113.9"));
  const verdict = g.check(who("marie", "198.51.100.1"));
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.reason, "identifier");
  assert.equal(verdict.retryAfterSeconds, 15 * 60);
  assert.equal(g.check(who("paul", "198.51.100.1")).blocked, false, "un autre identifiant n'est pas touché");
});

// Intention: the identifier is compared without case and without the spaces around it.
test("garde : identifiant comparé sans majuscules ni espaces autour", () => {
  const g = guard();
  for (const typed of ["Marie", " marie", "MARIE ", "marie", "mArIe"]) g.recordRefusal(who(typed));
  assert.equal(g.check(who("  Marie  ", "198.51.100.1")).blocked, true);
});

// Intention: the block lifts when the oldest refusal leaves the 15-minute window, and not before.
test("garde : le blocage se lève après la fenêtre de 15 minutes", () => {
  const g = guard();
  for (let i = 0; i < 5; i += 1) {
    g.recordRefusal(who("marie"));
    g.clock.at += 1000;
  }
  g.clock.at = T0 + 15 * MIN - 1;
  assert.equal(g.check(who("marie")).blocked, true);
  g.clock.at = T0 + 15 * MIN;
  assert.equal(g.check(who("marie")).blocked, false, "la plus ancienne est sortie : 4 dans la fenêtre");
});

// Intention: a success forgets the failures of the identifier (an honest typo does not accumulate), not those of the address.
test("garde : un succès efface les échecs de l'identifiant", () => {
  const g = guard();
  for (let i = 0; i < 4; i += 1) g.recordRefusal(who("marie"));
  g.recordSuccess(who("marie"));
  for (let i = 0; i < 4; i += 1) g.recordRefusal(who("marie"));
  assert.equal(g.check(who("marie", "198.51.100.1")).blocked, false);
});

// Intention: one address trying many identifiers is stopped at 10 refusals, and the other addresses go on.
test("garde : 10 refus depuis une adresse la bloquent, les autres adresses non", () => {
  const g = guard();
  for (let i = 0; i < 9; i += 1) g.recordRefusal(who(`compte${i}`, "203.0.113.5"));
  assert.equal(g.check(who("nouveau", "203.0.113.5")).blocked, false);
  g.recordRefusal(who("compte9", "203.0.113.5"));
  const verdict = g.check(who("nouveau", "203.0.113.5"));
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.reason, "address");
  assert.equal(g.check(who("nouveau", "203.0.113.6")).blocked, false);
});

// Intention: the breaker opens after 5 failures of Cyclos within 30 s: nobody can log in for a minute, whoever they are.
test("garde : disjoncteur, 5 pannes de Cyclos en 30 s coupent les connexions pendant 1 minute", () => {
  const g = guard();
  for (let i = 0; i < 4; i += 1) {
    g.recordCyclosFailure();
    g.clock.at += 1000;
  }
  assert.equal(g.check(who("marie")).blocked, false, "4 pannes : encore ouvert aux connexions");
  g.recordCyclosFailure();
  const verdict = g.check(who("autre", "198.51.100.1"));
  assert.deepEqual([verdict.blocked, verdict.reason], [true, "cyclos"]);
  assert.equal(verdict.retryAfterSeconds, 60);
  g.clock.at += 60 * 1000 - 1;
  assert.equal(g.check(who("marie")).blocked, true);
  g.clock.at += 1;
  assert.equal(g.check(who("marie")).blocked, false, "la pause est finie");
});

// Intention: pannes spread over more than 30 s do not open the breaker.
test("garde : des pannes espacées n'ouvrent pas le disjoncteur", () => {
  const g = guard();
  for (let i = 0; i < 20; i += 1) {
    g.recordCyclosFailure();
    g.clock.at += 10_000;
  }
  assert.equal(g.check(who("marie")).blocked, false);
});

// Intention: after the pause, ONE failure is enough to open again; a success closes the breaker for good.
test("garde : après la pause, une panne rouvre le disjoncteur, un succès le ferme", () => {
  const g = guard();
  for (let i = 0; i < 5; i += 1) g.recordCyclosFailure();
  g.clock.at += MIN;
  assert.equal(g.check(who("marie")).blocked, false);
  g.recordCyclosFailure();
  assert.equal(g.check(who("marie")).blocked, true, "rouvert tout de suite");

  g.clock.at += MIN;
  g.recordSuccess(who("marie"));
  for (let i = 0; i < 4; i += 1) g.recordCyclosFailure();
  assert.equal(g.check(who("marie")).blocked, false, "compteur remis à zéro par le succès");
});

// Intention: refused passwords are not Cyclos failures and the other way round.
test("garde : refus de mot de passe et pannes de Cyclos sont comptés séparément", () => {
  const g = guard();
  for (let i = 0; i < 4; i += 1) {
    g.recordRefusal(who("marie"));
    g.recordCyclosFailure();
  }
  assert.equal(g.check(who("marie")).blocked, false);
});

// Intention: the memory is bounded (oldest dropped), and sweep() empties what has expired.
test("garde : tables bornées, nettoyage de ce qui est expiré", () => {
  const g = guard({ maxEntries: 100 });
  for (let i = 0; i < 1000; i += 1) g.recordRefusal(who(`compte${i}`, `10.1.${Math.floor(i / 250)}.${i % 250}`));
  assert.ok(g.sizes.identifiers <= 100 && g.sizes.addresses <= 100, JSON.stringify(g.sizes));
  g.clock.at += 15 * MIN;
  g.sweep();
  assert.deepEqual(g.sizes, { identifiers: 0, addresses: 0 });
});

// Intention: a very long typed identifier cannot swell the memory, and nothing typed is ever returned in an answer.
test("garde : identifiant très long tronqué, aucune donnée saisie dans les réponses", () => {
  const g = guard();
  const long = "x".repeat(100_000);
  for (let i = 0; i < 5; i += 1) g.recordRefusal(who(long));
  const verdict = g.check(who(long));
  assert.equal(verdict.blocked, true);
  assert.equal(JSON.stringify(verdict).includes("xxxx"), false);
  assert.deepEqual(Object.keys(verdict).sort(), ["blocked", "reason", "retryAfterSeconds"]);
});
