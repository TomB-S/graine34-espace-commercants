// What to notify and what to say (notification-logic.js): pure logic, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SEPARATE, canAskPermission, canNotify, createNotificationPlanner, notificationLabel, paymentBody, paymentTitle, planNotifications } from "../web/js/notification-logic.js";

const ticket = (n, extra = {}) => ({
  keys: [`k${n}`],
  initial: false,
  payer: `Payeur ${n}`,
  amount: `${n},50 G`,
  amountReady: true,
  description: "SECRET description",
  number: "T-SECRET-9",
  ...extra,
});
const state = (extra = {}) => ({ supported: true, secure: true, permission: "default", ...extra });

test("notifications : état par permission (déjà accordée = active tout de suite), jamais de bouton propre", () => {
  assert.deepEqual(notificationLabel(state()), { text: "Notifications désactivées : cliquer pour activer", active: false });
  assert.deepEqual(notificationLabel(state({ permission: "granted" })), { text: "Notifications activées", active: true });
  const denied = notificationLabel(state({ permission: "denied" }));
  assert.equal(denied.active, false);
  assert.match(denied.text, /^Notifications refusées\. Pour les réactiver : cliquer sur le cadenas/);
  assert.match(denied.text, /réglages de notifications du système/);
  assert.deepEqual(notificationLabel(state({ supported: false })), { text: "Notifications non disponibles sur ce navigateur", active: false });
  assert.match(notificationLabel(state({ secure: false })).text, /HTTPS/);
  assert.equal(notificationLabel(state({ secure: false, permission: "granted" })).active, false, "never 'activées' without HTTPS");
  for (const permission of ["default", "granted", "denied"]) assert.ok(!("buttonText" in notificationLabel(state({ permission }))));
});

test("notifications : la permission ne peut être demandée que si elle est encore à décider, en contexte sûr", () => {
  assert.equal(canAskPermission(state()), true);
  for (const bad of [{ permission: "granted" }, { permission: "denied" }, { supported: false }, { secure: false }]) {
    assert.equal(canAskPermission(state(bad)), false, JSON.stringify(bad));
  }
});

test("notifications : on ne notifie que si pris en charge, en contexte sûr et autorisé", () => {
  assert.equal(canNotify(state({ permission: "granted" })), true);
  for (const bad of [{ permission: "default" }, { permission: "denied" }, { supported: false, permission: "granted" }, { secure: false, permission: "granted" }]) {
    assert.equal(canNotify(state(bad)), false, JSON.stringify(bad));
  }
});

test("notification d'un paiement : titre « Paiement reçu : montant », corps « de payeur », tag = clé du paiement", () => {
  assert.deepEqual(planNotifications([ticket(1)]), [{ title: "Paiement reçu : 1,50 G", body: "de Payeur 1", tag: "k1" }]);
  assert.deepEqual(planNotifications([ticket(1, { payer: "Zorgan - Mélusine", amount: "1,00 G" })]), [
    { title: "Paiement reçu : 1,00 G", body: "de Zorgan - Mélusine", tag: "k1" },
  ]);
});

test("notification : jamais la description ni le numéro de transaction, quel que soit le nombre de paiements", () => {
  for (const count of [1, 2, 3, 4, 10]) {
    const plans = planNotifications(Array.from({ length: count }, (_, i) => ticket(i + 1)));
    const text = JSON.stringify(plans);
    assert.ok(!/SECRET|T-SECRET/.test(text), `${count} payments`);
  }
});

test("notification : « de Client » quand le serveur a masqué le payeur ; sans montant lu, le titre n'a pas de montant", () => {
  assert.equal(paymentBody(ticket(1, { payer: "Client" })), "de Client");
  assert.equal(paymentTitle(ticket(1, { payer: "Client" })), "Paiement reçu : 1,50 G");
  const unknown = ticket(1, { amount: "Montant en cours de lecture", amountReady: false });
  assert.equal(paymentTitle(unknown), "Paiement reçu");
  assert.equal(paymentBody(unknown), "de Payeur 1");
  assert.ok(!/Montant/.test(JSON.stringify(planNotifications([unknown]))));
});

test("notification : jusqu'à 3 paiements = une notification chacune (la plus récente en dernier, donc au-dessus), tags distincts", () => {
  const plans = planNotifications([ticket(3), ticket(2), ticket(1)]);
  assert.equal(plans.length, 3);
  assert.deepEqual(plans.map((p) => p.tag), ["k1", "k2", "k3"]);
  assert.deepEqual(plans.map((p) => p.title), ["Paiement reçu : 1,50 G", "Paiement reçu : 2,50 G", "Paiement reçu : 3,50 G"]);
  assert.equal(new Set(plans.map((p) => p.tag)).size, 3);
});

test("notification : plus de 3 paiements d'un coup = une seule « N nouveaux paiements », sans payeur ni montant", () => {
  assert.equal(MAX_SEPARATE, 3);
  const plans = planNotifications([ticket(5), ticket(4), ticket(3), ticket(2)]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].title, "4 nouveaux paiements");
  assert.equal(plans[0].body, "Ouvrir la caisse pour les voir", "short, no payer, no amount");
  assert.equal(plans[0].tag, "lot-k5");
  assert.ok(!/Payeur|G\b/.test(plans[0].body));
});

test("notification : rien à notifier = aucune notification ; tickets sans clé ignorés", () => {
  assert.deepEqual(planNotifications([]), []);
  assert.deepEqual(planNotifications(undefined), []);
  assert.deepEqual(planNotifications([{ payer: "x", amount: "1 G", amountReady: true }]), []);
});

// ---- the planner: waits for the amount ----

test("planificateur : un paiement dont le montant est connu part tout de suite", () => {
  const planner = createNotificationPlanner();
  const t = ticket(1);
  assert.deepEqual(planner.update([t], [t], 1000), [{ title: "Paiement reçu : 1,50 G", body: "de Payeur 1", tag: "k1" }]);
  assert.equal(planner.waiting, 0);
});

test("planificateur : montant pas encore lu = attend, puis part avec le montant dès qu'il est connu, une seule fois", () => {
  const planner = createNotificationPlanner();
  const pending = ticket(1, { amount: "Montant en cours de lecture", amountReady: false });
  assert.deepEqual(planner.update([pending], [pending], 1000), []);
  assert.equal(planner.waiting, 1);
  assert.deepEqual(planner.update([], [pending], 4000), [], "still unknown");
  const complete = ticket(1, { keys: ["k1", "k9"] });
  assert.deepEqual(planner.update([], [complete], 7000), [{ title: "Paiement reçu : 1,50 G", body: "de Payeur 1", tag: "k1" }]);
  assert.deepEqual(planner.update([], [complete], 10_000), [], "never twice");
  assert.equal(planner.waiting, 0);
});

test("planificateur : un montant qui ne vient pas = notification après 15 s, telle quelle", () => {
  const planner = createNotificationPlanner();
  const pending = ticket(1, { amount: "Montant en cours de lecture", amountReady: false });
  planner.update([pending], [pending], 0);
  assert.deepEqual(planner.update([], [pending], 14_999), []);
  assert.deepEqual(planner.update([], [pending], 15_000), [{ title: "Paiement reçu", body: "de Payeur 1", tag: "k1" }]);
});

test("planificateur : un lot de 4 dont un sans montant = tenu ensemble, puis UNE seule notification « 4 nouveaux paiements »", () => {
  const planner = createNotificationPlanner();
  const tickets = [1, 2, 3, 4].map((n) => ticket(n, n === 2 ? { amount: "Montant en cours de lecture", amountReady: false } : {})).reverse();
  assert.deepEqual(planner.update(tickets, tickets, 0), [], "nothing goes out alone");
  assert.equal(planner.waiting, 4);
  const done = tickets.map((t) => (t.keys[0] === "k2" ? ticket(2) : t));
  const plans = planner.update([], done, 3000);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].title, "4 nouveaux paiements");
  assert.equal(planner.waiting, 0);
});

test("planificateur : deux lectures successives = deux lots séparés", () => {
  const planner = createNotificationPlanner();
  const a = ticket(1);
  const b = ticket(2);
  assert.equal(planner.update([a], [a], 0).length, 1);
  assert.deepEqual(planner.update([b], [b, a], 3000).map((p) => p.tag), ["k2"]);
});

test("planificateur : rien de nouveau = rien", () => {
  const planner = createNotificationPlanner();
  assert.deepEqual(planner.update([], [ticket(1)], 0), []);
});
