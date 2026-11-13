// === WHAT THIS FILE CHECKS ===
// What the listener does with the events (payment-processor.js), with the real loop and the fake Cyclos: a payment notification
// becomes a ticket (one transfer call), the same payment seen by notification, account status and history gives ONE ticket,
// other notifications are ignored, an unknown entityType calls no route but reads the history, an outgoing payment creates nothing,
// a burst of account statuses gives one history read, an unreadable transfer gives an incomplete ticket completed by the history
// (3 more tries at most), the notification setting is only READ, the safety net never runs twice at once, and the log holds no
// payer, amount, description, identifier or token. All values are fictitious. Basic notions: test/statique.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeCyclos, USER, entry, transfer, paymentNotification } from "../test-support/fake-cyclos.js";
import { readCaisseConfig } from "../caisse-config.js";
import { createCyclosPush } from "../cyclos-push.js";
import { createTicketStore, isNew } from "../ticket-store.js";
import { createListener } from "../cyclos-listener.js";
import { createPaymentProcessor } from "../payment-processor.js";

async function waitFor(condition, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé : ${what}`);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Everything assembled: fake Cyclos, client, store, processor, listener (started by `run`). Stopped at the end.
async function withCaisse(options, fn) {
  const { config = {}, setup, pushWrap, processorOptions = {}, sleep } = options;
  const cyclos = await startFakeCyclos();
  cyclos.state.push.lifetimeMs = null; // the stream stays open: the tests push their events
  setup?.(cyclos);
  const rawPush = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  const push = pushWrap ? pushWrap(rawPush) : rawPush;
  const store = createTicketStore();
  const logs = { info: [], error: [] };
  const log = { info: (m) => logs.info.push(m), error: (m) => logs.error.push(m) };
  const conf = readCaisseConfig({}, {
    enabled: true,
    login: USER.login,
    password: USER.password,
    streamWatchdogSeconds: 60,
    reconnectMaxSeconds: 30,
    reauthMax: 3,
    safetyPollSeconds: 3600,
    historyInitial: 10,
    ...config,
  });
  const processor = createPaymentProcessor({ config: conf, push, store, log, debounceMs: 50, retryDelaysMs: [30, 30, 30], ...processorOptions });
  const listener = createListener({ merchantKey: "prototype", config: conf, push, store, log, processor, sleep, shortStreamMs: 0 });
  const live = async () => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1 && store.status() !== "starting", "flux ouvert");
  };
  try {
    await fn({ cyclos, listener, store, logs, processor, live });
  } finally {
    await listener.stop();
    await cyclos.close();
  }
}

const historyCalls = (cyclos) => cyclos.calls("GET", "/self/accounts/membre/history");
const transferCalls = (cyclos) => cyclos.state.requests.filter((r) => r.path.startsWith("/transfers/"));
const transactionCalls = (cyclos) => cyclos.state.requests.filter((r) => r.path.startsWith("/transactions/"));

// The log may hold counts, kinds and statuses, never what Cyclos sent nor a secret.
function assertNoSensitive(logs, cyclos, extra = []) {
  const text = JSON.stringify(logs);
  const secrets = [USER.password, USER.login, ...cyclos.state.tokens, "Payeur", "Objet", "tr-", "T0000", "1.00", "2.00", "Sujet de test", "Message de test", ...extra];
  for (const secret of secrets) assert.ok(!text.includes(secret), `le journal contient "${secret}"`);
}

// Intention: a payment notification gives ONE transfer call and a complete ticket (payer from the notification, description from
// transaction.description, amount still a string), with Channel and Session-Token on the call, and nothing sensitive in the log.
test("processeur : notification de paiement = un appel de transfert et un ticket complet", () =>
  withCaisse({}, async ({ cyclos, store, logs, live }) => {
    cyclos.state.transfers.set("tr-1", transfer(1, { amount: "1.00", description: "Objet fictif" }));
    await live();
    cyclos.push("newNotification", paymentNotification(1));
    await waitFor(() => store.size === 1, "un ticket");
    const [ticket] = store.list();
    assert.equal(ticket.complete, true);
    assert.equal(ticket.amount, "1.00");
    assert.equal(ticket.payer, "Payeur 1");
    assert.equal(ticket.description, "Objet fictif");
    assert.equal(ticket.transactionNumber, "T00001");
    assert.equal(ticket.source, "push");
    assert.equal(isNew(ticket, Date.now()), true);
    assert.equal(transferCalls(cyclos).length, 1);
    assert.equal(transferCalls(cyclos)[0].path, "/transfers/tr-1");
    assert.equal(transferCalls(cyclos)[0].headers.channel, "main");
    assert.ok(transferCalls(cyclos)[0].headers["session-token"]);
    assert.equal(transactionCalls(cyclos).length, 0);
    assert.deepEqual(logs.error, []);
    assertNoSensitive(logs, cyclos);
  }));

// Intention: the same payment seen by notification, then account status (history), then the notification again, is ONE ticket
// and ONE transfer call (the entityId already handled is not read again).
test("processeur : même paiement par notification, accountStatus et historique = un seul ticket, un seul appel", () =>
  withCaisse({}, async ({ cyclos, store, live }) => {
    cyclos.state.transfers.set("tr-1", transfer(1, { amount: "1.00" }));
    await live();
    cyclos.state.entries = [entry(1, { amount: "1.00" })];
    cyclos.push("newNotification", paymentNotification(1));
    await waitFor(() => store.size === 1, "un ticket");
    const before = historyCalls(cyclos).length;
    cyclos.push("accountStatus", { solde: "x" });
    await waitFor(() => historyCalls(cyclos).length > before, "lecture de l'historique");
    cyclos.push("newNotification", paymentNotification(1));
    await pause(250);
    assert.equal(store.size, 1);
    assert.equal(store.list()[0].source, "push");
    assert.equal(transferCalls(cyclos).length, 1);
  }));

// Intention: other notifications, and refunds (paymentReceivedChargedBack), are ignored: no ticket, no call.
test("processeur : autres notifications et remboursements ignorés", () =>
  withCaisse({}, async ({ cyclos, store, processor, live }) => {
    await live();
    cyclos.push("newNotification", paymentNotification(1, { type: "paymentReceivedChargedBack" }));
    cyclos.push("newNotification", paymentNotification(2, { type: "autreType" }));
    cyclos.push("newNotification", { newNotifications: 3 });
    await waitFor(() => processor.stats.ignored === 3, "trois ignorées");
    assert.equal(store.size, 0);
    assert.equal(transferCalls(cyclos).length + transactionCalls(cyclos).length, 0);
  }));

// Intention: an unknown entityType (or a missing entityId) calls NO transfer or transaction route; the type is logged and the
// history is read, which is how the payment is found.
test("processeur : entityType inconnu = aucun appel de détail, type journalisé, historique lu", () =>
  withCaisse({}, async ({ cyclos, store, logs, live }) => {
    await live();
    cyclos.state.entries = [entry(1, { amount: "3.00" })];
    const before = historyCalls(cyclos).length;
    cyclos.push("newNotification", paymentNotification(1, { entityType: "etrangeType" }));
    await waitFor(() => store.size === 1, "ticket par l'historique");
    assert.equal(historyCalls(cyclos).length, before + 1);
    assert.equal(transferCalls(cyclos).length + transactionCalls(cyclos).length, 0);
    assert.ok(logs.info.some((line) => line.includes("(etrangeType)")));
    assert.equal(store.list()[0].source, "history");
    cyclos.push("newNotification", { notification: { type: "paymentReceived", entityType: "transfer" } });
    await waitFor(() => logs.info.filter((l) => l.includes("inattendu")).length === 2, "entityId absent");
    assert.equal(transferCalls(cyclos).length, 0);
    assertNoSensitive(logs, cyclos);
  }));

// Intention: an entityType "transaction" reads /transactions/{id} (never /transfers), and the description at its root is used.
test("processeur : entityType transaction = appel de /transactions, jamais de /transfers", () =>
  withCaisse({}, async ({ cyclos, store, live }) => {
    cyclos.state.transactions.set("tx-1", { ...transfer(1, { amount: "5.00" }), transaction: undefined, description: "Objet de transaction" });
    await live();
    cyclos.push("newNotification", paymentNotification(1, { entityType: "transaction", entityId: "tx-1" }));
    await waitFor(() => store.size === 1, "un ticket");
    assert.equal(store.list()[0].description, "Objet de transaction");
    assert.equal(store.list()[0].amount, "5.00");
    assert.equal(transactionCalls(cyclos).length, 1);
    assert.equal(transferCalls(cyclos).length, 0);
  }));

// Intention: account status for an OUTGOING payment: the history is read, finds no new credit, creates no ticket.
test("processeur : accountStatus d'une sortie = historique lu, aucun ticket", () =>
  withCaisse({}, async ({ cyclos, store, live }) => {
    await live();
    cyclos.state.entries = [entry(1, { amount: "-5.00" })];
    const before = historyCalls(cyclos).length;
    cyclos.push("accountStatus", { solde: "x" });
    await waitFor(() => historyCalls(cyclos).length === before + 1, "historique lu");
    await pause(150);
    assert.equal(store.size, 0);
  }));

// Intention: a burst of three account statuses in the same second gives ONE history read, not three.
test("processeur : rafale de trois accountStatus = un seul reconcile", () =>
  withCaisse({}, async ({ cyclos, live }) => {
    await live();
    const before = historyCalls(cyclos).length;
    for (let i = 0; i < 3; i += 1) cyclos.push("accountStatus", { n: i });
    await waitFor(() => historyCalls(cyclos).length > before, "un reconcile");
    await pause(300);
    assert.equal(historyCalls(cyclos).length, before + 1);
  }));

// Intention: the transfer cannot be read (404): an INCOMPLETE ticket is made from the notification (payer and time, amount "being
// read"), and the history completes it. The ticket is replaced, never doubled, and the transfer was asked once.
test("processeur : transfert en 404 = ticket incomplet, complété par l'historique, jamais doublé", () =>
  withCaisse({}, async ({ cyclos, store, logs, live }) => {
    await live();
    cyclos.state.entries = [entry(1, { amount: "2.00", who: "Payeur" })];
    const note = paymentNotification(1);
    cyclos.push("newNotification", note);
    await waitFor(() => store.size >= 1, "un ticket incomplet ou complet");
    await waitFor(() => store.list().length === 1 && store.list()[0].complete, "ticket complété par l'historique");
    assert.equal(store.list()[0].amount, "2.00");
    assert.equal(store.list()[0].transactionNumber, "T00001");
    assert.equal(store.list()[0].source, "push", "it keeps its arrival as a notification");
    assert.equal(transferCalls(cyclos).length, 1);
    assert.ok(logs.error.some((line) => /lecture du détail impossible \(transfer\) : PushUnavailableError \(404 on getTransfer\)/.test(line)));
    assertNoSensitive(logs, cyclos);
  }));

// Intention: the incomplete ticket first shows what the notification knows (payer, time, no amount).
test("processeur : ticket incomplet visible avec le payeur et sans montant tant que l'historique ne l'a pas", () =>
  withCaisse({}, async ({ cyclos, store, live }) => {
    await live();
    cyclos.push("newNotification", paymentNotification(1));
    await waitFor(() => store.size === 1, "un ticket");
    const [ticket] = store.list();
    assert.equal(ticket.complete, false);
    assert.equal(ticket.amount, null);
    assert.equal(ticket.amountState, "pending");
    assert.equal(ticket.payer, "Payeur 1");
    assert.equal(ticket.transactionNumber, null);
  }));

// Intention: if the history never has the payment, the incomplete ticket gets at most 3 more tries (4 history reads in all
// after the opening), then it is left alone; the periodic safety net is the only one that goes on.
test("processeur : ticket incomplet jamais complété = trois relances au plus", () =>
  withCaisse({}, async ({ cyclos, store, live }) => {
    await live();
    const before = historyCalls(cyclos).length;
    cyclos.push("newNotification", paymentNotification(1));
    await waitFor(() => historyCalls(cyclos).length >= before + 4, "quatre lectures");
    await pause(400);
    assert.equal(historyCalls(cyclos).length, before + 4, "1 trigger + 3 retries");
    assert.equal(store.incomplete().length, 1);
  }));

// Intention: the payment notification is OFF at Cyclos: state "fallback", a warning in the log, and the setting is only READ
// (no call changes anything at Cyclos); a payment is still shown, through account status and the history.
test("processeur : réglage paymentReceived désactivé = mode de secours, lecture seule, le paiement apparaît quand même", () =>
  withCaisse({ setup: (c) => (c.state.notificationSettings = { paymentReceived: { internal: false, email: true, app: true } }) }, async ({ cyclos, store, logs, live }) => {
    await live();
    assert.equal(store.status(), "fallback");
    assert.ok(logs.info.some((line) => line.includes("mode de secours")));
    cyclos.state.entries = [entry(1, { amount: "4.00" })];
    cyclos.push("accountStatus", { solde: "x" });
    await waitFor(() => store.size === 1, "ticket par l'historique");
    assert.equal(store.list()[0].source, "history");
    assert.equal(isNew(store.list()[0], Date.now()), true, "found while listening: New");
    assert.equal(store.status(), "fallback");
    const writes = cyclos.state.requests.filter((r) => r.method !== "GET" && r.path !== "/auth/session");
    assert.deepEqual(writes, [], "nothing is modified at Cyclos");
    assert.deepEqual(cyclos.state.requests.filter((r) => r.method === "POST").map((r) => r.path), ["/auth/session"]);
  }));

test("processeur : réglage illisible ou introuvable = mode de secours aussi", () =>
  withCaisse({ setup: (c) => (c.state.notificationSettings = { autre: 1 }) }, async ({ store, live }) => {
    await live();
    assert.equal(store.status(), "fallback");
  }));

// Intention: at opening, the latest payments are loaded from the history (not more than historyInitial), marked "initial":
// never "New", most recent first; then the state is "live".
test("processeur : chargement initial borné, tickets initial jamais Nouveau", () =>
  withCaisse({ setup: (c) => (c.state.entries = Array.from({ length: 12 }, (_, i) => entry(12 - i, { amount: "1.00" }))) }, async ({ cyclos, store, live }) => {
    await live();
    assert.equal(store.status(), "live");
    assert.equal(store.size, 10);
    assert.ok(store.list().every((t) => t.source === "initial" && !isNew(t, Date.now())));
    assert.deepEqual(store.list().slice(0, 2).map((t) => t.transactionNumber), ["T00012", "T00011"]);
    const query = historyCalls(cyclos)[0].query;
    assert.equal(query.get("pageSize"), "10");
    assert.equal(query.get("direction"), "credit");
    assert.equal(query.get("skipTotalCount"), "true");
  }));

// Intention: the history of the opening and the later notification of the same payment give ONE ticket.
test("processeur : paiement déjà chargé à l'ouverture puis notifié = un seul ticket, pas de Nouveau", () =>
  withCaisse({ setup: (c) => (c.state.entries = [entry(1, { amount: "1.00" })]) }, async ({ cyclos, store, live }) => {
    cyclos.state.transfers.set("tr-1", transfer(1, { amount: "1.00" }));
    await live();
    assert.equal(store.size, 1);
    cyclos.push("newNotification", paymentNotification(1));
    await waitFor(() => transferCalls(cyclos).length === 1, "appel du transfert");
    await pause(100);
    assert.equal(store.size, 1);
    assert.equal(store.list()[0].source, "initial");
  }));

// Intention: the same, but the transfer cannot be read: the notification must not add an incomplete duplicate.
test("processeur : paiement déjà chargé, notifié, transfert illisible = toujours un seul ticket", () =>
  withCaisse({ setup: (c) => (c.state.entries = [Object.assign(entry(1, { amount: "1.00", who: "Payeur" }), { date: paymentNotification(1).notification.date })]) }, async ({ cyclos, store, live }) => {
    await live();
    cyclos.push("newNotification", paymentNotification(1));
    await waitFor(() => transferCalls(cyclos).length === 1, "appel du transfert");
    await pause(300);
    assert.equal(store.size, 1);
    assert.equal(store.incomplete().length, 0);
  }));

// Intention: after a new login (token expired), the safety net reads the history and brings back the payment made meanwhile.
test("processeur : après une ré-authentification, le filet rattrape le paiement manqué", () =>
  withCaisse({ setup: (c) => (c.state.push.lifetimeMs = 100) }, async ({ cyclos, store, listener, live }) => {
    await live();
    assert.equal(store.size, 0);
    cyclos.state.entries = [entry(1, { amount: "6.00" })]; // paid while nobody could hear
    cyclos.expireTokens();
    await waitFor(() => cyclos.calls("POST", "/auth/session").length === 2, "nouvelle connexion");
    await waitFor(() => store.size === 1, "paiement rattrapé");
    assert.equal(store.list()[0].amount, "6.00");
    assert.equal(store.list()[0].source, "history");
    assert.ok(listener.running);
  }));

// Intention: a 401 on the transfer call (token refused) is not an error of the ticket: the listener logs in again and the
// safety net finds the payment in the history.
test("processeur : 401 sur le transfert = nouvelle connexion, puis le filet trouve le paiement", () =>
  withCaisse({}, async ({ cyclos, store, live }) => {
    await live();
    cyclos.state.entries = [entry(1, { amount: "7.00" })];
    cyclos.force("GET /transfers/tr-1", 401);
    cyclos.push("newNotification", paymentNotification(1));
    await waitFor(() => cyclos.calls("POST", "/auth/session").length === 2, "nouvelle connexion");
    await waitFor(() => store.size === 1, "paiement rattrapé");
    assert.equal(store.list()[0].amount, "7.00");
  }));

// Intention: the history failing (500) is logged and the listening goes on; the next trigger works.
test("processeur : lecture de l'historique en échec = journal, l'écoute continue, nouvel essai au déclencheur suivant", () =>
  withCaisse({}, async ({ cyclos, store, logs, live }) => {
    await live();
    cyclos.state.entries = [entry(1, { amount: "8.00" })];
    cyclos.force("GET /self/accounts/membre/history", 500);
    cyclos.push("accountStatus", { n: 1 });
    await waitFor(() => logs.error.some((l) => /lecture de l'historique en échec : PushUnavailableError \(500 on getRecentCredits\)/.test(l)), "erreur journalisée");
    assert.equal(store.size, 0);
    assert.equal(cyclos.openStreams(), 1);
    cyclos.state.forced.clear();
    cyclos.push("accountStatus", { n: 2 });
    await waitFor(() => store.size === 1, "paiement après le nouvel essai");
  }));

// Intention: the first load failing is retried by the next trigger, and what it finds is still marked "initial" (not New).
test("processeur : chargement initial en échec, repris plus tard, toujours marqué initial", () =>
  withCaisse({ setup: (c) => { c.state.entries = [entry(1, { amount: "9.00" })]; c.force("GET /self/accounts/membre/history", 503); } }, async ({ cyclos, store, logs, live }) => {
    await live();
    assert.equal(store.size, 0);
    assert.ok(logs.error.some((l) => /chargement initial impossible/.test(l)));
    cyclos.state.forced.clear();
    cyclos.push("accountStatus", { n: 1 });
    await waitFor(() => store.size === 1, "tickets chargés");
    assert.equal(store.list()[0].source, "initial");
  }));

// Intention: debits that a server would not filter out never become tickets.
test("processeur : les débits de l'historique ne deviennent jamais des tickets", () =>
  withCaisse(
    {
      setup: (c) => (c.state.entries = [entry(2, { amount: "-3.00" }), entry(1, { amount: "4.00" })]),
      pushWrap: (push) => ({ ...push, getRecentCredits: async (token, args, signal) => {
        const lines = await push.getRecentCredits(token, args, signal);
        return [entry(3, { amount: "-9.00" }), ...lines];
      } }),
    },
    async ({ store, live }) => {
      await live();
      assert.deepEqual(store.list().map((t) => t.amount), ["4.00"]);
    },
  ));

// Intention: never two reconciles at the same time for one merchant: while one runs, the others are noted ONCE and replayed after.
test("processeur : jamais deux reconcile en même temps, une seule reprise notée", () => {
  let current = 0;
  let max = 0;
  let calls = 0;
  const pushWrap = (push) => ({
    ...push,
    getRecentCredits: async (...args) => {
      calls += 1;
      current += 1;
      max = Math.max(max, current);
      await pause(60);
      current -= 1;
      return push.getRecentCredits(...args);
    },
  });
  return withCaisse({ pushWrap }, async ({ processor, live }) => {
    await live();
    const before = calls;
    await Promise.all([1, 2, 3, 4, 5].map(() => processor.reconcile()));
    await waitFor(() => calls >= before + 2, "la reprise");
    await pause(250);
    assert.equal(max, 1, "never two at once");
    assert.equal(calls - before, 2, "one running, then ONE replay");
  });
});

// Intention: the periodic safety net reads the history again and again while listening, and finds a payment whose event was lost.
test("processeur : filet périodique toutes les safetyPollSeconds", () =>
  withCaisse({ config: { safetyPollSeconds: 0.15 } }, async ({ cyclos, store, live }) => {
    await live();
    const before = historyCalls(cyclos).length;
    cyclos.state.entries = [entry(1, { amount: "1.50" })]; // an event that was lost: nobody told us
    await waitFor(() => store.size === 1, "paiement trouvé par le filet périodique");
    await pause(500);
    assert.ok(historyCalls(cyclos).length >= before + 3, `${historyCalls(cyclos).length - before} lectures`);
    assert.equal(store.size, 1);
  }));

// Intention: the periodic net does not run while the stream is being reopened (it would only add noise to a failing Cyclos),
// and runs again when the stream is back. The processor is driven directly, with a context that says "reopening".
test("processeur : le filet périodique ne s'exécute pas pendant la réouverture du flux", async () => {
  const cyclos = await startFakeCyclos();
  const push = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  const token = await push.createSession(USER.login, USER.password);
  const store = createTicketStore();
  const conf = readCaisseConfig({}, { enabled: true, login: "l", password: "p", safetyPollSeconds: 0.1, historyInitial: 10 });
  const processor = createPaymentProcessor({ config: conf, push, store, log: { info() {}, error() {} } });
  let reopening = true;
  const ctx = { token: () => token, isReopening: () => reopening, isStopped: () => false, authLost() {} };
  try {
    await processor.prepare(ctx);
    const calls = () => cyclos.calls("GET", "/self/accounts/membre/history").length;
    const base = calls();
    await pause(450);
    assert.equal(calls(), base, "no poll while reopening");
    reopening = false;
    await waitFor(() => calls() > base, "poll after the reopening");
  } finally {
    processor.stop();
    await cyclos.close();
  }
});

// Intention: after stop(), a reconcile that was planned (account status just heard) never runs, and no timer is left.
test("processeur : après stop(), aucun reconcile planifié ne s'exécute", () =>
  withCaisse({ config: { safetyPollSeconds: 0.1 } }, async ({ cyclos, listener, live }) => {
    await live();
    cyclos.push("accountStatus", { n: 1 });
    await pause(10);
    await listener.stop();
    const calls = cyclos.state.requests.length;
    await pause(400);
    assert.equal(cyclos.state.requests.length, calls, "nothing after the stop");
  }));

// Intention: a processor that has no token (the listener is logging in again) calls nothing.
test("processeur : sans jeton, le filet n'appelle rien", async () => {
  const cyclos = await startFakeCyclos();
  const push = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  const store = createTicketStore();
  const conf = readCaisseConfig({}, { enabled: true, login: "l", password: "p", safetyPollSeconds: 3600, historyInitial: 10 });
  const processor = createPaymentProcessor({ config: conf, push, store, log: { info() {}, error() {} } });
  try {
    await processor.onStreamOpen({ token: () => null, isReopening: () => false, authLost() {} }, { recovered: true });
    await processor.reconcile();
    assert.equal(cyclos.state.requests.length, 0);
  } finally {
    processor.stop();
    await cyclos.close();
  }
});

// Intention: a full run (opening, notification, status, unreadable transfer, 401, failures, stop) leaves a log without any payer,
// amount, description, identifier, token or password.
test("processeur : le journal d'un scénario complet ne contient aucune donnée sensible", () =>
  withCaisse({ setup: (c) => (c.state.push.lifetimeMs = 150) }, async ({ cyclos, store, logs, live, listener }) => {
    cyclos.state.transfers.set("tr-1", transfer(1, { amount: "1.00", description: "Objet fictif", payer: "Payeur Un" }));
    cyclos.state.entries = [entry(1, { amount: "1.00" }), entry(2, { amount: "2.00" })];
    await live();
    cyclos.push("newNotification", paymentNotification(1));
    cyclos.push("newNotification", paymentNotification(2)); // transfer 404
    cyclos.push("accountStatus", { n: 1 });
    cyclos.pushRaw("event: newNotification\ndata: {Payeur-Secret-illisible\n\n");
    cyclos.force("GET /self/accounts/membre/history", 500);
    cyclos.expireTokens();
    await waitFor(() => cyclos.calls("POST", "/auth/session").length >= 2, "nouvelle connexion");
    await pause(300);
    await listener.stop();
    assert.ok(store.size === 0, "tickets forgotten at the stop");
    assertNoSensitive(logs, cyclos, ["Secret", "illisible\\n"]);
    assert.ok(logs.info.length + logs.error.length >= 3);
  }));
