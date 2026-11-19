// === WHAT THIS FILE CHECKS ===
// The pure part of the statement (/espace/releve): date ranges (Paris time, summer and winter time changes), exact amounts in
// integers, the summary totals ("Non disponible" rather than an invented figure) and the content of the ticket. No server, no
// network: same input, same output. Most of these tests come from the original statement tool, with the same expectations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  parseRange,
  presetRange,
  rangeValues,
  ticketModel,
  toUnits,
  fromUnits,
  totalsFromEntries,
  withComputedTotals,
  readHistoryLimits,
} from "../src/releve-calcul.js";

// "10 am" means nothing without saying WHERE: everything is computed in Paris time, which changes twice a year.
const ZONE = "Europe/Paris";
const at = (iso) => DateTime.fromISO(iso, { zone: ZONE });
// A fixed "fake current time": the results do not depend on the day the tests run.
const NOW = at("2026-11-05T12:00:30"); // Thursday, winter time
const NA = "Non disponible";

// ---------------------------------------------------------------- dates

// Intention: a normal range is accepted, and the end includes the LAST minute (11:59 goes up to 11:59:59.999).
test("parseRange : plage valide, la dernière minute est incluse", () => {
  const r = parseRange("2026-11-05T08:00", "2026-11-05T11:59", NOW);
  assert.equal(r.error, undefined);
  assert.equal(r.clamped, false);
  assert.equal(r.from.toISO(), "2026-11-05T08:00:00.000+01:00");
  assert.equal(r.to.toFormat("HH:mm"), "11:59");
  assert.equal(r.until.toFormat("HH:mm:ss.SSS"), "11:59:59.999");
});

test("parseRange : format invalide", () => {
  for (const bad of ["", undefined, null, "2026-11-05 08:00", "05/11/2026 08:00", "2026-11-05T08:00:30", "2026-11-5T8:00", "abc"]) {
    assert.match(parseRange(bad, "2026-11-05T09:00", NOW).error, /Date de début invalide.*format attendu/, String(bad));
    assert.match(parseRange("2026-11-05T08:00", bad, NOW).error, /Date de fin invalide.*format attendu/, String(bad));
  }
});

test("parseRange : date absente du calendrier", () => {
  assert.match(parseRange("2026-02-30T10:00", "2026-03-01T10:00", NOW).error, /début n'existe pas dans le calendrier/);
  assert.match(parseRange("2026-11-01T10:00", "2026-13-01T10:00", NOW).error, /fin n'existe pas dans le calendrier/);
});

test("parseRange : fin avant le début, ou égale au début", () => {
  assert.equal(parseRange("2026-11-05T10:00", "2026-11-05T09:00", NOW).error, "La fin doit être après le début.");
  assert.equal(parseRange("2026-11-05T10:00", "2026-11-05T10:00", NOW).error, "La fin doit être après le début.");
});

// Intention: the range is limited to 31 days (exactly 31 is accepted, one more minute is refused).
test("parseRange : 31 jours au plus", () => {
  const ok = parseRange("2026-10-05T00:00", "2026-11-05T00:00", NOW);
  assert.equal(ok.error, undefined);
  assert.match(parseRange("2026-10-05T00:00", "2026-11-05T00:01", NOW).error, /ne peut pas dépasser 31 jours/);
  assert.match(parseRange("2026-01-01T00:00", "2026-11-05T00:00", NOW).error, /ne peut pas dépasser 31 jours/);
});

test("parseRange : début dans le futur refusé", () => {
  assert.equal(parseRange("2026-11-05T12:01", "2026-11-05T13:00", NOW).error, "Le début ne peut pas être dans le futur.");
  assert.equal(parseRange("2027-01-01T00:00", "2027-01-02T00:00", NOW).error, "Le début ne peut pas être dans le futur.");
});

// Intention: a future end is tolerated but brought back to "now" (`clamped`), since nothing exists afterwards.
test("parseRange : fin dans le futur ramenée à maintenant", () => {
  const r = parseRange("2026-11-05T10:00", "2026-11-06T10:00", NOW);
  assert.equal(r.error, undefined);
  assert.equal(r.clamped, true);
  assert.equal(r.to.toFormat("yyyy-MM-dd HH:mm"), "2026-11-05 12:00");
  assert.equal(r.until.toMillis(), NOW.toMillis());
});

// Edge case: start = now and a future end. Once the end is brought back to now, the end is not after the start: normal error.
test("parseRange : début à la seconde même de maintenant et fin future -> fin avant le début", () => {
  const now = at("2026-11-05T12:00:00");
  assert.equal(parseRange("2026-11-05T12:00", "2026-11-05T13:00", now).error, "La fin doit être après le début.");
});

// Intention: at the switch to summer time (29 March 2026), there is no 02:30. Luxon would silently shift it to 03:30; we warn
// the merchant instead, otherwise the ticket would cover a different period from the one they think.
test("parseRange : heure inexistante au passage à l'heure d'été (29 mars 2026, 02:30)", () => {
  const now = at("2026-04-01T12:00");
  const start = parseRange("2026-03-29T02:30", "2026-03-29T10:00", now);
  assert.match(start.error, /heure de début saisie \(29\/03\/2026 à 02:30\) n'existe pas/);
  const end = parseRange("2026-03-29T01:00", "2026-03-29T02:30", now);
  assert.match(end.error, /heure de fin saisie \(29\/03\/2026 à 02:30\) n'existe pas/);
  // The neighbouring hours exist.
  assert.equal(parseRange("2026-03-29T01:59", "2026-03-29T03:00", now).error, undefined);
});

// Known and ACCEPTED case: on 25 October 2026, 02:30 exists twice (summer then winter). The tool keeps the second, without warning.
// This test freezes that behaviour (it is listed among the known limits); if it changes, it is a choice to make again.
test("parseRange : heure ambiguë (25 octobre 2026, 02:30) acceptée, seconde occurrence (heure d'hiver) retenue", () => {
  const now = at("2026-11-01T12:00");
  const r = parseRange("2026-10-25T02:30", "2026-10-25T10:00", now);
  assert.equal(r.error, undefined);
  assert.equal(r.from.offset, 60);
  assert.equal(r.from.toUTC().toISO(), "2026-10-25T01:30:00.000Z");
});

test("presetRange : aujourd'hui, hier, 6 heures, préréglage inconnu", () => {
  const now = at("2026-11-05T12:34:56");
  const fmt = ({ start, end }) => [start.toFormat("yyyy-MM-dd HH:mm"), end.toFormat("yyyy-MM-dd HH:mm")];
  assert.deepEqual(fmt(presetRange("aujourdhui", now)), ["2026-11-05 00:00", "2026-11-05 12:34"]);
  assert.deepEqual(fmt(presetRange(undefined, now)), ["2026-11-05 00:00", "2026-11-05 12:34"]);
  assert.deepEqual(fmt(presetRange("inconnu", now)), ["2026-11-05 00:00", "2026-11-05 12:34"]);
  assert.deepEqual(fmt(presetRange("hier", now)), ["2026-11-04 00:00", "2026-11-04 23:59"]);
  assert.deepEqual(fmt(presetRange("6h", now)), ["2026-11-05 06:34", "2026-11-05 12:34"]);
});

test("rangeValues : format des champs du formulaire", () => {
  assert.deepEqual(rangeValues({ start: at("2026-11-05T00:00"), end: at("2026-11-05T12:34") }), { start: "2026-11-05T00:00", end: "2026-11-05T12:34" });
});

// ---------------------------------------------------------------- exact amounts

// Intention: amounts are read as exact integers of the smallest unit; anything finer than the currency, or not a plain decimal, is null.
test("toUnits et fromUnits : entiers exacts, rien n'est arrondi", () => {
  assert.equal(toUnits("10.25", 2), 1025n);
  assert.equal(toUnits("-0.05", 2), -5n);
  assert.equal(toUnits("7", 2), 700n);
  assert.equal(toUnits("7.5", 2), 750n);
  assert.equal(toUnits("1.500", 2), 150n, "des zéros en trop ne changent pas la valeur");
  assert.equal(toUnits("1.505", 2), null, "plus fin que la monnaie : refusé, pas arrondi");
  assert.equal(toUnits("1500", 0), 1500n);
  for (const bad of ["abc", "", null, undefined, "1e5", "1,5", "--1", "1.2.3"]) assert.equal(toUnits(bad, 2), null, String(bad));
  assert.equal(fromUnits(1025n, 2), "10.25");
  assert.equal(fromUnits(-5n, 2), "-0.05");
  assert.equal(fromUnits(0n, 2), "0.00");
  assert.equal(fromUnits(15n, 0), "15");
  assert.equal(fromUnits(123456789012345678901234567890n, 2), "1234567890123456789012345678.90", "pas de limite des flottants");
});

test("totalsFromEntries : reçus, sortis, net ; un montant illisible donne null", () => {
  const list = (...amounts) => amounts.map((amount) => ({ amount }));
  assert.deepEqual(totalsFromEntries(list("0.10", "0.20", "-0.10", "-0.20", "-0.20"), 2), {
    incoming: { count: 2, sum: "0.30" },
    outgoing: { count: 3, sum: "0.50" },
    netInflow: "-0.20",
  });
  assert.deepEqual(totalsFromEntries(list("0.00", "-3.00"), 2), {
    incoming: { count: 0, sum: "0.00" },
    outgoing: { count: 1, sum: "3.00" },
    netInflow: "-3.00",
  });
  assert.deepEqual(totalsFromEntries(list("10", "5", "-4"), 0), {
    incoming: { count: 2, sum: "15" },
    outgoing: { count: 1, sum: "4" },
    netInflow: "11",
  });
  assert.equal(totalsFromEntries(list("1.00", "abc"), 2), null);
  assert.equal(totalsFromEntries([{}], 2), null);
  // 0.1 added 10 000 times: a float would drift, integers do not.
  assert.equal(totalsFromEntries(list(...Array(10000).fill("0.10")), 2).incoming.sum, "1000.00");
  assert.deepEqual(totalsFromEntries([], 2), { incoming: { count: 0, sum: "0.00" }, outgoing: { count: 0, sum: "0.00" }, netInflow: "0.00" });
});

// Intention: Cyclos' own totals are kept as they are; otherwise they are computed, but only from a COMPLETE list.
test("withComputedTotals : totaux de Cyclos gardés, sinon calculés si la liste est complète, jamais sur une liste tronquée", () => {
  const entries = [{ amount: "1.00" }, { amount: "-0.40" }];
  const given = { status: { incoming: { count: 7, sum: "70.00" }, outgoing: { count: 3, sum: "30.00" }, netInflow: "40.00" } };
  assert.equal(withComputedTotals(given, entries, false, 2), given);
  assert.equal(withComputedTotals(given, entries, true, 2), given);
  const computed = withComputedTotals({ status: { balance: "1" } }, entries, false, 2);
  assert.equal(computed.status.balance, "1", "le reste du statut est conservé");
  assert.deepEqual(computed.status.incoming, { count: 1, sum: "1.00" });
  assert.equal(computed.status.netInflow, "0.60");
  assert.deepEqual(withComputedTotals({ status: {} }, entries, true, 2), { status: {} }, "tronquée : rien n'est calculé");
  assert.equal(withComputedTotals(undefined, entries, true, 2), undefined);
  assert.deepEqual(withComputedTotals({}, [{ amount: "abc" }], false, 2), {}, "montant illisible : rien n'est inventé");
});

test("readHistoryLimits : valeurs par défaut, nombres entiers positifs seulement", () => {
  assert.deepEqual(readHistoryLimits({}), { pageSize: 200, maxRows: 2000 });
  assert.deepEqual(readHistoryLimits({ HISTORY_PAGE_SIZE: "50", HISTORY_MAX_ROWS: "300" }), { pageSize: 50, maxRows: 300 });
  for (const bad of ["", "0", "-5", "abc", "1.5", "NaN"]) {
    assert.deepEqual(readHistoryLimits({ HISTORY_PAGE_SIZE: bad, HISTORY_MAX_ROWS: bad }), { pageSize: 200, maxRows: 2000 }, bad);
  }
});

// ---------------------------------------------------------------- ticket

const totals = (incoming, outgoing, netInflow) => ({
  status: { incoming, outgoing, ...(netInflow === undefined ? {} : { netInflow }) },
});
const baseStatement = {
  from: at("2026-01-10T08:00"),
  to: at("2026-01-10T18:00"),
  entries: [],
  truncated: false,
  merchantName: "Boutique",
  currency: { name: "Graines", decimalDigits: 2 },
};

test("ticketModel : résumé avec solde net fourni par Cyclos", () => {
  const m = ticketModel({ ...baseStatement, totals: totals({ count: 3, sum: "1234.50" }, { count: 1, sum: "4.50" }, "1230.00") });
  assert.deepEqual(m.summary, [
    { label: "3 paiements reçus", value: "1\u202f234,50" },
    { label: "1 paiement sorti", value: "4,50" },
    { label: "Solde net", value: "+1\u202f230,00", net: true },
  ]);
  assert.equal(m.unit, "Montants en Graines");
  assert.equal(m.period, "Du 10/01/2026 08:00 au 10/01/2026 18:00");
  assert.match(m.generated, /^Ticket généré le \d\d\/\d\d\/\d{4} à \d\d:\d\d$/);
  assert.equal(m.title, "Ticket de fin de service");
  assert.equal(m.start, "2026-01-10T08:00");
  assert.equal(m.end, "2026-01-10T18:00");
  assert.equal(m.warning, "");
});

test("ticketModel : la date de génération suit l'heure donnée (Paris)", () => {
  const m = ticketModel({ ...baseStatement, totals: totals({ count: 0, sum: "0" }, { count: 0, sum: "0" }) }, at("2026-07-14T09:05"));
  assert.equal(m.generated, "Ticket généré le 14/07/2026 à 09:05");
});

// Intention: without the net balance from Cyclos, it is computed (received - sent), negative or zero included, with no rounding error.
test("ticketModel : solde net calculé quand Cyclos ne le donne pas, négatif, nul", () => {
  const negative = ticketModel({ ...baseStatement, totals: totals({ count: 1, sum: "5.00" }, { count: 2, sum: "12.25" }) });
  assert.equal(negative.summary[2].value, "-7,25");
  const zero = ticketModel({ ...baseStatement, totals: totals({ count: 0, sum: "0.00" }, { count: 0, sum: "0.00" }) });
  assert.deepEqual(zero.summary.map((s) => s.label), ["0 paiement reçu", "0 paiement sorti", "Solde net"]);
  assert.equal(zero.summary[2].value, "0,00");
  const floats = ticketModel({ ...baseStatement, totals: totals({ count: 2, sum: "0.30" }, { count: 0, sum: "0.10" }) });
  assert.equal(floats.summary[2].value, "+0,20");
});

test("ticketModel : monnaie absente -> 2 décimales, nom d'unité vide ; nom du commerçant absent", () => {
  const m = ticketModel({ ...baseStatement, currency: undefined, merchantName: null, totals: totals({ count: 1, sum: "2" }, { count: 0, sum: "0" }) });
  assert.equal(m.unit, "Montants en ");
  assert.equal(m.summary[0].value, "2,00");
  assert.equal(m.merchantName, null);
});

test("ticketModel : lignes du plus ancien au plus récent, heure de Paris, contrepartie", () => {
  const entries = [
    { date: "2026-07-10T08:30:00.000Z", amount: "-3.00", transactionNumber: "C", description: "Remboursement", relatedAccount: { type: { name: "Compte système" } } },
    { date: "2026-01-10T08:00:00.000Z", amount: "10.5", transactionNumber: "A", description: "Pain", relatedAccount: { user: { display: "Alice" } } },
    { date: "2026-03-29T00:30:00.000Z", amount: "1", relatedAccount: {} },
  ];
  const m = ticketModel({ ...baseStatement, entries, totals: totals({ count: 2, sum: "11.5" }, { count: 1, sum: "3" }) });
  assert.deepEqual(m.rows.map((r) => r.when), ["10/01 09:00", "29/03 01:30", "10/07 10:30"]);
  assert.deepEqual(m.rows.map((r) => r.counterparty), ["Alice", "", "Compte système"]);
  assert.deepEqual(m.rows.map((r) => r.amount), ["+10,50", "+1,00", "-3,00"]);
  assert.deepEqual(m.rows.map((r) => r.number), ["A", "", "C"]);
  assert.deepEqual(m.rows.map((r) => r.description), ["Pain", "", "Remboursement"]);
});

test("ticketModel : avertissement quand la liste est tronquée", () => {
  const m = ticketModel({ ...baseStatement, truncated: true, totals: totals({ count: 0, sum: "0" }, { count: 0, sum: "0" }) });
  assert.match(m.warning, /limitée aux 2000 transactions les plus récentes/);
  assert.match(m.warning, /totaux du résumé restent exacts/);
});

test("ticketModel : le plafond affiché est celui avec lequel la liste a été lue", () => {
  const m = ticketModel({ ...baseStatement, maxRows: 300, truncated: true, totals: { status: {} } });
  assert.match(m.warning, /limitée aux 300 transactions/);
  assert.match(m.warning, /au-delà de 300 transactions/);
  assert.ok(!m.warning.includes("2000"));
});

// Intention: "defensive" reading: whatever the shape of the totals (missing, empty, partial, unreadable), no exception and the
// summary says "Non disponible". Otherwise an unexpected answer from Cyclos would crash the merchant's page.
test("ticketModel : totaux absents, vides ou incomplets -> pas d'exception, 'Non disponible'", () => {
  const cases = [
    undefined,
    null,
    {},
    { status: {} },
    { status: null },
    { status: { balance: "125.00", availableBalance: "125.00", creditLimit: "0.00", reservedAmount: "0.00", upperCreditLimit: "1000.00" } },
    { status: { incoming: { count: 1, sum: "1.00" } } },
    { status: { outgoing: { count: 1, sum: "1.00" } } },
    { status: { incoming: {}, outgoing: {} } },
    { status: { incoming: { count: 1, sum: "x" }, outgoing: { count: 1, sum: "1.00" } } },
  ];
  for (const t of cases) {
    const m = ticketModel({ ...baseStatement, totals: t });
    assert.deepEqual(m.summary.map((s) => s.value), [NA, NA, NA], JSON.stringify(t));
    assert.match(m.warning, /Non disponible/);
  }
});

test("ticketModel : totaux absents et liste tronquée -> avertissement dédié", () => {
  const m = ticketModel({ ...baseStatement, totals: { status: {} }, truncated: true });
  assert.match(m.warning, /ne peuvent pas être calculés au-delà de 2000 transactions/);
  assert.deepEqual(m.summary.map((s) => s.label), ["Paiements reçus", "Paiements sortis", "Solde net"]);
});

test("ticketModel : indicateurs présents sans netInflow -> net exact en entiers", () => {
  const m = ticketModel({ ...baseStatement, totals: { status: { incoming: { count: 2, sum: "0.30" }, outgoing: { count: 1, sum: "0.10" } } } });
  assert.deepEqual(m.summary.map((s) => s.value), ["0,30", "0,10", "+0,20"]);
  assert.equal(m.warning, "");
});
