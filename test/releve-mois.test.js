// === WHAT THIS FILE CHECKS ===
// The "whole month" mode of the statement (/espace/releve): the bounds of a month (pure functions: 28 to 31 days, the two clock changes,
// year change, strict validation, current and future months), and the mode on the real server against the paginated fake Cyclos: a
// complete month, the current month, refused months, refused values, its own cap of lines, the PDF. All names and secrets are fictitious.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { appTest } from "./support/harness.js";
import { entry } from "./support/fake-cyclos.js";
import { pdfPages } from "./support/pdf-text.js";
import { pdfFilename } from "../src/releve-pdf.js";
import {
  MAX_RANGE_DAYS, MONTH_NAMES, allowedYears, previousMonth, monthRange, exceedsMaxRange, readMonthMaxRows, ticketModel,
} from "../src/releve-calcul.js";
import { options, connected, on, summaryOf, rowsOf, numbersOf, historyCalls } from "./support/releve-support.js";

const ZONE = "Europe/Paris";
// A fixed "now" for the pure tests: allowed years are 2026, 2027 and 2028.
const NOW = DateTime.fromISO("2028-06-15T10:30:20", { zone: ZONE });
const range = (year, month, now = NOW) => monthRange(String(year), String(month), now);
const hours = (r) => (r.until.toMillis() - r.from.toMillis() + 1) / 3_600_000;
const iso = (dt) => dt.toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ");

// ---------------------------------------------------------------- pure functions: bounds

// Intention: a month starts on the 1st at 00:00 and ends like "Hier" (last day 23:59, and Cyclos gets the last millisecond of that minute),
// for every length of month.
test("mois : février 2027 (28 jours), février 2028 (29), avril (30), janvier (31)", () => {
  const feb27 = range(2027, 2, DateTime.fromISO("2028-06-15", { zone: ZONE }));
  assert.equal(iso(feb27.from), "2027-02-01T00:00:00.000+01:00");
  assert.equal(iso(feb27.to), "2027-02-28T23:59:00.000+01:00");
  assert.equal(iso(feb27.until), "2027-02-28T23:59:59.999+01:00");
  assert.equal(hours(feb27), 28 * 24);

  const feb28 = range(2028, 2);
  assert.equal(iso(feb28.to), "2028-02-29T23:59:00.000+01:00");
  assert.equal(hours(feb28), 29 * 24);

  const apr = range(2027, 4, DateTime.fromISO("2028-06-15", { zone: ZONE }));
  assert.equal(iso(apr.from), "2027-04-01T00:00:00.000+02:00", "summer time: the offset comes from Luxon, not from a constant");
  assert.equal(iso(apr.until), "2027-04-30T23:59:59.999+02:00");
  assert.equal(hours(apr), 30 * 24);

  const jan = range(2028, 1);
  assert.equal(iso(jan.until), "2028-01-31T23:59:59.999+01:00");
  assert.equal(hours(jan), 31 * 24);
  for (const r of [feb27, feb28, apr, jan]) {
    assert.equal(r.clamped, false);
    assert.equal(r.current, false);
    assert.ok(!exceedsMaxRange(r.from, r.to));
  }
});

// Intention: the limit is counted in calendar days, NOT in elapsed hours: October 2026 lasts 745 hours (the clock goes back on
// 25 October) and March 2027 lasts 743 hours (it goes forward on 28 March); both are accepted, and the UTC bounds follow the offsets.
test("mois : octobre 2026 (745 h) et mars 2027 (743 h) acceptés, bornes UTC justes", () => {
  const now = DateTime.fromISO("2028-06-15", { zone: ZONE });
  const oct = range(2026, 10, now);
  assert.equal(oct.error, undefined);
  assert.equal(hours(oct), 745);
  assert.ok(hours(oct) > MAX_RANGE_DAYS * 24, "more than 31 x 24 hours, still one month");
  assert.equal(oct.from.toUTC().toISO(), "2026-09-30T22:00:00.000Z"); // CEST, UTC+2
  assert.equal(oct.until.toUTC().toISO(), "2026-10-31T22:59:59.999Z"); // CET, UTC+1
  assert.ok(!exceedsMaxRange(oct.from, oct.to));

  const mar = range(2027, 3, now);
  assert.equal(mar.error, undefined);
  assert.equal(hours(mar), 743);
  assert.equal(mar.from.toUTC().toISO(), "2027-02-28T23:00:00.000Z"); // CET, UTC+1
  assert.equal(mar.until.toUTC().toISO(), "2027-03-31T21:59:59.999Z"); // CEST, UTC+2
});

// Intention: the free range keeps its own limit (31 calendar days, end included): the month mode did not loosen it.
test("plage libre : la limite de 31 jours reste celle d'avant", () => {
  const from = DateTime.fromISO("2026-10-01T00:00", { zone: ZONE });
  assert.equal(exceedsMaxRange(from, DateTime.fromISO("2026-11-01T00:00", { zone: ZONE })), false);
  assert.equal(exceedsMaxRange(from, DateTime.fromISO("2026-11-01T00:01", { zone: ZONE })), true);
});

// Intention: December leads straight into January of the next year: nothing is lost or counted twice between two months, and the
// previous month of January is December of the year before.
test("mois : décembre puis janvier de l'année suivante, mois contigus", () => {
  const dec = range(2027, 12);
  const jan = range(2028, 1);
  assert.equal(iso(dec.until), "2027-12-31T23:59:59.999+01:00");
  assert.equal(iso(jan.from), "2028-01-01T00:00:00.000+01:00");
  assert.equal(jan.from.toMillis() - dec.until.toMillis(), 1);
  for (let month = 1; month < 12; month += 1) {
    const a = range(2027, month);
    const b = range(2027, month + 1);
    assert.equal(b.from.toMillis() - a.until.toMillis(), 1, `month ${month} to ${month + 1}`);
  }
  assert.deepEqual(previousMonth(DateTime.fromISO("2028-01-05T09:00", { zone: ZONE })), { year: 2027, month: 12 });
  assert.deepEqual(previousMonth(NOW), { year: 2028, month: 5 });
});

// Intention: the current month is accepted, its end is brought back to now, and the label says it is not over.
test("mois : le mois en cours est accepté, fin plafonnée à maintenant, libellé explicite", () => {
  const r = range(2028, 6);
  assert.equal(r.error, undefined);
  assert.equal(iso(r.from), "2028-06-01T00:00:00.000+02:00");
  assert.equal(iso(r.to), "2028-06-15T10:30:00.000+02:00");
  assert.equal(r.until.toMillis(), NOW.toMillis());
  assert.equal(r.clamped, true);
  assert.equal(r.current, true);
  assert.equal(r.title, "Relevé du mois de juin 2028");
  assert.equal(r.label, "juin 2028 (mois en cours, jusqu'au 15/06/2028 à 10:30)");
  assert.ok(!exceedsMaxRange(r.from, r.to));
  // The first day of a month: the range is tiny but valid.
  const first = range(2028, 6, DateTime.fromISO("2028-06-01T00:20:00", { zone: ZONE }));
  assert.equal(first.error, undefined);
  assert.equal(iso(first.to), "2028-06-01T00:20:00.000+02:00");
});

// Intention: a month that has not started is refused with a message in French (not an "invalid value": the value is well formed).
test("mois : un mois futur est refusé, en français", () => {
  const r = range(2028, 7);
  assert.equal(r.invalid, undefined);
  assert.equal(r.from, undefined);
  assert.equal(r.error, "Ce mois n'a pas encore commencé : choisissez le mois en cours ou un mois passé.");
  assert.ok(range(2028, 12).error);
});

// Intention: year and month are checked strictly against a white list; anything else is an invalid value.
test("mois : valeurs invalides refusées (liste blanche stricte)", () => {
  assert.deepEqual(allowedYears(NOW), [2026, 2027, 2028]);
  for (const bad of ["0", "13", "-1", "00", "01", "1.5", "1e1", " 5", "5 ", "+5", "abc", "", "٥", "5\n", "12; DROP", null, undefined]) {
    const r = monthRange("2027", bad, NOW);
    assert.equal(r.invalid, true, `month ${JSON.stringify(bad)}`);
    assert.match(r.error, /^Mois invalide/);
  }
  for (const bad of ["2025", "2029", "27", "0", "02027", "2027 ", " 2027", "20e3", "2027.0", "-2027", "abc", "", null, undefined]) {
    const r = monthRange(bad, "5", NOW);
    assert.equal(r.invalid, true, `year ${JSON.stringify(bad)}`);
    assert.match(r.error, /^Année invalide/);
  }
  for (let month = 1; month <= 12; month += 1) assert.equal(range(2027, month).invalid, undefined);
});

// Intention: the month is written in full, with the elision before a vowel; the PDF is named after the year and the month.
test("mois : titre du ticket (élision) et nom du fichier PDF", () => {
  assert.deepEqual(MONTH_NAMES.length, 12);
  const titles = [1, 2, 3, 4, 5, 8, 10, 12].map((m) => range(2027, m).title);
  assert.deepEqual(titles, [
    "Relevé du mois de janvier 2027", "Relevé du mois de février 2027", "Relevé du mois de mars 2027", "Relevé du mois d'avril 2027",
    "Relevé du mois de mai 2027", "Relevé du mois d'août 2027", "Relevé du mois d'octobre 2027", "Relevé du mois de décembre 2027",
  ]);
  const r = range(2027, 3);
  assert.equal(pdfFilename({ from: r.from, to: r.to, month: r }), "releve-2027-03.pdf");
  assert.equal(pdfFilename({ from: r.from, to: r.to, month: range(2026, 11) }), "releve-2026-11.pdf");
  const model = ticketModel({ from: r.from, to: r.to, totals: null, entries: [], truncated: false, merchantName: "X", currency: null, month: r }, NOW);
  assert.equal(model.title, "Relevé du mois de mars 2027");
  assert.equal(model.period, "Du 01/03/2027 00:00 au 31/03/2027 23:59");
  assert.deepEqual(model.month, { year: 2027, month: 3 });
  const current = ticketModel({ from: range(2028, 6).from, to: range(2028, 6).to, totals: null, entries: [], truncated: false, currency: null, month: range(2028, 6) }, NOW);
  assert.equal(current.period, "Du 01/06/2028 00:00 au 15/06/2028 10:30 (mois en cours)");
});

// Intention: the cap of the month mode is a setting; a bad value gives the default, and it is independent of HISTORY_MAX_ROWS.
test("mois : plafond HISTORY_MAX_ROWS_MONTH (défaut 10000)", () => {
  assert.equal(readMonthMaxRows({}), 10000);
  assert.equal(readMonthMaxRows({ HISTORY_MAX_ROWS_MONTH: "500" }), 500);
  for (const bad of ["0", "-5", "1.5", "abc", "", " "]) assert.equal(readMonthMaxRows({ HISTORY_MAX_ROWS_MONTH: bad }), 10000, JSON.stringify(bad));
  assert.equal(readMonthMaxRows({ HISTORY_MAX_ROWS: "5" }), 10000);
});

// ---------------------------------------------------------------- the mode on the real server

// The month before today, as the form offers it by default, and entries spread over it.
const now = () => DateTime.now().setZone(ZONE);
const previous = () => {
  const { year, month } = previousMonth(now());
  return { year, month, from: DateTime.fromObject({ year, month, day: 1 }, { zone: ZONE }) };
};
const at = (dt, n, extra = {}) => entry(n, { ...extra, date: dt.toUTC().toISO() });
const monthForm = (csrf, { year, month }) => ({ csrf, mois: String(month), annee: String(year) });

// Intention: a whole month is read COMPLETELY through the pages (3 pages for 450 lines), asks Cyclos for exactly the month bounds (UTC),
// leaves out what is just before or just after, and the ticket is titled and dated as a month.
appTest("mois : mois complet lu sur plusieurs pages, bornes exactes, titre et période", options(), async (app) => {
  const m = previous();
  const last = m.from.endOf("month").startOf("minute");
  const inside = Array.from({ length: 450 }, (_, i) => at(m.from.plus({ hours: 1 + i }), i, { amount: i % 4 === 3 ? "-2.50" : "3.25" })).reverse();
  const edges = [
    at(m.from.minus({ seconds: 1 }), 9001), // last second of the month before: out
    at(m.from, 9002), // first instant: in
    at(last.plus({ seconds: 59, milliseconds: 999 }), 9003), // last millisecond of the last minute: in
    at(last.plus({ minutes: 1 }), 9004), // first instant of the next month: out
  ];
  const { b, csrf } = await connected(app, [...inside, ...edges]);
  const res = await b.ticket(monthForm(csrf, m));
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.equal(rowsOf(html).length, 452);
  assert.ok(numbersOf(html).includes("T09002") && numbersOf(html).includes("T09003"));
  assert.ok(!numbersOf(html).includes("T09001") && !numbersOf(html).includes("T09004"));
  assert.deepEqual(historyCalls(app).map((p) => p.query.get("page")), ["0", "1", "2"]);
  const expected = [m.from.toUTC().toISO(), m.from.endOf("month").startOf("minute").plus({ minutes: 1 }).minus({ milliseconds: 1 }).toUTC().toISO()];
  for (const call of [...historyCalls(app), ...app.cyclos.calls("GET", "/self/accounts/MonComptePro")]) {
    assert.deepEqual(call.query.getAll("datePeriod"), expected);
  }
  const name = MONTH_NAMES[m.month - 1];
  assert.match(html, new RegExp(`<h1>Relevé du mois d(?:e |')${name} ${m.year}</h1>`));
  assert.match(html, new RegExp(`<p class="periode">Du 01/${String(m.month).padStart(2, "0")}/${m.year} 00:00 au \\d\\d/${String(m.month).padStart(2, "0")}/${m.year} 23:59</p>`));
  assert.ok(!html.includes("mois en cours"));
  assert.ok(!html.includes('class="avertissement"'));
  const summary = summaryOf(html);
  assert.equal(summary.length, 3);
  assert.ok(summary.every(([, value]) => value !== "Non disponible"));
  // The PDF form asks for the same month again, not for two dates.
  assert.match(html, new RegExp(`name="mois" value="${m.month}"`));
  assert.match(html, new RegExp(`name="annee" value="${m.year}"`));
  assert.ok(!/name="start"/.test(html.split("telechargement")[1] ?? ""));
});

// Intention: the current month is accepted; its end is NOT in the future (Cyclos is asked up to now), and the ticket says it is under way.
appTest("mois : mois en cours accepté, fin plafonnée à maintenant, ticket qui le dit", options(), async (app) => {
  const today = now();
  const { b, csrf } = await connected(app, [at(today.startOf("month"), 1), at(today.startOf("month").plus({ seconds: 1 }), 2)]);
  const before = Date.now();
  const res = await b.ticket(monthForm(csrf, { year: today.year, month: today.month }));
  const after = Date.now();
  assert.equal(res.status, 200);
  const html = await res.text();
  const [from, until] = historyCalls(app)[0].query.getAll("datePeriod").map((d) => Date.parse(d));
  assert.equal(from, today.startOf("month").toMillis());
  assert.ok(until >= before && until <= after, "the end sent to Cyclos is the present moment");
  assert.match(html, /\(mois en cours\)<\/p>/);
  assert.match(html, new RegExp(`<h1>Relevé du mois d(?:e |')${MONTH_NAMES[today.month - 1]} ${today.year}</h1>`));
  assert.equal(rowsOf(html).length, 2);
});

// Intention: a month that has not started (or a year that is not offered) is refused with a French message, nothing is read from
// Cyclos, and the page of the filters comes back with the error.
appTest("mois : mois futur refusé (400), rien n'est lu chez Cyclos", options(), async (app) => {
  const today = now();
  const { b, csrf } = await connected(app, [on(1)]);
  const future = today.month < 12 ? { year: today.year, month: today.month + 1 } : { year: today.year + 1, month: 1 };
  const res = await b.ticket(monthForm(csrf, future));
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /<h1>Choisir la période<\/h1>/); // updated: the page title was "Choisir la plage horaire" before the filters redesign
  assert.match(html, today.month < 12 ? /Ce mois n&#39;a pas encore commencé|Ce mois n'a pas encore commencé/ : /Année invalide/);
  assert.equal(historyCalls(app).length, 0);
});

// Intention: nothing but a whole month number and a listed year is accepted; each refusal is a 400 and Cyclos is not called.
appTest("mois : valeurs invalides refusées (400)", options(), async (app) => {
  const today = now();
  const { b, csrf } = await connected(app, [on(1)]);
  const good = { mois: "1", annee: String(today.year - 1) };
  const bad = [
    { ...good, mois: "0" }, { ...good, mois: "13" }, { ...good, mois: "abc" }, { ...good, mois: "01" }, { ...good, mois: "1 " },
    { ...good, mois: "" }, { ...good, annee: String(today.year - 3) }, { ...good, annee: String(today.year + 1) },
    { ...good, annee: "abcd" }, { ...good, annee: "" }, { mois: "1" }, { annee: String(today.year) },
  ];
  for (const form of bad) {
    const res = await b.ticket({ csrf, ...form });
    assert.equal(res.status, 400, JSON.stringify(form));
    assert.match(await res.text(), /<h1>Choisir la période<\/h1>/); // updated: the page title was "Choisir la plage horaire" before the filters redesign
  }
  assert.equal(historyCalls(app).length, 0);
  assert.equal((await b.ticket({ csrf, ...good })).status, 200, "the same form with valid values works");
});

// Intention: the month mode keeps the protections of every POST: security token, origin.
appTest("mois : jeton CSRF et origine toujours exigés", options(), async (app) => {
  const m = previous();
  const { b, csrf } = await connected(app, [on(1)]);
  assert.equal((await b.ticket({ csrf: "0".repeat(64), mois: String(m.month), annee: String(m.year) })).status, 403);
  assert.equal((await b.ticket({ mois: String(m.month), annee: String(m.year) })).status, 403);
  assert.equal((await b.ticket(monthForm(csrf, m), { origin: "http://autre.example" })).status, 403);
  assert.equal(historyCalls(app).length, 0);
});

// Intention: the month mode has its OWN cap: where the free range stops (here 25 lines), the month goes on (here up to 60). When
// even that cap is reached, the list is cut with a warning and, without totals from Cyclos, the totals are "Non disponible", never invented.
appTest("mois : plafond propre au mois ; atteint -> liste coupée, avertissement, totaux « Non disponible »", options({ history: { pageSize: 10, maxRows: 25 }, historyMonthMaxRows: 60 }), async (app) => {
  const m = previous();
  const entries = Array.from({ length: 100 }, (_, i) => at(m.from.plus({ hours: 1 + i }), i, { amount: "1.00" })).reverse();
  const { b, csrf } = await connected(app, entries);
  app.cyclos.state.indicators = false;

  const free = { start: m.from.plus({ days: 1 }).toFormat("yyyy-MM-dd'T'HH:mm"), end: m.from.plus({ days: 20 }).toFormat("yyyy-MM-dd'T'HH:mm") };
  const freeHtml = await (await b.ticket({ csrf, ...free })).text();
  assert.equal(rowsOf(freeHtml).length, 25, "the free range keeps HISTORY_MAX_ROWS");
  assert.match(freeHtml, /limitée aux 25 transactions/);

  const html = await (await b.ticket(monthForm(csrf, m))).text();
  assert.equal(rowsOf(html).length, 60);
  assert.match(html, /limitée aux 60 transactions les plus récentes/);
  assert.match(html, /ne peuvent pas être calculés au-delà de 60 transactions/);
  assert.deepEqual(summaryOf(html), [["Paiements reçus", "Non disponible"], ["Paiements sortis", "Non disponible"], ["Solde net", "Non disponible"]]);

  // Under the cap, the totals are computed from the complete list.
  setEntriesOf(app, entries.slice(0, 40));
  const small = await (await b.ticket(monthForm(csrf, m))).text();
  assert.equal(rowsOf(small).length, 40);
  assert.ok(!small.includes('class="avertissement"'));
  assert.deepEqual(summaryOf(small).map(([, v]) => v).slice(0, 1), ["40,00"]);
});

function setEntriesOf(app, entries) {
  app.cyclos.state.users.get("marie").entries = entries;
}

// Intention: the default cap of the month mode is 10000 lines (not the 2000 of the free range): 2300 lines are all there.
appTest("mois : plafond par défaut de 10000 lignes (2300 lignes lues en entier)", options(), async (app) => {
  const m = previous();
  const entries = Array.from({ length: 2300 }, (_, i) => at(m.from.plus({ minutes: 5 + i }), i, { amount: "1.00" })).reverse();
  const { b, csrf } = await connected(app, entries);
  const html = await (await b.ticket(monthForm(csrf, m))).text();
  assert.equal(rowsOf(html).length, 2300);
  assert.ok(!html.includes('class="avertissement"'));
  assert.equal(historyCalls(app).length, 12, "2300 lines at 200 per page");
});

// Intention: the filters page offers the month block: labelled lists, French month names, three years, the previous month preselected,
// a "Voir le mois" button (and no "Mois dernier" shortcut); every form carries the security token; still no script.
appTest("mois : page des filtres (listes, libellés, préremplissage, raccourci, sans script)", options(), async (app) => {
  const m = previous();
  const today = now();
  const { b, csrf } = await connected(app);
  const res = await b.request("/espace/releve");
  const html = await res.text();
  assert.ok(!res.headers.get("content-security-policy").includes("script-src"));
  assert.ok(!/<script/i.test(html));
  assert.match(html, /<h2 id="titre-mensuel">Un mois complet<\/h2>/); // updated: the block was titled "Relevé mensuel" before the filters redesign
  assert.match(html, /<label for="mois">Mois<\/label>\s*<select id="mois" name="mois" required>/);
  assert.match(html, /<label for="annee">Année<\/label>\s*<select id="annee" name="annee" required>/);
  const monthOptions = [...html.split('id="mois"')[1].split("</select>")[0].matchAll(/<option value="(\d+)"( selected)?>(.*?)<\/option>/g)];
  assert.deepEqual(monthOptions.map((o) => o[3]), ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"]);
  assert.deepEqual(monthOptions.filter((o) => o[2]).map((o) => o[1]), [String(m.month)]);
  const yearOptions = [...html.split('id="annee"')[1].split("</select>")[0].matchAll(/<option value="(\d+)"( selected)?>/g)];
  assert.deepEqual(yearOptions.map((o) => o[1]), [today.year - 2, today.year - 1, today.year].map(String));
  assert.deepEqual(yearOptions.filter((o) => o[2]).map((o) => o[1]), [String(m.year)]);
  assert.match(html, /<button type="submit">Voir le mois<\/button>/);
  assert.ok(!html.includes("Mois dernier"), "no \"Mois dernier\" shortcut any more");
  assert.equal([...html.matchAll(/name="csrf" value="([0-9a-f]+)"/g)].filter((x) => x[1] === csrf).length, 3, "three forms (day, month, free range), the session's token each time"); // updated: 2 before the day block was added
  assert.match(html, /<a href="\/espace\/releve\?preset=6h">/, "the other shortcuts are still there");
});

// Intention: the PDF of a month is named releve-AAAA-MM.pdf, titled with the month in full, readable over many pages (column titles
// repeated, page numbers) and quick to build for 1500 lines.
appTest("mois : PDF releve-AAAA-MM.pdf, titre, 1500 lignes lisibles", options(), async (app) => {
  const m = previous();
  const entries = Array.from({ length: 1500 }, (_, i) => at(m.from.plus({ minutes: 10 + i * 5 }), i, { amount: i % 4 === 3 ? "-2.50" : "3.25" })).reverse();
  const { b, csrf } = await connected(app, entries);
  const started = Date.now();
  const res = await b.request("/espace/releve/ticket.pdf", { method: "POST", form: monthForm(csrf, m), headers: { Origin: b.base } });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="releve-${m.year}-${String(m.month).padStart(2, "0")}.pdf"`);
  assert.ok(elapsed < 15_000, `1500 lines in ${elapsed} ms`);
  const pages = pdfPages(Buffer.from(await res.arrayBuffer()));
  assert.ok(pages.length > 20);
  assert.match(pages[0], new RegExp(`Relevé du mois d(?:e |')${MONTH_NAMES[m.month - 1]} ${m.year}`));
  assert.match(pages[0], /Du 01\/\d\d\/\d{4} 00:00 au /);
  pages.forEach((page, i) => {
    assert.match(page, /N° de transaction/, `column titles on page ${i + 1}`);
    assert.match(page, new RegExp(`Page ${i + 1} / ${pages.length}`));
  });
  const numbers = pages.join("\n").match(/\bT\d{5}\b/g);
  assert.equal(numbers.length, 1500);
  assert.equal(new Set(numbers).size, 1500, "every line once");
});

// Intention: a month PDF refuses a bad month like the ticket does (400, nothing read).
appTest("mois : PDF d'un mois invalide ou futur refusé (400)", options(), async (app) => {
  const today = now();
  const { b, csrf } = await connected(app, [on(1)]);
  for (const form of [{ mois: "13", annee: String(today.year) }, { mois: "1", annee: "1999" }]) {
    const res = await b.request("/espace/releve/ticket.pdf", { method: "POST", form: { csrf, ...form }, headers: { Origin: b.base } });
    assert.equal(res.status, 400);
  }
  assert.equal(historyCalls(app).length, 0);
});
