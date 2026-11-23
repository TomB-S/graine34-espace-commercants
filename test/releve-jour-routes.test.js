// === WHAT THIS FILE CHECKS ===
// The "one day, between two hours" mode on the real server (fields jour, de, a) against the fake Cyclos: the bounds sent to Cyclos, the
// ticket (exact dates in the period, never only hours), a range going past midnight (end hour before start hour), refused values (400, Cyclos not called), the
// PDF that asks for the day and the two hours again, and the protections every POST keeps. All names and secrets are fictitious.
import "./support/env-propre.js";
import assert from "node:assert/strict";
import { appTest } from "./support/harness.js";
import { entry } from "./support/fake-cyclos.js";
import { pdfPages } from "./support/pdf-text.js";
import { options, connected, numbersOf, rowsOf, historyCalls } from "./support/releve-support.js";

const PDF = "/espace/releve/ticket.pdf";
const pdf = (b, form) => b.request(PDF, { method: "POST", form, headers: { Origin: b.base } });
// A transaction at a UTC instant (Paris is UTC+1 in January).
const atUtc = (n, iso) => entry(n, { date: new Date(iso).toISOString() });
const DAY = { jour: "2026-01-10", de: "11:00", a: "14:00" };

// Intention: a day between two hours reads exactly that range (Paris time) from Cyclos, the ticket shows the exact dates and hours,
// and the PDF form asks for the day and the two hours again (not two full dates).
appTest("jour : même jour, bornes envoyées à Cyclos, période exacte, formulaire du PDF", options(), async (app) => {
  const { b, csrf } = await connected(app, [
    atUtc(4, "2026-01-10T13:01:00Z"), // 14:01 Paris: out
    atUtc(3, "2026-01-10T13:00:59Z"), // 14:00:59 Paris: in (the last minute is included)
    atUtc(2, "2026-01-10T10:00:00Z"), // 11:00 Paris: in
    atUtc(1, "2026-01-10T09:59:59Z"), // 10:59:59 Paris: out
  ]);
  const res = await b.ticket({ csrf, ...DAY });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.deepEqual(numbersOf(html).sort(), ["T00002", "T00003"]);
  assert.match(html, /<h1>Ticket de fin de service<\/h1>/);
  assert.match(html, /<p class="periode">Du 10\/01\/2026 11:00 au 10\/01\/2026 14:00<\/p>/);
  assert.deepEqual(historyCalls(app)[0].query.getAll("datePeriod"), ["2026-01-10T10:00:00.000Z", "2026-01-10T13:00:59.999Z"]);
  const form = html.split('class="telechargement"')[1].split("</form>")[0];
  assert.match(form, /name="jour" value="2026-01-10"/);
  assert.match(form, /name="de" value="11:00"/);
  assert.match(form, /name="a" value="14:00"/);
  assert.ok(!/name="start"|name="end"|name="mois"/.test(form));
});

// Intention: "À" before "De": the range goes past midnight with no box, the end is the next day, and the period says both full dates.
appTest("jour : passage de minuit, la fin est le lendemain", options(), async (app) => {
  const { b, csrf } = await connected(app, [
    atUtc(4, "2026-01-11T01:30:00Z"), // 02:30 Paris on the 11th: out
    atUtc(3, "2026-01-11T00:30:00Z"), // 01:30 Paris on the 11th: in
    atUtc(2, "2026-01-10T22:30:00Z"), // 23:30 Paris: in
    atUtc(1, "2026-01-10T20:59:00Z"), // 21:59 Paris: out
  ]);
  const html = await (await b.ticket({ csrf, jour: "2026-01-10", de: "22:00", a: "02:00" })).text();
  assert.deepEqual(numbersOf(html).sort(), ["T00002", "T00003"]);
  assert.match(html, /<p class="periode">Du 10\/01\/2026 22:00 au 11\/01\/2026 02:00<\/p>/);
  assert.deepEqual(historyCalls(app)[0].query.getAll("datePeriod"), ["2026-01-10T21:00:00.000Z", "2026-01-11T01:00:59.999Z"]);
});

// Intention: today's end is brought back to now (nothing is read beyond the present), and the ticket says the end that was used.
appTest("jour : aujourd'hui, fin ramenée à maintenant", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const paris = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris", dateStyle: "short" }).format(new Date());
  const before = Date.now();
  const res = await b.ticket({ csrf, jour: paris, de: "00:00", a: "23:59" });
  const after = Date.now();
  // Only meaningful (and only possible) when the test does not run in the very last minute of the day.
  if (res.status === 200) {
    const until = Date.parse(historyCalls(app)[0].query.getAll("datePeriod")[1]);
    assert.ok(until >= before && until <= after);
  } else {
    assert.equal(res.status, 400);
  }
});

// Intention: refused values are a 400 in French with the filters page, and Cyclos is never called; the same form valid works.
appTest("jour : valeurs refusées (400), rien n'est lu chez Cyclos", options(), async (app) => {
  const { b, csrf } = await connected(app, [atUtc(1, "2026-01-10T12:00:00Z")]);
  const bad = [
    [{ ...DAY, jour: "2026-02-30" }, /n'existe pas dans le calendrier/],
    [{ ...DAY, jour: "10/01/2026" }, /Jour invalide/],
    [{ ...DAY, de: "25:00" }, /n'existe pas/],
    [{ ...DAY, a: "9h" }, /Heure de fin invalide/],
    [{ jour: DAY.jour, de: DAY.de }, /Heure de fin invalide/],
    [{ de: DAY.de, a: DAY.a }, /Jour invalide/],
    [{ a: DAY.a }, /Jour invalide/],
    [{ ...DAY, jour: "2999-01-01" }, /Le début ne peut pas être dans le futur/],
    [{ ...DAY, jour: "2026-03-29", de: "02:30", a: "10:00" }, /n'existe pas/],
  ];
  for (const [form, message] of bad) {
    const res = await b.ticket({ csrf, ...form });
    assert.equal(res.status, 400, JSON.stringify(form));
    const html = await res.text();
    assert.match(html, /<form method="post" action="\/espace\/releve\/ticket">/, "the filters page comes back");
    assert.match(html, message, JSON.stringify(form));
  }
  assert.equal(historyCalls(app).length, 0);
  assert.equal((await b.ticket({ csrf, ...DAY })).status, 200, "the same form with valid values works");
});

// Intention: a day with hours does not change how the other modes are recognised: two full dates still work; if a request carried a
// month and a day at once, the month wins (it is checked first).
appTest("jour : les autres modes restent reconnus comme avant", options(), async (app) => {
  const { b, csrf } = await connected(app, [atUtc(1, "2026-01-10T12:00:00Z")]);
  const free = await (await b.ticket({ csrf, start: "2026-01-10T00:00", end: "2026-01-10T23:59" })).text();
  assert.match(free, /<p class="periode">Du 10\/01\/2026 00:00 au 10\/01\/2026 23:59<\/p>/);
  assert.match(free, /name="start" value="2026-01-10T00:00"/);
  const mixed = await b.ticket({ csrf, ...DAY, mois: "13", annee: "2026" });
  assert.equal(mixed.status, 400);
  assert.match(await mixed.text(), /Mois invalide|Année invalide/);
});

// Intention: the PDF asks for the day and the two hours again, is named like the other period tickets (exact dates and hours), says the
// same period as the page, and refuses the same values as the page.
appTest("jour : PDF qui redemande jour et heures, nom cohérent, mêmes refus", options(), async (app) => {
  const { b, csrf } = await connected(app, [atUtc(1, "2026-01-10T22:30:00Z")]);
  const res = await pdf(b, { csrf, jour: "2026-01-10", de: "22:00", a: "02:00" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="ticket-2026-01-10_2200_2026-01-11_0200.pdf"');
  const lines = pdfPages(Buffer.from(await res.arrayBuffer())).join("\n").split("\n");
  assert.ok(lines.includes("Ticket de fin de service"));
  assert.ok(lines.includes("Du 10/01/2026 22:00 au 11/01/2026 02:00"));
  assert.deepEqual(historyCalls(app)[0].query.getAll("datePeriod"), ["2026-01-10T21:00:00.000Z", "2026-01-11T01:00:59.999Z"]);
  const before = historyCalls(app).length;
  for (const form of [{ ...DAY, jour: "2026-02-30" }, { jour: DAY.jour }]) {
    assert.equal((await pdf(b, { csrf, ...form })).status, 400, JSON.stringify(form));
  }
  assert.equal(historyCalls(app).length, before);
});

// Intention: the day mode keeps the protections of every POST: security token, origin, session.
appTest("jour : jeton CSRF, origine et session toujours exigés", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  assert.equal((await b.ticket({ csrf: "0".repeat(64), ...DAY })).status, 403);
  assert.equal((await b.ticket(DAY)).status, 403);
  assert.equal((await b.ticket({ csrf, ...DAY }, { origin: "https://autre.example" })).status, 403);
  assert.equal(historyCalls(app).length, 0);
  assert.equal(rowsOf(await (await b.ticket({ csrf, ...DAY })).text()).length, 0);
});

// Intention: no box any more: the PDF form of an overnight ticket carries only the day and the two hours, and the hidden fields sent
// back as they are give the same PDF; an old form or bookmark that still sends "lendemain" (any value) is ignored without error.
appTest("jour : formulaire du PDF sans case, ancien champ « lendemain » ignoré", options(), async (app) => {
  const { b, csrf } = await connected(app, [atUtc(1, "2026-01-10T22:30:00Z")]);
  const night = { jour: "2026-01-10", de: "22:00", a: "02:00" };
  const html = await (await b.ticket({ csrf, ...night })).text();
  const form = html.split('class="telechargement"')[1].split("</form>")[0];
  assert.match(form, /name="jour" value="2026-01-10"/);
  assert.match(form, /name="de" value="22:00"/);
  assert.match(form, /name="a" value="02:00"/);
  assert.ok(!form.includes("lendemain"));
  assert.match(html, /<p class="periode">Du 10\/01\/2026 22:00 au 11\/01\/2026 02:00<\/p>/);
  const fields = Object.fromEntries([...form.matchAll(/name="(\w+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  assert.equal((await pdf(b, fields)).status, 200);
  for (const old of ["1", "oui", "", "0"]) {
    const res = await b.ticket({ csrf, ...night, lendemain: old });
    assert.equal(res.status, 200, `lendemain=${old}`);
    assert.match(await res.text(), /Du 10\/01\/2026 22:00 au 11\/01\/2026 02:00/);
    assert.equal((await pdf(b, { csrf, ...night, lendemain: old })).status, 200);
  }
  // Same-day hours with the old field checked stay on the same day.
  const same = await (await b.ticket({ csrf, ...DAY, lendemain: "1" })).text();
  assert.match(same, /<p class="periode">Du 10\/01\/2026 11:00 au 10\/01\/2026 14:00<\/p>/);
});

// Intention: end equal to start is 24 full hours up to the same hour the next day, end to end (Cyclos read once, both dates shown).
appTest("jour : heure de fin égale à l'heure de début = 24 heures complètes", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const ok = await b.ticket({ csrf, jour: "2026-01-10", de: "18:00", a: "18:00" });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Du 10\/01\/2026 18:00 au 11\/01\/2026 18:00/);
  assert.deepEqual(historyCalls(app)[0].query.getAll("datePeriod"), ["2026-01-10T17:00:00.000Z", "2026-01-11T17:00:59.999Z"]);
});
