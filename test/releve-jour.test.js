// === WHAT THIS FILE CHECKS ===
// The "one day, between two hours" calculation (dayRange) of the statement: same day, service going past midnight, equal hours refused,
// the last minute included, the clock-change days of 2026 (29 March, 25 October), a future day refused, a future end brought back to
// now, and strict formats (impossible date, invalid hour, missing field). Pure: no server, no network, a fixed fake "now".
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { dayRange, dayDefaults, parseRange } from "../src/releve-calcul.js";

const ZONE = "Europe/Paris";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE });
const NOW = at("2026-11-23T12:00:30"); // Monday, winter time
const fmt = (d) => d.toFormat("yyyy-MM-dd HH:mm");

// Intention: "À" after "De": the whole range is on the chosen day, and the last minute is included (23:59 goes to 23:59:59.999).
test("dayRange : même jour, dernière minute incluse", () => {
  const r = dayRange("2026-11-20", "08:00", "23:59", NOW);
  assert.equal(r.error, undefined);
  assert.equal(fmt(r.from), "2026-11-20 08:00");
  assert.equal(fmt(r.to), "2026-11-20 23:59");
  assert.equal(r.until.toISO(), at("2026-11-20T23:59:59.999").toISO());
  assert.equal(r.clamped, false);
  assert.deepEqual(r.day, { jour: "2026-11-20", de: "08:00", a: "23:59" });
});

// Intention: "À" before "De" means the service goes past midnight: the end is the next day. At the end of a month and of a year too.
test("dayRange : « À » avant « De » : la fin est le lendemain (y compris fin de mois et d'année)", () => {
  const r = dayRange("2026-11-20", "18:00", "02:00", NOW);
  assert.equal(fmt(r.from), "2026-11-20 18:00");
  assert.equal(fmt(r.to), "2026-11-21 02:00");
  const month = dayRange("2026-10-31", "22:00", "01:30", NOW);
  assert.equal(fmt(month.to), "2026-11-01 01:30");
  const year = dayRange("2025-12-31", "23:00", "00:30", NOW);
  assert.equal(fmt(year.to), "2026-01-01 00:30");
  assert.equal(dayRange("2026-11-20", "23:59", "00:00", NOW).error, undefined, "one minute short of 24 hours is fine");
});

// Intention: equal hours are refused with the message asked for, in French.
test("dayRange : heures égales refusées", () => {
  assert.equal(dayRange("2026-11-20", "10:00", "10:00", NOW).error, "L'heure de fin doit être différente de l'heure de début.");
  assert.equal(dayRange("2026-11-20", "00:00", "00:00", NOW).error, "L'heure de fin doit être différente de l'heure de début.");
});

// Intention: the range is exactly the one parseRange gives for the two full dates: nothing is computed twice.
test("dayRange : même résultat que parseRange pour les deux dates complètes", () => {
  const day = dayRange("2026-11-20", "18:00", "02:00", NOW);
  const direct = parseRange("2026-11-20T18:00", "2026-11-21T02:00", NOW);
  assert.equal(day.from.toISO(), direct.from.toISO());
  assert.equal(day.to.toISO(), direct.to.toISO());
  assert.equal(day.until.toISO(), direct.until.toISO());
});

// Intention: spring change (29 March 2026): 02:00 to 03:00 does not exist. A night over the change is one hour shorter in real time but
// the wall-clock hours are respected; an hour inside the gap is refused like in the free range.
test("dayRange : 29 mars 2026 (passage à l'heure d'été)", () => {
  const now = at("2026-11-23T12:00:00");
  const night = dayRange("2026-03-28", "22:00", "06:00", now);
  assert.equal(night.error, undefined);
  assert.equal(night.from.toUTC().toISO(), "2026-03-28T21:00:00.000Z"); // +01:00
  assert.equal(night.to.toUTC().toISO(), "2026-03-29T04:00:00.000Z"); // +02:00: 7 real hours for 8 wall-clock hours
  assert.equal(night.to.diff(night.from, "hours").hours, 7);
  const whole = dayRange("2026-03-29", "00:00", "23:59", now);
  assert.equal(whole.error, undefined);
  assert.equal(whole.until.diff(whole.from, "hours").hours.toFixed(2), "23.00");
  assert.match(dayRange("2026-03-29", "02:30", "10:00", now).error, /n'existe pas/);
  assert.match(dayRange("2026-03-28", "22:00", "02:30", now).error, /n'existe pas/);
});

// Intention: autumn change (25 October 2026): 02:00 to 03:00 happens twice. A night over the change is one hour longer in real time;
// an ambiguous hour is read like the free range reads it (the first one).
test("dayRange : 25 octobre 2026 (passage à l'heure d'hiver)", () => {
  const now = at("2026-11-23T12:00:00");
  const night = dayRange("2026-10-24", "22:00", "06:00", now);
  assert.equal(night.error, undefined);
  assert.equal(night.from.toUTC().toISO(), "2026-10-24T20:00:00.000Z"); // +02:00
  assert.equal(night.to.toUTC().toISO(), "2026-10-25T05:00:00.000Z"); // +01:00: 9 real hours for 8 wall-clock hours
  assert.equal(night.to.diff(night.from, "hours").hours, 9);
  const whole = dayRange("2026-10-25", "00:00", "23:59", now);
  assert.equal(whole.until.diff(whole.from, "hours").hours.toFixed(2), "25.00");
  const ambiguous = dayRange("2026-10-25", "02:30", "10:00", now);
  const direct = parseRange("2026-10-25T02:30", "2026-10-25T10:00", now);
  assert.equal(ambiguous.error, undefined);
  assert.equal(ambiguous.from.toUTC().toISO(), direct.from.toUTC().toISO());
});

// Intention: a day that has not started is refused; today with a later start hour too; the end of today (or past midnight into the
// future) is brought back to now.
test("dayRange : jour futur refusé, fin future ramenée à maintenant", () => {
  assert.equal(dayRange("2026-11-24", "00:00", "23:59", NOW).error, "Le début ne peut pas être dans le futur.");
  assert.equal(dayRange("2026-11-23", "18:00", "23:59", NOW).error, "Le début ne peut pas être dans le futur.");
  const today = dayRange("2026-11-23", "00:00", "23:59", NOW);
  assert.equal(today.clamped, true);
  assert.equal(fmt(today.to), "2026-11-23 12:00");
  assert.equal(today.until.toISO(), NOW.toISO());
  const past = dayRange("2026-11-22", "18:00", "02:00", NOW);
  assert.equal(past.clamped, false);
  const overnight = dayRange("2026-11-22", "18:00", "23:00", NOW);
  assert.equal(overnight.clamped, false);
  const tonight = dayRange("2026-11-22", "11:00", "10:00", NOW); // ends tomorrow morning, in the past of now? 23 Nov 10:00 < 12:00
  assert.equal(fmt(tonight.to), "2026-11-23 10:00");
  const future = dayRange("2026-11-22", "11:00", "11:59", at("2026-11-22T11:30:10"));
  assert.equal(future.clamped, true);
  assert.equal(fmt(future.to), "2026-11-22 11:30");
});

// Intention: strict formats; every refusal is an error in French and nothing else is returned.
test("dayRange : formats invalides (date impossible, heure invalide, champ manquant)", () => {
  const bad = [
    ["2026-02-30", "10:00", "11:00", /n'existe pas dans le calendrier/],
    ["2026-13-01", "10:00", "11:00", /n'existe pas dans le calendrier/],
    ["2026-11-5", "10:00", "11:00", /Jour invalide/],
    ["05/11/2026", "10:00", "11:00", /Jour invalide/],
    ["2026-11-05T10:00", "10:00", "11:00", /Jour invalide/],
    ["", "10:00", "11:00", /Jour invalide/],
    [undefined, "10:00", "11:00", /Jour invalide/],
    [null, "10:00", "11:00", /Jour invalide/],
    ["2026-11-05", "24:00", "11:00", /L'heure de début n'existe pas/],
    ["2026-11-05", "10:60", "11:00", /L'heure de début n'existe pas/],
    ["2026-11-05", "10:00", "25:00", /L'heure de fin n'existe pas/],
    ["2026-11-05", "9:00", "11:00", /Heure de début invalide/],
    ["2026-11-05", "10h00", "11:00", /Heure de début invalide/],
    ["2026-11-05", "10:00:00", "11:00", /Heure de début invalide/],
    ["2026-11-05", " 10:00", "11:00", /Heure de début invalide/],
    ["2026-11-05", "", "11:00", /Heure de début invalide/],
    ["2026-11-05", undefined, "11:00", /Heure de début invalide/],
    ["2026-11-05", "10:00", "", /Heure de fin invalide/],
    ["2026-11-05", "10:00", undefined, /Heure de fin invalide/],
    ["2026-11-05", "10:00", "2026-11-05T11:00", /Heure de fin invalide/],
  ];
  for (const [day, from, to, message] of bad) {
    const r = dayRange(day, from, to, NOW);
    assert.match(r.error ?? "", message, JSON.stringify([day, from, to]));
    assert.equal(r.from, undefined);
  }
});

// Intention: the defaults of the day block are today (Paris time) from 00:00 to 23:59, around midnight in Paris included.
test("dayDefaults : aujourd'hui en heure de Paris, de 00:00 à 23:59", () => {
  assert.deepEqual(dayDefaults(at("2026-11-23T12:00:00")), { jour: "2026-11-23", de: "00:00", a: "23:59" });
  const lateUtc = DateTime.fromISO("2026-11-22T23:30:00Z").setZone(ZONE); // already the 23rd in Paris
  assert.equal(dayDefaults(lateUtc).jour, "2026-11-23");
});
