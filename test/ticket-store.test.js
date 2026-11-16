// === WHAT THIS FILE CHECKS ===
// The ticket model and the store (ticket-store.js), with no server and no network: a complete ticket from a transfer, the description
// read in transaction.description, the payer fallbacks, the amount kept as a STRING, an unreadable amount giving an incomplete ticket,
// the display (comma, suffix, decimals, Paris time around the clock changes), de-duplication (one payment seen three ways gives one
// ticket, an incomplete ticket is replaced and never doubled), order, bounds, the "New" mark, and the state shown on the page.
// All values are fictitious. Basic notions: test/statique.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
// MUST stay first: cleans the environment variables before server.js is loaded (see env-propre.js).
import "../test-support/env-propre.js";
import { formatAmount } from "../server.js";
import { transfer, paymentNotification, entry } from "../test-support/fake-cyclos.js";
import { makeTicket, createTicketStore, ticketDisplay, isNew, transferShapeOfTransaction } from "../ticket-store.js";

const NOW = Date.parse("2026-01-10T12:00:00Z");

// A ticket as the listener builds it from a notification and its transfer.
function pushTicket(n, { arrivedAt = NOW, ...options } = {}) {
  return makeTicket({
    notification: paymentNotification(n).notification,
    transfer: transfer(n, options),
    entityId: `tr-${n}`,
    source: "push",
    arrivedAt,
  });
}

// ---- the model ----

// Intention: a full transfer gives a complete ticket, with the amount still a string and the description from transaction.description.
test("ticket : transfert complet, ticket complet, montant resté chaîne, description dans transaction.description", () => {
  const t = pushTicket(1, { amount: "1.00", description: "Objet fictif" });
  assert.equal(t.complete, true);
  assert.equal(t.amount, "1.00");
  assert.equal(typeof t.amount, "string");
  assert.equal(t.transactionNumber, "T00001");
  assert.equal(t.description, "Objet fictif");
  assert.equal(t.payer, "Payeur 1");
  assert.equal(t.entityId, "tr-1");
  assert.equal(t.source, "push");
  assert.equal(t.currencySuffix, " G");
  assert.equal(t.decimals, 2);
});

// Intention: the description is NOT read at the root of the transfer (it is absent there on the real instance).
test("ticket : la description du transfert est lue dans transaction.description, jamais à la racine", () => {
  const body = { ...transfer(2, { description: "Bonne description" }), description: "Mauvaise description" };
  assert.equal(makeTicket({ transfer: body, source: "push", arrivedAt: NOW }).description, "Bonne description");
  const rootOnly = { ...transfer(2), transaction: {}, description: "Racine seulement" };
  assert.equal(makeTicket({ transfer: rootOnly, source: "push", arrivedAt: NOW }).description, "");
  assert.equal(pushTicket(3, { description: "" }).description, "");
});

// Intention: a transaction answer (description at the root) is put in the transfer shape for the same builder.
test("ticket : réponse /transactions mise en forme de transfert (description à la racine)", () => {
  const shaped = transferShapeOfTransaction({ ...transfer(4), transaction: undefined, description: "Objet de transaction" });
  assert.equal(makeTicket({ transfer: shaped, source: "push", arrivedAt: NOW }).description, "Objet de transaction");
  assert.equal(transferShapeOfTransaction(null), null);
});

// Intention: the payer comes from the notification, then the transfer, then the history.
test("ticket : payeur de la notification, sinon du transfert, sinon de l'historique", () => {
  const base = { source: "push", arrivedAt: NOW };
  const note = paymentNotification(5, { payer: "Payeur Notification" }).notification;
  const body = transfer(5, { payer: "Payeur Transfert" });
  const line = entry(5, { who: "Payeur Historique" });
  assert.equal(makeTicket({ ...base, notification: note, transfer: body, historyEntry: line }).payer, "Payeur Notification");
  assert.equal(makeTicket({ ...base, transfer: body, historyEntry: line }).payer, "Payeur Transfert");
  assert.equal(makeTicket({ ...base, historyEntry: line }).payer, "Payeur Historique 5");
  assert.equal(makeTicket({ ...base, notification: { ...note, relatedUser: {} }, historyEntry: line }).payer, "Payeur Historique 5");
});

// Intention: the date of the transfer (with its time zone) first, then the notification's.
test("ticket : date du transfert, sinon de la notification, sinon de l'historique", () => {
  const note = paymentNotification(6, { date: "2026-01-10T09:00:00.000+01:00" }).notification;
  const body = transfer(6, { date: "2026-01-10T09:00:05.000+01:00" });
  assert.equal(makeTicket({ notification: note, transfer: body, source: "push", arrivedAt: NOW }).date, "2026-01-10T09:00:05.000+01:00");
  assert.equal(makeTicket({ notification: note, source: "push", arrivedAt: NOW }).date, "2026-01-10T09:00:00.000+01:00");
  assert.equal(makeTicket({ historyEntry: entry(6), source: "history", arrivedAt: NOW }).date, entry(6).date);
  assert.equal(makeTicket({ notification: { date: "pas une date" }, source: "push", arrivedAt: NOW }).date, null);
});

// Intention: an unreadable amount (not an exact decimal, zero, negative, not a string) gives an INCOMPLETE ticket, never an invented number.
test("ticket : montant illisible, nul, négatif ou non textuel = ticket incomplet", () => {
  for (const bad of ["1,00", "abc", "1e3", "1.", ".5", " 1.00", "0.00", "-1.00", "NaN", "", 1, 1.5, true, {}]) {
    const t = pushTicket(7, { amount: bad });
    assert.equal(t.complete, false, JSON.stringify(bad));
    assert.equal(t.amount, null, JSON.stringify(bad));
    assert.equal(t.amountState, bad === undefined ? "pending" : "unreadable", JSON.stringify(bad));
  }
  for (const good of ["1", "1.00", "12.5", "1234567.89", "0.01"]) assert.equal(pushTicket(7, { amount: good }).amount, good);
});

// Intention: a notification alone gives an incomplete ticket "pending" (payer and time, amount being read); the history can bring the amount.
test("ticket : notification seule = incomplet 'en cours de lecture' ; l'historique donne le repli du montant", () => {
  const alone = makeTicket({ notification: paymentNotification(8).notification, entityId: "tr-8", source: "push", arrivedAt: NOW });
  assert.equal(alone.complete, false);
  assert.equal(alone.amountState, "pending");
  assert.equal(alone.transactionNumber, null);
  assert.ok(alone.date && alone.payer);
  const fromHistory = makeTicket({ historyEntry: entry(8, { amount: "3.50" }), source: "history", arrivedAt: NOW });
  assert.equal(fromHistory.complete, true);
  assert.equal(fromHistory.amount, "3.50");
  const unreadableTransfer = makeTicket({ transfer: transfer(8, { amount: "oups" }), historyEntry: entry(8, { amount: "3.50" }), source: "push", arrivedAt: NOW });
  assert.equal(unreadableTransfer.amount, "3.50", "the history amount replaces an unreadable transfer amount");
});

// Intention: currency of the transfer, else of the account, else " G" and 2 decimals.
test("ticket : devise du transfert, sinon du compte, sinon ' G' et 2 décimales", () => {
  const base = { historyEntry: entry(9), source: "history", arrivedAt: NOW };
  assert.deepEqual(pick(makeTicket({ ...base, transfer: { currency: { suffix: " €", decimalDigits: 0 } } })), [" €", 0]);
  assert.deepEqual(pick(makeTicket({ ...base, transfer: { currency: { symbol: "Gr" } } })), [" Gr", 2]);
  assert.deepEqual(pick(makeTicket({ ...base, fallbackCurrency: { suffix: " Gx", decimalDigits: 3 } })), [" Gx", 3]);
  assert.deepEqual(pick(makeTicket({ ...base })), [" G", 2]);
  assert.deepEqual(pick(makeTicket({ ...base, transfer: { currency: { decimalDigits: 99, suffix: 5 } } })), [" G", 2]);
});
const pick = (t) => [t.currencySuffix, t.decimals];

// Intention: texts coming from Cyclos are cut to a sane length, and only strings are taken.
test("ticket : textes bornés, valeurs non textuelles ignorées", () => {
  const t = makeTicket({ transfer: { ...transfer(10), transaction: { description: "d".repeat(1000) }, from: { user: { display: 42 } } }, source: "push", arrivedAt: NOW });
  assert.equal(t.description.length, 300);
  assert.equal(t.payer, "");
});

// ---- the display ----

const show = (ticket, now = NOW) => ticketDisplay(ticket, { now, formatAmount });

// Intention: comma as decimal separator, currency suffix, number of decimals of the currency, done on the string
// (a value that floating point cannot hold exactly stays exact).
test("affichage : virgule, suffixe de la devise, décimales, sans passer par un flottant", () => {
  assert.equal(show(pushTicket(1, { amount: "1.00" })).amount, "1,00 G");
  assert.equal(show(pushTicket(1, { amount: "12.5" })).amount, "12,50 G");
  assert.equal(show(pushTicket(1, { amount: "1234.5" })).amount, "1 234,50 G");
  assert.equal(show(pushTicket(1, { amount: "9007199254740993.01" })).amount, "9 007 199 254 740 993,01 G");
  assert.equal(show(pushTicket(1, { amount: "0.10" })).amount, "0,10 G");
  const noDecimals = makeTicket({ transfer: { ...transfer(1, { amount: "7" }), currency: { suffix: " Gr", decimalDigits: 0 } }, source: "push", arrivedAt: NOW });
  assert.equal(show(noDecimals).amount, "7 Gr");
  assert.equal(show(makeTicket({ notification: paymentNotification(1).notification, source: "push", arrivedAt: NOW })).amount, null);
});

// Intention: the time is the Paris wall-clock time (Luxon, never a fixed offset): "HH:mm" for today, "dd/MM HH:mm" otherwise.
test("affichage : heure de Paris, HH:mm le jour même, dd/MM HH:mm sinon", () => {
  const winter = pushTicket(1, { date: "2026-01-10T09:04:00.000+01:00" });
  assert.equal(show(winter, Date.parse("2026-01-10T20:00:00+01:00")).time, "09:04");
  assert.equal(show(winter, Date.parse("2026-01-11T08:00:00+01:00")).time, "10/01 09:04");
  // The same instant written in UTC is shown in Paris time.
  assert.equal(show(pushTicket(1, { date: "2026-07-14T10:00:00.000Z" }), Date.parse("2026-07-14T12:00:00Z")).time, "12:00");
  // Day change at midnight Paris time (23:30 UTC is already the next day in Paris in winter).
  assert.equal(show(pushTicket(1, { date: "2026-01-10T23:30:00.000Z" }), Date.parse("2026-01-11T07:00:00Z")).time, "00:30");
});

// Intention: around the clock changes the shown time follows Paris (summer time +02:00, winter time +01:00), no fixed offset.
test("affichage : heure de Paris autour des changements d'heure", () => {
  const at = (iso, now) => show(pushTicket(1, { date: iso }), Date.parse(now)).time;
  // Spring forward, 29 March 2026: 01:00 UTC = 03:00 in Paris (02:xx does not exist).
  assert.equal(at("2026-03-29T00:59:00Z", "2026-03-29T12:00:00Z"), "01:59");
  assert.equal(at("2026-03-29T01:00:00Z", "2026-03-29T12:00:00Z"), "03:00");
  // Fall back, 25 October 2026: 02:30 exists twice, 00:30 UTC (summer) and 01:30 UTC (winter).
  assert.equal(at("2026-10-25T00:30:00Z", "2026-10-25T12:00:00Z"), "02:30");
  assert.equal(at("2026-10-25T01:30:00Z", "2026-10-25T12:00:00Z"), "02:30");
  assert.equal(at("2026-10-25T00:59:59Z", "2026-10-25T12:00:00Z"), "02:59");
  assert.equal(at("2026-10-25T01:00:00Z", "2026-10-25T12:00:00Z"), "02:00");
  // Same text, different instants: the two 02:30 are one hour apart.
  const first = pushTicket(1, { date: "2026-10-25T00:30:00Z" });
  const second = pushTicket(2, { date: "2026-10-25T01:30:00Z" });
  const store = createTicketStore();
  store.add(first);
  store.add(second);
  assert.deepEqual(store.list().map((t) => t.transactionNumber), ["T00002", "T00001"]);
});

// Intention: a ticket without a usable date is shown at its arrival time.
test("affichage : sans date, l'heure d'arrivée", () => {
  const t = makeTicket({ historyEntry: { ...entry(1), date: "n'importe quoi" }, source: "history", arrivedAt: Date.parse("2026-01-10T08:15:00+01:00") });
  assert.equal(show(t, Date.parse("2026-01-10T20:00:00+01:00")).time, "08:15");
});

// ---- the "New" mark ----

// Intention: "New" = not loaded at opening AND arrived less than 60 seconds ago.
test("marque Nouveau : source différente de initial et arrivée il y a moins de 60 secondes", () => {
  const ticket = (source, arrivedAt) => ({ source, arrivedAt });
  assert.equal(isNew(ticket("push", NOW - 59_999), NOW), true);
  assert.equal(isNew(ticket("push", NOW - 60_000), NOW), false);
  assert.equal(isNew(ticket("history", NOW - 1000), NOW), true);
  assert.equal(isNew(ticket("initial", NOW - 1000), NOW), false);
  assert.equal(show(pushTicket(1, { arrivedAt: NOW - 1000 })).isNew, true);
});

// ---- the store: de-duplication ----

// Intention: one payment seen three ways (notification then transfer, the account status, the history, the history again)
// is ONE ticket, and nothing changes the second time.
test("magasin : un même paiement vu trois fois donne un seul ticket", () => {
  const store = createTicketStore();
  assert.equal(store.add(pushTicket(1)).action, "added");
  const fromHistory = makeTicket({ historyEntry: entry(1, { amount: "1.00" }), source: "history", arrivedAt: NOW + 2000 });
  assert.equal(store.add(fromHistory).action, "duplicate");
  assert.equal(store.add(fromHistory).action, "duplicate");
  assert.equal(store.add(pushTicket(1)).action, "duplicate");
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].source, "push", "the first ticket is kept as it was");
});

// Intention: the entity ids already handled are remembered, to skip the transfer call when a notification comes back.
test("magasin : entityId déjà traité mémorisé (pas de second appel)", () => {
  const store = createTicketStore();
  assert.equal(store.hasEntity("tr-1"), false);
  store.add(pushTicket(1));
  assert.equal(store.hasEntity("tr-1"), true);
  store.markEntity("tr-9");
  assert.equal(store.hasEntity("tr-9"), true);
  store.markEntity("a b/../c");
  assert.equal(store.hasEntity("a b/../c"), false);
  assert.equal(store.hasTransaction("T00001"), true);
  assert.equal(store.hasTransaction("T00002"), false);
});

// Intention: an incomplete ticket (notification alone) is REPLACED when the transfer is read, never doubled; it keeps its arrival
// time and source (so the "New" mark does not restart).
test("magasin : ticket incomplet remplacé par le transfert, jamais doublé", () => {
  const store = createTicketStore();
  const incomplete = makeTicket({ notification: paymentNotification(2).notification, entityId: "tr-2", source: "push", arrivedAt: NOW });
  assert.equal(store.add(incomplete).action, "added");
  assert.equal(store.add(incomplete).action, "duplicate", "the same notification again");
  assert.equal(store.list().length, 1);
  assert.equal(store.incomplete().length, 1);

  const full = pushTicket(2, { arrivedAt: NOW + 3000 });
  const result = store.add(full);
  assert.equal(result.action, "replaced");
  assert.equal(store.list().length, 1);
  assert.equal(store.incomplete().length, 0);
  assert.equal(store.list()[0].complete, true);
  assert.equal(store.list()[0].arrivedAt, NOW);
  assert.equal(store.list()[0].source, "push");
});

// Intention: the history completes an incomplete ticket found by entityId; without any entityId it is found by payer and time
// (one candidate only), and if two candidates could fit nothing is guessed.
test("magasin : ticket incomplet complété par l'historique (entityId, sinon payeur et heure, jamais au hasard)", () => {
  const store = createTicketStore();
  store.add(makeTicket({ notification: paymentNotification(3).notification, entityId: "tr-3", source: "push", arrivedAt: NOW }));
  // The history line has no entityId, same payer, date a second away.
  const line = entry(3, { amount: "2.00", who: "Payeur" });
  line.relatedAccount.user.display = "Payeur 3";
  line.date = new Date(Date.parse(paymentNotification(3).notification.date) + 1000).toISOString();
  assert.equal(store.add(makeTicket({ historyEntry: line, source: "history", arrivedAt: NOW + 1000 })).action, "replaced");
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].amount, "2.00");

  // Two incomplete tickets of the same payer at the same time: the history line fits both, so it is simply added.
  const ambiguous = createTicketStore();
  for (const id of ["tr-a", "tr-b"]) {
    ambiguous.add(makeTicket({ notification: paymentNotification(3).notification, entityId: id, source: "push", arrivedAt: NOW }));
  }
  assert.equal(ambiguous.add(makeTicket({ historyEntry: line, source: "history", arrivedAt: NOW })).action, "added");
  assert.equal(ambiguous.list().length, 3);

  // Different payer: not the same payment.
  const other = createTicketStore();
  other.add(makeTicket({ notification: paymentNotification(3, { payer: "Quelqu'un d'autre" }).notification, entityId: "tr-c", source: "push", arrivedAt: NOW }));
  assert.equal(other.add(makeTicket({ historyEntry: line, source: "history", arrivedAt: NOW })).action, "added");
});

// Intention: the payment is ALREADY here, complete, from the history; the notification whose transfer could not be read must not
// add an incomplete duplicate next to it. It only gives its entityId to the ticket that is there (one candidate only).
test("magasin : notification incomplète d'un paiement déjà connu par l'historique = pas de doublon", () => {
  const store = createTicketStore();
  const line = entry(3, { amount: "2.00" });
  line.relatedAccount.user.display = "Payeur 3";
  line.date = paymentNotification(3).notification.date;
  store.add(makeTicket({ historyEntry: line, source: "initial", arrivedAt: NOW }));
  const result = store.add(makeTicket({ notification: paymentNotification(3).notification, entityId: "tr-3", source: "push", arrivedAt: NOW + 2000 }));
  assert.equal(result.action, "duplicate");
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].entityId, "tr-3");
  assert.equal(store.list()[0].source, "initial", "an old payment does not become New");
  assert.equal(store.hasEntity("tr-3"), true);
  // The same notification again is known by its entityId now.
  assert.equal(store.add(makeTicket({ notification: paymentNotification(3).notification, entityId: "tr-3", source: "push", arrivedAt: NOW + 3000 })).action, "duplicate");
  // Another payer, or a date far away: a different payment, so an incomplete ticket is added.
  assert.equal(store.add(makeTicket({ notification: paymentNotification(3, { payer: "Quelqu'un d'autre" }).notification, entityId: "tr-4", source: "push", arrivedAt: NOW })).action, "added");
  assert.equal(store.add(makeTicket({ notification: paymentNotification(30).notification, entityId: "tr-5", source: "push", arrivedAt: NOW })).action, "added");
  assert.equal(store.list().length, 3);
});

// Intention: two different payments of the same amount, even close in time, stay two tickets.
test("magasin : deux paiements différents de même montant restent deux tickets", () => {
  const store = createTicketStore();
  store.add(pushTicket(1, { amount: "1.00", payer: "Payeur X", date: "2026-01-10T09:00:00.000+01:00" }));
  store.add(pushTicket(2, { amount: "1.00", payer: "Payeur X", date: "2026-01-10T09:00:01.000+01:00" }));
  assert.equal(store.list().length, 2);
  assert.deepEqual(store.list().map((t) => t.transactionNumber), ["T00002", "T00001"]);
});

// Intention: a ticket with a number but an unreadable amount is completed later by a draft that has a readable amount.
test("magasin : ticket au montant illisible complété plus tard par un brouillon lisible", () => {
  const store = createTicketStore();
  store.add(pushTicket(1, { amount: "illisible" }));
  assert.equal(store.incomplete().length, 1);
  assert.equal(store.add(makeTicket({ historyEntry: entry(1, { amount: "4.00" }), source: "history", arrivedAt: NOW })).action, "replaced");
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].amount, "4.00");
  assert.equal(store.incomplete().length, 0);
});

// ---- the store: order and bounds ----

// Intention: most recent payment date first; equal dates: most recent arrival first.
test("magasin : tri par date décroissante puis arrivée décroissante", () => {
  const store = createTicketStore();
  const same = "2026-01-10T09:00:00.000+01:00";
  store.add(pushTicket(1, { date: "2026-01-10T08:00:00.000+01:00", arrivedAt: NOW + 9000 }));
  store.add(pushTicket(2, { date: same, arrivedAt: NOW + 1000 }));
  store.add(pushTicket(3, { date: same, arrivedAt: NOW + 2000 }));
  store.add(pushTicket(4, { date: "2026-01-10T10:00:00.000+01:00", arrivedAt: NOW }));
  assert.deepEqual(store.list().map((t) => t.transactionNumber), ["T00004", "T00003", "T00002", "T00001"]);
});

// Intention: the list never holds more than `ticketsKept` tickets, the oldest go, and a payment that went is not brought back by the history.
test("magasin : liste bornée, les plus anciens sortent et ne reviennent pas par l'historique", () => {
  const store = createTicketStore({ ticketsKept: 3 });
  for (let n = 1; n <= 5; n += 1) store.add(pushTicket(n, { arrivedAt: NOW + n }));
  assert.deepEqual(store.list().map((t) => t.transactionNumber), ["T00005", "T00004", "T00003"]);
  assert.equal(store.size, 3);
  const old = makeTicket({ historyEntry: entry(1), source: "history", arrivedAt: NOW + 99 });
  assert.equal(store.add(old).action, "duplicate");
  assert.equal(store.size, 3);
});

// Intention: the remembered keys are bounded as well (the oldest are forgotten).
test("magasin : clés déjà vues bornées", () => {
  const store = createTicketStore({ ticketsKept: 500, seenKept: 5 });
  for (let n = 1; n <= 8; n += 1) store.add(pushTicket(n));
  assert.equal(store.hasTransaction("T00008"), true);
  assert.equal(store.hasTransaction("T00001"), false);
  assert.equal(store.hasEntity("tr-8"), true);
  assert.equal(store.hasEntity("tr-1"), false);
});

// Intention: stopping the listening forgets everything.
test("magasin : clear() vide tickets et clés vues", () => {
  const store = createTicketStore();
  store.add(pushTicket(1));
  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.hasTransaction("T00001"), false);
  assert.equal(store.hasEntity("tr-1"), false);
  assert.equal(store.add(pushTicket(1)).action, "added", "after a reopening the same payment comes back");
});

// ---- the state ----

// Intention: one state to show, the worst first; "fallback" only when the stream itself is fine.
test("magasin : état affiché (starting, live, fallback, reconnecting, degraded, error)", () => {
  const store = createTicketStore();
  assert.equal(store.status(), "starting");
  store.setConnection("live");
  assert.equal(store.status(), "live");
  store.setFallback(true);
  assert.equal(store.status(), "fallback");
  for (const state of ["reconnecting", "degraded", "error", "starting"]) {
    store.setConnection(state);
    assert.equal(store.status(), state, "a bad connection state wins over the fallback");
  }
  store.setFallback(false);
  store.setConnection("live");
  assert.equal(store.status(), "live");
});

// ---- type name, loaded flag, waiting for the listening ----

// Intention: the descriptions of the hidden list (CAISSE_HIDDEN_DESCRIPTIONS) are not shown, whatever the case, the accents or the extra
// spaces; a description written by the payer is kept; several values; an empty list hides nothing.
test("ticket : descriptions de la liste à masquer = masquées, texte écrit par le payeur = conservé", () => {
  const show = (description, hiddenDescriptions) =>
    ticketDisplay(makeTicket({ historyEntry: { ...entry(1), description }, source: "history", arrivedAt: NOW }), { now: NOW, formatAmount, hiddenDescriptions }).description;
  const hidden = ["Virement Mobile Pro"];
  assert.equal(show("Virement Mobile Pro", hidden), "");
  assert.equal(show("  virement   MOBILE pro  ", hidden), "", "case and extra spaces");
  assert.equal(show("Virement Mobile Pro", ["virément mobile PRO"]), "", "accents");
  assert.equal(show("Pain et fromage", hidden), "Pain et fromage");
  assert.equal(show("Virement Mobile Pro pour le pain", hidden), "Virement Mobile Pro pour le pain", "only an identical text");
  assert.equal(show("Paiement", ["Virement Mobile Pro", "Paiement", "Autre"]), "", "several values");
  assert.equal(show("Autre", ["Virement Mobile Pro", "Paiement", "Autre"]), "");
  assert.equal(show("Virement Mobile Pro", []), "Virement Mobile Pro", "empty list: nothing hidden");
  assert.equal(show("Virement Mobile Pro", undefined), "Virement Mobile Pro", "no list given: nothing hidden");
  // The transfer shape (description in transaction.description) is treated the same way.
  const viaTransfer = makeTicket({ transfer: transfer(1, { description: "Virement Mobile Pro" }), source: "push", arrivedAt: NOW });
  assert.equal(ticketDisplay(viaTransfer, { now: NOW, formatAmount, hiddenDescriptions: hidden }).description, "");
});

test("ticket : le nom du type de paiement n'est plus lu (type.name ne masque rien)", () => {
  const ticket = makeTicket({ historyEntry: { ...entry(1), description: "Achat", type: { name: "Achat" } }, source: "history", arrivedAt: NOW });
  assert.equal("typeName" in ticket, false);
  assert.equal(ticketDisplay(ticket, { now: NOW, formatAmount }).description, "Achat");
});

test("magasin : whenSettled attend la sortie de « starting » ; loaded se pose et se lit", async () => {
  const store = createTicketStore();
  assert.equal(store.loaded, false);
  let settled = false;
  const waiting = store.whenSettled().then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);
  store.setLoaded(true);
  assert.equal(store.loaded, true);
  store.setConnection("live");
  await waiting;
  assert.equal(settled, true);
  await store.whenSettled(); // already settled: resolves at once
});
