// === WHAT THIS FILE CHECKS ===
// Which account of a merchant who has several is read, by the statement (/espace/releve) and by the cash register: the first account
// of GET /self/accounts whose type is in PREFERRED_ACCOUNT_TYPES ("MonComptePro", then "monCompte"), otherwise the first of the list,
// whatever the order Cyclos answers in. In the cash register, CAISSE_ACCOUNT_TYPE still wins when it is set. The fake Cyclos gives
// each account type its OWN transactions, so that the numbers read prove which account was really read. All values are fictitious.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { appTest } from "./support/harness.js";
import { startFakeCyclos, USER, entry } from "./support/fake-cyclos.js";
import { createCyclosPush, PREFERRED_ACCOUNT_TYPES } from "../src/cyclos-push.js";
import { readCaisseConfig } from "../src/caisse-config.js";
import { createTicketStore } from "../src/ticket-store.js";
import { createPaymentProcessor } from "../src/payment-processor.js";
import { options, connected, RANGE, on, numbersOf } from "./support/releve-support.js";

const CURRENCY = { name: "Graines", decimalDigits: 2 };
const account = (internalName) => ({ type: { internalName }, currency: CURRENCY });
const list = (...names) => names.map(account);

// Numbers of transactions that tell the accounts apart: T00001 for the bonus account, T00002 for monCompte, T00003 for MonComptePro.
const BY_ACCOUNT = { compteurBonus: 1, monCompte: 2, MonComptePro: 3 };
const entriesPerAccount = (maker) => Object.fromEntries(Object.entries(BY_ACCOUNT).map(([type, n]) => [type, [maker(n)]]));
const numberOf = (n) => `T${String(n).padStart(5, "0")}`;

const FROM = DateTime.now().setZone("Europe/Paris").startOf("day").minus({ days: 1 });
const UNTIL = DateTime.now().setZone("Europe/Paris").endOf("day").plus({ days: 1 });

async function withPush(accountsBody, fn) {
  const cyclos = await startFakeCyclos();
  Object.assign(cyclos.state, { accountsBody, accountEntries: entriesPerAccount((n) => entry(n)) });
  const push = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  try {
    const token = await push.createSession(USER.login, USER.password);
    await fn({ cyclos, push, token });
  } finally {
    await cyclos.close();
  }
}

// ------------------------------------------------------------------------------ the rule, in getAccount

test("compte recevant : la liste d'ordre de préférence est MonComptePro puis monCompte", () => {
  assert.deepEqual(PREFERRED_ACCOUNT_TYPES, ["MonComptePro", "monCompte"]);
});

// Intention: [compteurBonus, monCompte] -> monCompte, even though compteurBonus comes first.
test("compte recevant : liste [compteurBonus, monCompte] -> monCompte", () =>
  withPush(list("compteurBonus", "monCompte"), async ({ push, token }) => {
    assert.deepEqual(await push.getAccount(token), { accountType: "monCompte", currency: CURRENCY });
  }));

// Intention: [monCompte, MonComptePro] -> MonComptePro: the first name of the preference list wins over a later one in the list.
test("compte recevant : liste [monCompte, MonComptePro] -> MonComptePro", () =>
  withPush(list("monCompte", "MonComptePro"), async ({ push, token }) => {
    assert.equal((await push.getAccount(token)).accountType, "MonComptePro");
  }));

test("compte recevant : l'ordre de la liste de Cyclos ne change rien", () =>
  withPush(list("compteurBonus", "MonComptePro", "monCompte"), async ({ push, token }) => {
    assert.equal((await push.getAccount(token)).accountType, "MonComptePro");
  }));

// Intention: none of the preferred types is there -> the first account of the list (the behavior before this rule).
test("compte recevant : [compteurBonus] seul -> compteurBonus (repli sur le premier)", () =>
  withPush(list("compteurBonus"), async ({ push, token }) => {
    assert.equal((await push.getAccount(token)).accountType, "compteurBonus");
  }));

test("compte recevant : aucun type préféré dans la liste -> le premier", () =>
  withPush(list("compteurBonus", "autre"), async ({ push, token }) => {
    assert.equal((await push.getAccount(token)).accountType, "compteurBonus");
  }));

// Intention: empty list -> null (the statement then says "accès aux comptes refusé"), as before.
test("compte recevant : liste vide -> null, comme avant", () =>
  withPush([], async ({ push, token }) => {
    assert.equal(await push.getAccount(token), null);
  }));

// Intention: the regex of the account types is still applied to the value that was chosen, a preferred name or not.
test("compte recevant : la regex des types de compte s'applique au compte retenu", () =>
  withPush([{ type: { internalName: "../secret" } }, account("monCompte")], async ({ push, token }) => {
    assert.equal((await push.getAccount(token)).accountType, "monCompte", "le compte préféré est valide, il passe");
  }).then(() =>
    withPush([{ type: { internalName: "../secret" } }, account("autre")], async ({ push, token }) => {
      assert.equal(await push.getAccount(token), null, "le premier est retenu et sa valeur est refusée");
    }),
  ));

// ------------------------------------------------------------------------------ the statement, with the client

// Intention: totals and history are asked of the chosen account, and the lines come from that account only.
test("compte recevant : getStatement lit le compte retenu (totaux et historique)", () =>
  withPush(list("compteurBonus", "monCompte"), async ({ cyclos, push, token }) => {
    const statement = await push.getStatement(token, { from: FROM.toUTC().toISO(), until: UNTIL.toUTC().toISO(), pageSize: 200, maxRows: 2000 });
    assert.deepEqual(statement.entries.map((e) => e.transactionNumber), [numberOf(BY_ACCOUNT.monCompte)]);
    assert.equal(cyclos.calls("GET", "/self/accounts/monCompte").length, 1);
    assert.equal(cyclos.calls("GET", "/self/accounts/monCompte/history").length, 1);
    assert.equal(cyclos.calls("GET", "/self/accounts/compteurBonus").length, 0);
    assert.equal(cyclos.calls("GET", "/self/accounts/compteurBonus/history").length, 0);
  }));

// ------------------------------------------------------------------------------ the statement, on the server

// Intention: the page of the statement is made from the account that receives the payments, not the first one of the list.
appTest("compte recevant : le relevé affiche et appelle le compte retenu", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  app.cyclos.state.accountsBody = list("compteurBonus", "monCompte");
  app.cyclos.state.accountEntries = entriesPerAccount((n) => on(n));
  const res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 200);
  assert.deepEqual(numbersOf(await res.text()), [numberOf(BY_ACCOUNT.monCompte)]);
  assert.equal(app.cyclos.calls("GET", "/self/accounts/monCompte").length, 1);
  assert.equal(app.cyclos.calls("GET", "/self/accounts/monCompte/history").length, 1);
  assert.equal(app.cyclos.calls("GET", "/self/accounts/compteurBonus").length, 0);
  assert.equal(app.cyclos.calls("GET", "/self/accounts/compteurBonus/history").length, 0);
});

appTest("compte recevant : relevé avec [monCompte, MonComptePro] -> MonComptePro", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  app.cyclos.state.accountsBody = list("monCompte", "MonComptePro");
  app.cyclos.state.accountEntries = entriesPerAccount((n) => on(n));
  const res = await b.ticket({ csrf, ...RANGE });
  assert.deepEqual(numbersOf(await res.text()), [numberOf(BY_ACCOUNT.MonComptePro)]);
  assert.equal(app.cyclos.calls("GET", "/self/accounts/MonComptePro/history").length, 1);
  assert.equal(app.cyclos.calls("GET", "/self/accounts/monCompte/history").length, 0);
});

appTest("compte recevant : relevé avec [compteurBonus] seul -> compteurBonus", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  app.cyclos.state.accountsBody = list("compteurBonus");
  app.cyclos.state.accountEntries = entriesPerAccount((n) => on(n));
  const res = await b.ticket({ csrf, ...RANGE });
  assert.deepEqual(numbersOf(await res.text()), [numberOf(BY_ACCOUNT.compteurBonus)]);
});

// ------------------------------------------------------------------------------ the cash register

async function waitFor(condition, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé : ${what}`);
}

// A processor on its own (no stream needed): the initial load is `prepare`, the safety net is `reconcile`.
async function withProcessor(env, fn) {
  const cyclos = await startFakeCyclos();
  Object.assign(cyclos.state, { accountsBody: list("compteurBonus", "monCompte"), accountEntries: entriesPerAccount((n) => entry(n)) });
  const push = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  const config = readCaisseConfig(env, { enabled: true, login: USER.login, password: USER.password, historyInitial: 10, safetyPollSeconds: 3600 });
  const store = createTicketStore();
  const log = { info: () => {}, error: () => {} };
  const processor = createPaymentProcessor({ config, push, store, log, debounceMs: 20 });
  const token = await push.createSession(USER.login, USER.password);
  const ctx = { token: () => token, isReopening: () => false, authLost: () => {} };
  try {
    await fn({ cyclos, processor, store, ctx });
  } finally {
    processor.stop();
    await cyclos.close();
  }
}
const readTypes = (cyclos) => new Set(cyclos.state.requests.filter((r) => /\/history$/.test(r.path)).map((r) => r.path));

// Intention: the first load and the safety net both read the account that receives the payments (monCompte), never compteurBonus.
test("compte recevant : la caisse lit le compte retenu au chargement initial et au filet de sécurité", () =>
  withProcessor({}, async ({ cyclos, processor, store, ctx }) => {
    await processor.prepare(ctx);
    assert.deepEqual(store.list().map((t) => t.transactionNumber), [numberOf(BY_ACCOUNT.monCompte)]);
    assert.deepEqual([...readTypes(cyclos)], ["/self/accounts/monCompte/history"]);

    // Safety net: a new payment on monCompte is found, a new one on compteurBonus is not.
    cyclos.state.accountEntries.monCompte = [entry(5), ...cyclos.state.accountEntries.monCompte];
    cyclos.state.accountEntries.compteurBonus = [entry(6)];
    const before = cyclos.calls("GET", "/self/accounts/monCompte/history").length;
    await processor.reconcile();
    await waitFor(() => store.size === 2, "le paiement du compte retenu");
    assert.ok(cyclos.calls("GET", "/self/accounts/monCompte/history").length > before);
    assert.deepEqual(store.list().map((t) => t.transactionNumber).sort(), [numberOf(2), numberOf(5)]);
    assert.deepEqual([...readTypes(cyclos)], ["/self/accounts/monCompte/history"], "compteurBonus n'est jamais lu");
  }));

// Intention: CAISSE_ACCOUNT_TYPE, when set, keeps priority over the rule.
test("compte recevant : CAISSE_ACCOUNT_TYPE réglé garde la priorité sur la règle", () =>
  withProcessor({ CAISSE_ACCOUNT_TYPE: "compteurBonus" }, async ({ cyclos, processor, store, ctx }) => {
    await processor.prepare(ctx);
    assert.deepEqual(store.list().map((t) => t.transactionNumber), [numberOf(BY_ACCOUNT.compteurBonus)]);
    await processor.reconcile();
    assert.deepEqual([...readTypes(cyclos)], ["/self/accounts/compteurBonus/history"], "monCompte n'est jamais lu");
  }));
