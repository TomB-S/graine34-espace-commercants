// === WHAT THIS FILE CHECKS ===
// The cash register page shows only the payments of TODAY (Paris time, midnight to midnight). With none, it shows the recap of
// yesterday ("Hier : 12 paiements, 87,00 G", "Hier : 1 paiement, 1,00 G", or "Aucun paiement hier"). Checked here:
//   - the pure pieces (days around a moment, exact sum of decimal strings, recap of the lines of the history, texts);
//   - the JSON and the HTML for: today's payments only, no payment today, no payment today nor yesterday, plural and singular,
//     the change of day at midnight, nothing about a recap while the listening is not working;
//   - the reading of the period with the fake Cyclos: several pages, an exact total, the limit of 20 pages (an error, never a
//     wrong total), a failed reading (an error, never a wrong total, and today's payments still show), the new day;
//   - the real server: a payment received today replaces the recap at once, an outgoing payment never counts.
// All values are fictitious.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./support/env-propre.js";
import { appTest, USER } from "./support/harness.js";
import { startFakeCyclos, entry, paymentNotification, transfer, todayAt } from "./support/fake-cyclos.js";
import { dayBounds, dayKey, sumAmounts, summarizeYesterday, PERIOD_MAX_PAGES, PERIOD_PAGE_SIZE } from "../src/day-recap.js";
import { recapOf, renderCaisseData } from "../src/caisse-data.js";
import { renderCaissePage } from "../src/caisse-page.js";
import { makeTicket, createTicketStore, ticketsOfDay } from "../src/ticket-store.js";
import { createPaymentProcessor } from "../src/payment-processor.js";
import { createListener } from "../src/cyclos-listener.js";
import { createCyclosPush } from "../src/cyclos-push.js";
import { readCaisseConfig } from "../src/caisse-config.js";
import { formatAmount, escapeHtml } from "../src/server.js";
import { parisDayKey } from "../web/js/date-line.js";

const NOW = Date.parse("2026-06-15T10:00:00Z"); // 12:00 in Paris
const at = (iso) => Date.parse(iso);
const line = (n, iso, amount = "1.00") => ({ transactionNumber: `T${String(n).padStart(5, "0")}`, date: iso, amount });
const YESTERDAY = "2026-06-14T12:00:00+02:00";
const TODAY = "2026-06-15T09:00:00+02:00";

// ---- days ----

test("jour : le jour se compte en heure de Paris, de minuit à minuit", () => {
  assert.equal(dayKey(at("2026-06-14T21:59:59Z")), "2026-06-14"); // 23:59:59 in Paris
  assert.equal(dayKey(at("2026-06-14T22:00:00Z")), "2026-06-15"); // 00:00:00 in Paris (summer time)
  assert.equal(dayKey(at("2026-01-14T22:59:59Z")), "2026-01-14"); // winter time
  assert.equal(dayKey(at("2026-01-14T23:00:00Z")), "2026-01-15");
});

test("jour : bornes de la lecture, hier 00:00 à demain 00:00, justes les jours de changement d'heure", () => {
  const normal = dayBounds(NOW);
  assert.deepEqual([normal.todayKey, normal.yesterdayKey], ["2026-06-15", "2026-06-14"]);
  assert.equal(normal.from, "2026-06-14T00:00:00.000+02:00");
  assert.equal(normal.to, "2026-06-16T00:00:00.000+02:00");
  assert.equal(normal.nextMidnight, at("2026-06-15T22:00:00Z"));
  const spring = dayBounds(at("2026-03-29T12:00:00Z")); // 23-hour day
  assert.equal(spring.from, "2026-03-28T00:00:00.000+01:00");
  assert.equal(spring.to, "2026-03-30T00:00:00.000+02:00");
  const autumn = dayBounds(at("2026-10-25T12:00:00Z")); // 25-hour day
  assert.equal(autumn.from, "2026-10-24T00:00:00.000+02:00");
  assert.equal(autumn.to, "2026-10-26T00:00:00.000+01:00");
});

test("jour : le script reconnaît le changement de jour de Paris (même résultat que le serveur)", () => {
  for (const iso of ["2026-06-14T21:59:59Z", "2026-06-14T22:00:00Z", "2026-01-14T22:59:59Z", "2026-01-14T23:00:00Z", "2026-03-29T00:30:00Z"]) {
    assert.equal(parisDayKey(at(iso)), dayKey(at(iso)), iso);
  }
});

// ---- exact sum ----

test("somme : exacte en graines, jamais d'arrondi flottant", () => {
  assert.deepEqual(sumAmounts(["0.10", "0.20"]), { total: "0.30", digits: 2 });
  assert.equal(sumAmounts(Array.from({ length: 10 }, () => "0.10")).total, "1.00");
  assert.equal(sumAmounts(["1.005", "2.5"]).total, "3.505", "mixed numbers of decimals");
  assert.equal(sumAmounts(["12", "0.50"], 2).total, "12.50");
  assert.equal(sumAmounts(["0.01"], 2).total, "0.01");
  assert.equal(sumAmounts(["9007199254740993.01", "0.01"]).total, "9007199254740993.02", "beyond what a float can hold");
  assert.equal(sumAmounts([], 2).total, "0.00");
  assert.equal(sumAmounts(["5", "6"]).total, "11");
});

test("somme : un montant illisible fait échouer toute la somme", () => {
  for (const bad of ["abc", "1,50", "", null, undefined, 3, "-1.00", "1.2.3"]) assert.equal(sumAmounts(["1.00", bad]), null, String(bad));
});

// ---- recap of yesterday from the lines ----

test("bilan : seules les lignes d'hier comptent, un paiement vu deux fois compte une fois, un débit jamais", () => {
  const lines = [
    line(5, TODAY, "9.00"),
    line(4, "2026-06-14T23:59:00+02:00", "1.10"),
    line(3, YESTERDAY, "2.20"),
    line(3, YESTERDAY, "2.20"), // same payment on two pages
    line(2, "2026-06-14T00:00:00+02:00", "3.30"),
    line(1, "2026-06-13T23:59:59+02:00", "50.00"), // the day before: out
    { ...line(9, YESTERDAY, "-4.00") },
  ];
  assert.deepEqual(summarizeYesterday(lines, NOW, 2), { count: 3, total: "6.60" });
});

test("bilan : une ligne d'hier illisible (montant ou date) = pas de bilan, jamais un total faux", () => {
  assert.equal(summarizeYesterday([line(1, YESTERDAY, "abc")], NOW), null);
  assert.equal(summarizeYesterday([line(1, "pas une date")], NOW), null);
  assert.equal(summarizeYesterday([{ transactionNumber: "T1", amount: "1.00" }], NOW), null);
  assert.deepEqual(summarizeYesterday([], NOW, 2), { count: 0, total: "0.00" });
});

// ---- texts: plural, singular, none ----

const fmt = (value, digits) => formatAmount(value, digits);
const ok = (count, total) => ({ day: "2026-06-14", state: "ok", count, total, decimals: 2, suffix: " G" });

test("bilan : texte au pluriel, au singulier, et aucun paiement hier", () => {
  assert.deepEqual(recapOf(ok(12, "87.00"), NOW, fmt), { kind: "summary", text: "Hier : 12 paiements, 87,00 G" });
  assert.deepEqual(recapOf(ok(1, "1.00"), NOW, fmt), { kind: "summary", text: "Hier : 1 paiement, 1,00 G" });
  assert.deepEqual(recapOf(ok(2, "1234.50"), NOW, fmt), { kind: "summary", text: "Hier : 2 paiements, 1 234,50 G" });
  assert.deepEqual(recapOf(ok(0, "0.00"), NOW, fmt), { kind: "none", text: "Aucun paiement hier" });
});

test("bilan : erreur, limite atteinte, pas encore lu ou jour changé = jamais un total", () => {
  assert.equal(recapOf({ day: "2026-06-14", state: "error" }, NOW, fmt).kind, "error");
  const many = recapOf({ day: "2026-06-14", state: "tooMany" }, NOW, fmt);
  assert.equal(many.kind, "error");
  assert.match(many.text, /trop de paiements/);
  assert.equal(recapOf(null, NOW, fmt).kind, "pending");
  // The recap read for the 14th is stale once the day is the 16th: "pending" until the new one is read.
  assert.equal(recapOf(ok(12, "87.00"), at("2026-06-16T10:00:00Z"), fmt).kind, "pending");
});

// ---- the JSON and the HTML ----

const ticket = (n, iso) => makeTicket({ transfer: transfer(n, { date: iso, amount: "1.00" }), source: "push", arrivedAt: at(iso) });
const data = (view, now = NOW) => renderCaisseData({ loaded: true, ...view }, { hidePayerName: false, now }, { formatAmount: fmt });
const page = (view, now = NOW) =>
  renderCaissePage(
    { loaded: true, ...view },
    { refreshSeconds: 5, hidePayerName: false, now, csrfToken: "x" },
    { escapeHtml, formatAmount: fmt, htmlPage: () => "", errorMessage: () => "", logoutForm: () => "" },
  );

test("jour : seuls les paiements d'aujourd'hui sont envoyés, aucun autre jour n'apparaît", () => {
  const tickets = [ticket(3, TODAY), ticket(2, YESTERDAY), ticket(1, "2026-06-10T12:00:00+02:00")];
  const result = data({ status: "live", tickets, recap: ok(5, "5.00") });
  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0].number, "T00003");
  assert.equal(result.recap, null, "a payment today: no recap");
  const html = page({ status: "live", tickets, recap: ok(5, "5.00") });
  assert.ok(html.includes("T00003") && !html.includes("T00002") && !html.includes("T00001"));
  assert.ok(!html.includes("Paiements précédents") && !html.includes("Hier"));
});

test("jour : la liste du bas ne contient que des paiements d'aujourd'hui", () => {
  const tickets = [ticket(4, TODAY), ticket(3, "2026-06-15T08:00:00+02:00"), ticket(2, YESTERDAY), ticket(1, "2026-06-10T12:00:00+02:00")];
  const html = page({ status: "live", tickets, recap: ok(1, "1.00") });
  assert.equal(html.match(/<li class="caisse-ligne">/g).length, 1);
  assert.ok(!html.includes("T00002") && !html.includes("T00001"));
});

test("jour : aucun paiement aujourd'hui = bilan d'hier à la place, au pluriel", () => {
  const view = { status: "live", tickets: [ticket(2, YESTERDAY)], recap: ok(12, "87.00") };
  assert.deepEqual(data(view).tickets, []);
  assert.deepEqual(data(view).recap, { kind: "summary", text: "Hier : 12 paiements, 87,00 G" });
  const html = page(view);
  assert.match(html, /Hier : 12 paiements, 87,00 G/);
  assert.ok(!html.includes("caisse-gros") && !html.includes("Paiements précédents"));
});

test("jour : bilan d'hier au singulier", () => {
  const view = { status: "live", tickets: [], recap: ok(1, "1.00") };
  assert.equal(data(view).recap.text, "Hier : 1 paiement, 1,00 G");
  assert.match(page(view), /Hier : 1 paiement, 1,00 G/);
});

test("jour : ni aujourd'hui ni hier = « Aucun paiement hier »", () => {
  const view = { status: "fallback", tickets: [], recap: ok(0, "0.00") };
  assert.equal(data(view).recap.text, "Aucun paiement hier");
  assert.match(page(view), /Aucun paiement hier/);
});

test("jour : lecture du bilan en échec = message d'erreur clair, pas de total", () => {
  for (const recap of [{ day: "2026-06-14", state: "error" }, { day: "2026-06-14", state: "tooMany" }]) {
    const html = page({ status: "live", tickets: [], recap });
    assert.match(html, /caisse-bandeau erreur/);
    assert.match(html, /Prévenir l'équipe La Graine 34/);
    assert.ok(!/Hier :/.test(html));
    assert.equal(data({ status: "live", tickets: [], recap }).recap.kind, "error");
  }
});

test("jour : pas de bilan tant que l'écoute ne fonctionne pas (la bannière parle)", () => {
  for (const status of ["starting", "reconnecting", "degraded", "error"]) {
    assert.equal(data({ status, tickets: [], recap: ok(3, "3.00") }).recap, null, status);
    assert.ok(!/Hier :|Aucun paiement hier/.test(page({ status, tickets: [], recap: ok(3, "3.00") })), status);
  }
});

test("jour : passage de minuit, les paiements du jour partent et le bilan du nouveau jour est attendu puis affiché", () => {
  const tickets = [ticket(2, "2026-06-15T23:50:00+02:00"), ticket(1, "2026-06-15T09:00:00+02:00")];
  const recapOfThe14th = ok(4, "4.00");
  const before = at("2026-06-15T21:59:00Z"); // 23:59 on the 15th in Paris
  assert.equal(data({ status: "live", tickets, recap: recapOfThe14th }, before).tickets.length, 2);
  // 00:01 on the 16th: the same server state, nothing of the 15th is shown, and the recap of the 14th is NOT the one of the new yesterday.
  const after = at("2026-06-15T22:01:00Z");
  const night = data({ status: "live", tickets, recap: recapOfThe14th }, after);
  assert.deepEqual(night.tickets, []);
  assert.equal(night.recap.kind, "pending");
  assert.match(page({ status: "live", tickets, recap: recapOfThe14th }, after), /Bilan d'hier en cours de lecture/);
  // Once the recap of the 15th is read, it is shown.
  const done = data({ status: "live", tickets, recap: { day: "2026-06-15", state: "ok", count: 2, total: "2.00", decimals: 2, suffix: " G" } }, after);
  assert.equal(done.recap.text, "Hier : 2 paiements, 2,00 G");
});

test("jour : un paiement juste avant et juste après minuit (heure de Paris) n'est pas du même jour", () => {
  const tickets = [ticket(2, "2026-06-15T00:00:01+02:00"), ticket(1, "2026-06-14T23:59:59+02:00")];
  assert.equal(ticketsOfDay(tickets, NOW).length, 1);
});

// ---- the reading of the period, with the fake Cyclos ----

async function waitFor(condition, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé : ${what}`);
}

// A processor and a listener on the fake Cyclos, with a clock the test can move.
async function withPeriod({ entries = [], wrap, clock = { at: Date.now() } }, fn) {
  const cyclos = await startFakeCyclos();
  cyclos.state.push.lifetimeMs = null;
  cyclos.state.entries = entries;
  const rawPush = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  const push = wrap ? wrap(rawPush) : rawPush;
  const store = createTicketStore();
  const log = { info() {}, error() {} };
  const config = readCaisseConfig({}, { enabled: true, login: USER.login, password: USER.password, safetyPollSeconds: 3600, historyInitial: 10 });
  const now = () => clock.at;
  const processor = createPaymentProcessor({ config, push, store, log, now, debounceMs: 50 });
  const listener = createListener({ merchantKey: "prototype", config, push, store, log, processor, shortStreamMs: 0 });
  try {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1 && store.status() !== "starting", "flux ouvert");
    await fn({ cyclos, store, processor, clock });
  } finally {
    await listener.stop();
    await cyclos.close();
  }
}

const dated = (n, day, amount) => entry(n, { amount, date: new Date(todayAt(n, day)).toISOString() });

test("période : plusieurs pages lues, total d'hier exact, paiements du jour en tickets", () =>
  withPeriod({ entries: [...Array.from({ length: 3 }, (_, i) => dated(1000 + i, 0, "1.00")), ...Array.from({ length: 250 }, (_, i) => dated(250 - i, -1, "0.10"))] }, async ({ cyclos, store }) => {
    assert.equal(store.recap.state, "ok");
    assert.equal(store.recap.count, 250);
    assert.equal(store.recap.total, "25.00", "250 x 0.10, no rounding error");
    assert.equal(store.recap.day, dayBounds(Date.now()).yesterdayKey);
    assert.equal(store.size, 3, "yesterday's payments are not tickets");
    assert.equal(store.list().every((t) => t.source === "initial"), true);
    const calls = cyclos.calls("GET", "/self/accounts/membre/history");
    assert.deepEqual(calls.map((c) => c.query.get("page")), ["0", "1", "2"], "pages of 100, read until the last one");
    assert.ok(calls.every((c) => c.query.get("pageSize") === String(PERIOD_PAGE_SIZE) && c.query.get("direction") === "credit"));
  }));

test("période : aucun paiement hier = bilan à zéro, et rien d'avant-hier n'est compté", () =>
  withPeriod({ entries: [dated(1, -2, "40.00")] }, async ({ store }) => {
    assert.equal(store.recap.state, "ok");
    assert.equal(store.recap.count, 0);
    assert.equal(store.size, 0);
  }));

test("période : plus de 20 pages = erreur « trop de paiements », jamais un total peut-être faux", () =>
  withPeriod({ entries: Array.from({ length: PERIOD_MAX_PAGES * PERIOD_PAGE_SIZE + 1 }, (_, i) => dated(i + 1, -1, "1.00")) }, async ({ cyclos, store }) => {
    assert.equal(store.recap.state, "tooMany");
    assert.equal(store.recap.total, undefined);
    assert.equal(cyclos.calls("GET", "/self/accounts/membre/history").length, PERIOD_MAX_PAGES, "never more than 20 pages");
  }));

test("période : exactement 20 pages pleines sans suite = bilan complet", () =>
  withPeriod({ entries: Array.from({ length: PERIOD_MAX_PAGES * PERIOD_PAGE_SIZE }, (_, i) => dated(i + 1, -1, "1.00")) }, async ({ store }) => {
    assert.equal(store.recap.state, "ok");
    assert.equal(store.recap.count, 2000);
    assert.equal(store.recap.total, "2000.00");
  }));

test("période : lecture en échec = bilan en erreur (jamais un faux total), les paiements du jour s'affichent quand même", () =>
  withPeriod(
    { entries: [dated(2, 0, "3.00"), dated(1, -1, "1.00")], wrap: (push) => ({ ...push, getCreditsPeriod: async () => { throw new Error("panne de test"); } }) },
    async ({ store }) => {
      assert.equal(store.recap.state, "error");
      assert.equal(store.recap.count, undefined);
      assert.equal(store.size, 2, "the usual reading of the latest payments still fills the tickets");
      assert.equal(ticketsOfDay(store.list(), Date.now()).length, 1);
    },
  ));

test("période : une ligne illisible hier = bilan en erreur", () =>
  withPeriod({ entries: [dated(1, -1, "1e2"), dated(2, -1, "1.00")] }, async ({ store }) => {
    assert.equal(store.recap.state, "error");
  }));

test("période : après un échec, la lecture suivante retente et le bilan revient", () => {
  let failing = true;
  return withPeriod(
    { entries: [dated(1, -1, "2.00")], wrap: (push) => ({ ...push, getCreditsPeriod: (...args) => (failing ? Promise.reject(new Error("panne")) : push.getCreditsPeriod(...args)) }) },
    async ({ store, processor }) => {
      assert.equal(store.recap.state, "error");
      failing = false;
      await processor.reconcile();
      assert.equal(store.recap.state, "ok");
      assert.equal(store.recap.count, 1);
    },
  );
});

test("période : au passage de minuit, le bilan est relu pour le nouveau « hier »", () => {
  const day = (iso) => Date.parse(iso);
  const entries = [
    { ...entry(3, { amount: "2.00" }), date: "2026-06-15T20:00:00.000+02:00" },
    { ...entry(2, { amount: "3.00" }), date: "2026-06-15T09:00:00.000+02:00" },
    { ...entry(1, { amount: "7.00" }), date: "2026-06-14T09:00:00.000+02:00" },
  ];
  return withPeriod({ entries, clock: { at: day("2026-06-15T21:00:00Z") } }, async ({ store, processor, clock }) => {
    assert.equal(store.recap.day, "2026-06-14");
    assert.equal(store.recap.count, 1);
    assert.equal(store.recap.total, "7.00");
    clock.at = day("2026-06-15T22:05:00Z"); // 00:05 on the 16th
    await processor.reconcile();
    assert.equal(store.recap.day, "2026-06-15");
    assert.equal(store.recap.count, 2);
    assert.equal(store.recap.total, "5.00");
  });
});

// ---- the real server ----

const ON = { enabled: true, login: USER.login, password: USER.password };
const OPTIONS = { caisse: ON, caisseHooks: { listenerOptions: { shortStreamMs: 0, sleep: async () => {} }, processorOptions: { debounceMs: 50, retryDelaysMs: [30, 30, 30] } } };

async function dataUntil(app, predicate, what) {
  const end = Date.now() + 4000;
  let body = null;
  while (Date.now() < end) {
    const res = await app.request("/caisse/data");
    assert.equal(res.status, 200);
    body = await res.json();
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Délai dépassé : ${what}\n${JSON.stringify(body).slice(0, 800)}`);
}

appTest("caisse : aucun paiement aujourd'hui = bilan d'hier (reçus seulement), puis un paiement du jour le remplace", OPTIONS, async (app) => {
  app.cyclos.state.push.lifetimeMs = null;
  app.cyclos.state.entries = [dated(3, -1, "50.00"), dated(2, -1, "37.00"), dated(1, -1, "-20.00")]; // the last one is a payment SENT
  assert.equal((await app.login()).status, 303);
  const first = await dataUntil(app, (d) => d.status === "live" && d.recap, "bilan d'hier");
  assert.deepEqual(first.tickets, []);
  assert.deepEqual(first.recap, { kind: "summary", text: "Hier : 2 paiements, 87,00 G" });
  const html = await (await app.request("/caisse")).text();
  assert.match(html, /Hier : 2 paiements, 87,00 G/);
  assert.ok(!html.includes("caisse-gros"));

  // A payment arrives today: the recap goes, the ticket shows.
  app.cyclos.state.transfers.set("tr-9", transfer(9, { amount: "4.00", date: new Date().toISOString().replace("Z", "+00:00") }));
  app.cyclos.push("newNotification", paymentNotification(9, { date: new Date().toISOString().replace("Z", "+00:00") }));
  const second = await dataUntil(app, (d) => d.tickets.length === 1, "ticket du jour");
  assert.equal(second.recap, null);
  assert.equal(second.tickets[0].isNew, true);
  const html2 = await (await app.request("/caisse")).text();
  assert.ok(html2.includes("caisse-gros") && !html2.includes("Hier :"));
});

appTest("caisse : ni aujourd'hui ni hier = « Aucun paiement hier »", OPTIONS, async (app) => {
  app.cyclos.state.push.lifetimeMs = null;
  app.cyclos.state.entries = [dated(1, -3, "10.00")];
  assert.equal((await app.login()).status, 303);
  const body = await dataUntil(app, (d) => d.status === "live" && d.recap, "bilan");
  assert.deepEqual(body.recap, { kind: "none", text: "Aucun paiement hier" });
  assert.match(await (await app.request("/caisse")).text(), /Aucun paiement hier/);
});

appTest("caisse : les paiements d'un autre jour ne sont jamais sur la page", OPTIONS, async (app) => {
  app.cyclos.state.push.lifetimeMs = null;
  app.cyclos.state.entries = [dated(2, 0, "2.00"), dated(5, -1, "5.00"), dated(4, -2, "4.00")];
  assert.equal((await app.login()).status, 303);
  const body = await dataUntil(app, (d) => d.tickets.length > 0, "paiement du jour");
  assert.equal(body.tickets.length, 1);
  assert.equal(body.tickets[0].amount, "2,00 G");
  const html = await (await app.request("/caisse")).text();
  assert.ok(html.includes("2,00 G") && !html.includes("5,00 G") && !html.includes("4,00 G"));
});
