// The date line and the clock offset of the script (date-line.js), and the proof that the browser and the server say the same thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dateLine, clockOffset } from "../web/js/date-line.js";
import { ticketDisplay, makeTicket } from "../src/ticket-store.js";
import { transfer } from "./support/fake-cyclos.js";

test("ligne de date : libellé suivi de l'âge, sans âge au-delà de 24 h", () => {
  const at = Date.parse("2026-01-10T12:00:00Z");
  assert.equal(dateLine("Aujourd'hui 13:00", at, at + 30_000), "Aujourd'hui 13:00 · à l'instant");
  assert.equal(dateLine("Aujourd'hui 13:00", at, at + 2 * 60_000), "Aujourd'hui 13:00 · il y a 2 min");
  assert.equal(dateLine("12/11 17:21", at, at + 3 * 3_600_000), "12/11 17:21 · il y a 3 h");
  assert.equal(dateLine("12/11 17:21", at, at + 24 * 3_600_000), "12/11 17:21");
  assert.equal(dateLine("12/11 17:21", Number.NaN, at), "12/11 17:21");
});

test("décalage d'horloge : serveur moins navigateur, 0 si une valeur manque", () => {
  assert.equal(clockOffset(10_000, 4_000), 6000);
  assert.equal(clockOffset(4_000, 10_000), -6000);
  assert.equal(clockOffset(undefined, 10_000), 0);
  assert.equal(clockOffset(10_000, Number.NaN), 0);
});

test("ligne de date : le script refait exactement la ligne que le serveur écrit", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  const formatAmount = (value) => value;
  for (const offsetMs of [10_000, 5 * 60_000, 2 * 3_600_000, 30 * 3_600_000]) {
    const ticket = makeTicket({ transfer: transfer(1, { date: new Date(now - offsetMs).toISOString() }), source: "push", arrivedAt: now });
    const d = ticketDisplay(ticket, { now, formatAmount });
    assert.equal(dateLine(d.dateLabel, d.at, now), d.dateLine, `${offsetMs} ms`);
  }
});
