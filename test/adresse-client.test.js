// === WHAT THIS FILE CHECKS ===
// How the address of the visitor is read behind relays (src/client-address.js): X-Forwarded-For counted from the RIGHT,
// never a value written by the visitor, and the effect on the limit of login failures per address (multi-merchant mode).
// All addresses are fictitious (documentation ranges).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appTest } from "./support/harness.js";
import { CAISSE_OPTIONS } from "./support/options.js";
import { readClientAddress } from "../src/client-address.js";

const read = (forwardedFor, hops, socketAddress = "10.0.0.9") => readClientAddress({ socketAddress, forwardedFor }, hops);

// Intention: with 0 relays (the default), the header is never used, even if present.
test("adresse client : 0 relais, l'en-tête est ignoré", () => {
  assert.equal(read("203.0.113.5", 0).address, "10.0.0.9");
  assert.equal(read("203.0.113.5", undefined).address, "10.0.0.9");
  assert.equal(read(undefined, 0).address, "10.0.0.9");
});

// Intention: 1 relay: the visitor is the last entry of the header (the one the relay added).
test("adresse client : 1 relais, dernière entrée de l'en-tête", () => {
  assert.deepEqual(read("203.0.113.5", 1), { address: "203.0.113.5", fromHeader: true, headerEntries: 1 });
});

// Intention: what the visitor wrote himself (left of the relay's entry) never counts.
test("adresse client : une entrée écrite par le visiteur n'est jamais retenue", () => {
  assert.equal(read("198.51.100.1, 203.0.113.5", 1).address, "203.0.113.5");
  assert.equal(read("198.51.100.1, 198.51.100.2, 203.0.113.5", 1).address, "203.0.113.5");
});

// Intention: 2 relays: two places before the end of the chain [...header, socket].
test("adresse client : 2 relais", () => {
  assert.equal(read("203.0.113.5, 192.0.2.7", 2).address, "203.0.113.5");
  assert.equal(read("1.1.1.1, 203.0.113.5, 192.0.2.7", 2).address, "203.0.113.5");
});

// Intention: header missing, shorter than expected, or not an address: the address of the socket (safe side).
test("adresse client : en-tête absent, trop court ou illisible, adresse de la connexion", () => {
  for (const header of [undefined, "", " , ", "pas-une-adresse", "203.0.113.5, <script>"]) {
    const reading = read(header, 1);
    assert.equal(reading.address, "10.0.0.9", String(header));
    assert.equal(reading.fromHeader, false);
  }
  assert.equal(read("203.0.113.5", 2).address, "10.0.0.9", "2 relais attendus, une seule entrée");
});

// Intention: IPv6 is read, and the IPv4 form "::ffff:a.b.c.d" is brought back to a.b.c.d (same visitor, same key).
test("adresse client : IPv6 et forme IPv4 enveloppée", () => {
  assert.equal(read("2001:db8::1", 1).address, "2001:db8::1");
  assert.equal(read("::ffff:203.0.113.5", 1).address, "203.0.113.5");
  assert.equal(read(undefined, 0, "::ffff:127.0.0.1").address, "127.0.0.1");
  assert.equal(read(undefined, 0, null).address, "unknown");
});

const MULTI = (hops) => ({
  ...CAISSE_OPTIONS,
  caisse: { ...CAISSE_OPTIONS.caisse, multiMerchant: true, trustedProxyHops: hops },
});

const fail = (app, forwardedFor) =>
  app.request("/connexion", {
    method: "POST",
    form: { login: "x", password: "faux" },
    headers: { Origin: app.base, ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}) },
  });

// Intention: behind 1 relay, the limit of 5 failures counts each visitor apart, and a header forged by the visitor does not help.
appTest("adresse client : 1 relais, la limite de 5 échecs compte chaque visiteur séparément", MULTI(1), async (app) => {
  for (let i = 0; i < 5; i += 1) assert.equal((await fail(app, "203.0.113.5")).status, 401);
  assert.equal((await fail(app, "203.0.113.5")).status, 429, "même visiteur : bloqué");
  assert.equal((await fail(app, "198.51.100.77, 203.0.113.5")).status, 429, "entrée forgée à gauche : toujours le même visiteur");
  assert.equal((await fail(app, "203.0.113.6")).status, 401, "autre visiteur : pas bloqué");
});

// Intention: with the default 0 relays in this mode, all the visitors share the address of the relay: the header changes nothing.
appTest("adresse client : 0 relais, l'en-tête ne contourne pas la limite", MULTI(0), async (app) => {
  for (let i = 0; i < 5; i += 1) assert.equal((await fail(app, `203.0.113.${i + 1}`)).status, 401);
  assert.equal((await fail(app, "203.0.113.200")).status, 429);
});

// Intention: in this mode, a log line shows the address read, to set the number of relays after a real test.
appTest("adresse client : ligne de journal de l'adresse lue (mode multi)", MULTI(1), async (app) => {
  await fail(app, "203.0.113.5");
  const line = app.logs.find((entry) => entry.startsWith("adresse lue "));
  assert.ok(line, "ligne présente");
  assert.match(line, /^adresse lue 203\.0\.113\.5 \(X-Forwarded-For, adresse de la connexion 127\.0\.0\.1, 1 entrée\(s\) X-Forwarded-For, relais de confiance 1\)$/);
});

// Intention: in the single-merchant mode nothing is read from the header and nothing is logged: behavior as before.
appTest("adresse client : mode mono, en-tête ignoré et pas de ligne de journal", CAISSE_OPTIONS, async (app) => {
  for (let i = 0; i < 5; i += 1) assert.equal((await fail(app, `203.0.113.${i + 1}`)).status, 401);
  assert.equal((await fail(app, "203.0.113.200")).status, 429);
  assert.equal(app.logs.some((entry) => entry.startsWith("adresse lue")), false);
});
