// === WHAT THIS FILE CHECKS ===
// The counterparty column of the statement (page and PDF, free range and whole month): written like the cash register writes a payer
// ("Tom B."), with the same settings (CAISSE_NAME_ORDER, CAISSE_HIDE_PAYER_NAME), left untouched when the text does not look like the
// name of a person, and never leaving a full name in the page or in the PDF. The merchant's own name is not changed. Fictitious names.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { appTest } from "./support/harness.js";
import { entry } from "./support/fake-cyclos.js";
import { pdfPages } from "./support/pdf-text.js";
import { statementCounterparty } from "../src/caisse-data.js";
import { ticketModel, previousMonth } from "../src/releve-calcul.js";
import { options, connected, rowsOf, RANGE } from "./support/releve-support.js";

const ZONE = "Europe/Paris";

// ---------------------------------------------------------------- the rule

// Intention: the format Cyclos writes ("Family - First") gives "First F.", through the very function of the cash register.
test("contrepartie : « Benameur - Tom » donne « Tom B. »", () => {
  assert.equal(statementCounterparty("Benameur - Tom"), "Tom B.");
  assert.equal(statementCounterparty("  Benameur - Tom  "), "Tom B.");
  assert.equal(statementCounterparty("De La Fontaine - Marie"), "Marie D.");
});

test("contrepartie : prénom composé avec trait d'union = un seul mot", () => {
  assert.equal(statementCounterparty("Martin - Jean-Pierre"), "Jean-Pierre M.");
  assert.equal(statementCounterparty("Martin-Durand - Anne-Sophie"), "Anne-Sophie M.");
});

test("contrepartie : initiale accentuée en majuscule", () => {
  assert.equal(statementCounterparty("Éluard - Émilie"), "Émilie É.");
  assert.equal(statementCounterparty("élodie - Marc"), "Marc É.");
  assert.equal(statementCounterparty("Östberg - Åsa"), "Åsa Ö.");
});

test("contrepartie : un seul mot, une valeur vide ou absente restent tels quels", () => {
  assert.equal(statementCounterparty("Tom"), "Tom");
  assert.equal(statementCounterparty(""), "");
  assert.equal(statementCounterparty("   "), "");
  assert.equal(statementCounterparty(null), "");
  assert.equal(statementCounterparty(undefined), "");
});

// Intention: prudence. What does not look like a person is NOT cut: more than two parts, several separators, a first-name side
// of several words, an empty side, a text without letters at the start.
test("contrepartie : structures et formats inattendus laissés tels quels", () => {
  for (const text of [
    "Association Les Amis du Marché", "SARL Le Bon Pain - Boulangerie - Paris", "Dupont - Jean Pierre", "Dupont Jean Pierre",
    "- Tom", "Tom -", "Dupont -", "123 - 456", "Client 1", "Café - 12",
  ]) {
    assert.equal(statementCounterparty(text), text, text);
  }
  assert.equal(statementCounterparty("Tom - Dupont Marie", { nameOrder: "prenom-nom" }), "Tom - Dupont Marie", "initial of a multi-word family name is ambiguous");
});

test("contrepartie : les deux ordres de CAISSE_NAME_ORDER", () => {
  assert.equal(statementCounterparty("Benameur - Tom", { nameOrder: "nom-prenom" }), "Tom B.");
  assert.equal(statementCounterparty("Tom - Benameur", { nameOrder: "prenom-nom" }), "Tom B.");
  // Without separator: the order decides which word is the first name.
  assert.equal(statementCounterparty("Dupont Marie", { nameOrder: "nom-prenom" }), "Marie D.");
  assert.equal(statementCounterparty("Marie Dupont", { nameOrder: "prenom-nom" }), "Marie D.");
  assert.equal(statementCounterparty("Benameur - Tom", { nameOrder: "prenom-nom" }), "Benameur T.", "the setting says what the order is, it is not guessed");
});

test("contrepartie : CAISSE_HIDE_PAYER_NAME donne « Client », une valeur vide reste vide", () => {
  for (const nameOrder of ["nom-prenom", "prenom-nom"]) {
    assert.equal(statementCounterparty("Benameur - Tom", { hidePayerName: true, nameOrder }), "Client");
    assert.equal(statementCounterparty("Association Les Amis", { hidePayerName: true, nameOrder }), "Client");
    assert.equal(statementCounterparty("", { hidePayerName: true, nameOrder }), "");
  }
});

// Intention: the model changes the counterparty of MEMBERS only; a system account (the name of an account type) and the merchant's
// name are shown as they are.
test("contrepartie : le modèle du ticket ne touche ni les comptes système ni le nom du commerçant", () => {
  const entries = [
    { date: "2026-01-10T08:00:00.000Z", amount: "5", relatedAccount: { user: { display: "Benameur - Tom" } } },
    { date: "2026-01-10T09:00:00.000Z", amount: "-1", relatedAccount: { type: { name: "Compte système" } } },
  ];
  const base = { from: DateTime.fromISO("2026-01-10", { zone: ZONE }), to: DateTime.fromISO("2026-01-11", { zone: ZONE }), totals: null, entries, truncated: false, merchantName: "Dupont - Marie", currency: null };
  for (const payerNames of [{}, { nameOrder: "nom-prenom" }]) {
    const m = ticketModel({ ...base, payerNames });
    assert.deepEqual(m.rows.map((r) => r.counterparty), ["Tom B.", "Compte système"]);
    assert.equal(m.merchantName, "Dupont - Marie");
  }
  const hidden = ticketModel({ ...base, payerNames: { hidePayerName: true } });
  assert.deepEqual(hidden.rows.map((r) => r.counterparty), ["Client", "Compte système"]);
  assert.equal(hidden.merchantName, "Dupont - Marie");
});

// ---------------------------------------------------------------- on the server

const MERCHANT = "Marchand - Marie";
const FULL = ["Benameur - Tom", "Martin - Jean-Pierre", "Éluard - Émilie"];
const prev = () => {
  const { year, month } = previousMonth(DateTime.now().setZone(ZONE));
  return { year, month, from: DateTime.fromObject({ year, month, day: 1 }, { zone: ZONE }) };
};
const withWho = (n, who, date) => {
  const e = entry(n, { date });
  e.relatedAccount = { user: { display: who } };
  return e;
};
const rangeEntries = () => FULL.map((who, i) => withWho(i + 1, who, new Date(Date.UTC(2026, 0, 10, 12, i)).toISOString()));
const monthEntries = (m) => FULL.map((who, i) => withWho(i + 1, who, m.from.plus({ days: 2, minutes: i }).toUTC().toISO()));
const counterpartiesOf = (html) => [...html.matchAll(/<span class="contrepartie">(.*?)<\/span>/g)].map((x) => x[1]);
const pdfPost = (b, form) => b.request("/espace/releve/ticket.pdf", { method: "POST", form, headers: { Origin: b.base } });
const pdfText = async (res) => pdfPages(Buffer.from(await res.arrayBuffer())).join("\n");

// Intention: page and PDF show the SAME text, in the free range and in the month mode; no full name is left in the HTML (text, title
// attribute, hidden text) nor in the text of the PDF; the merchant's own name is the one Cyclos gives.
for (const mode of ["plage libre", "mois"]) {
  appTest(`contrepartie : page et PDF identiques, aucun nom complet (${mode})`, options(), async (app) => {
    const m = prev();
    const { b, csrf } = await connected(app, mode === "mois" ? monthEntries(m) : rangeEntries(), { display: MERCHANT });
    const form = mode === "mois" ? { csrf, mois: String(m.month), annee: String(m.year) } : { csrf, ...RANGE };

    const html = await (await b.ticket(form)).text();
    assert.equal(rowsOf(html).length, 3);
    const onPage = counterpartiesOf(html);
    assert.deepEqual(onPage, ["Tom B.", "Jean-Pierre M.", "Émilie É."]);
    for (const name of [...FULL, "Benameur", "Éluard", "Martin"]) {
      assert.ok(!html.includes(name), `${name} must not be in the page`);
    }
    assert.match(html, /<p class="commercant">Marchand - Marie<\/p>/, "the merchant's name is unchanged");
    assert.ok(!/title=/.test(rowsOf(html).join("")));

    const res = await pdfPost(b, form);
    assert.equal(res.status, 200);
    const text = await pdfText(res);
    for (const shown of onPage) assert.ok(text.includes(shown), `${shown} in the PDF`);
    for (const name of [...FULL, "Benameur", "Éluard", "Martin -"]) assert.ok(!text.includes(name), `${name} must not be in the PDF`);
    assert.ok(text.includes("Marchand - Marie"), "the merchant's name is unchanged in the PDF");
  });
}

// Intention: the two settings of the cash register apply to the statement: a hidden name gives "Client" everywhere (page and PDF),
// the order setting changes how the words are read.
appTest("contrepartie : CAISSE_HIDE_PAYER_NAME donne « Client » sur la page et dans le PDF", options({}, { hidePayerName: true }), async (app) => {
  const { b, csrf } = await connected(app, rangeEntries(), { display: MERCHANT });
  const html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.deepEqual(counterpartiesOf(html), ["Client", "Client", "Client"]);
  for (const name of ["Benameur", "Tom", "Éluard", "Émilie", "Martin"]) assert.ok(!html.includes(name), name);
  assert.match(html, /<p class="commercant">Marchand - Marie<\/p>/);
  const text = await pdfText(await pdfPost(b, { csrf, ...RANGE }));
  assert.ok(!/Benameur|Éluard|Martin|Émilie|Tom/.test(text));
  assert.equal(text.match(/\bClient\b/g).length, 3);
});

appTest("contrepartie : CAISSE_NAME_ORDER=prenom-nom suit le même réglage que la caisse", options({}, { nameOrder: "prenom-nom" }), async (app) => {
  const entries = [withWho(1, "Tom - Benameur", new Date(Date.UTC(2026, 0, 10, 12)).toISOString()), withWho(2, "Benameur - Tom", new Date(Date.UTC(2026, 0, 10, 12, 1)).toISOString())];
  const { b, csrf } = await connected(app, entries);
  const html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.deepEqual(counterpartiesOf(html), ["Tom B.", "Benameur T."]);
  const text = await pdfText(await pdfPost(b, { csrf, ...RANGE }));
  assert.ok(text.includes("Tom B.") && text.includes("Benameur T."));
});
