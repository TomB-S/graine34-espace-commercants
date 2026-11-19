// === WHAT THIS FILE CHECKS ===
// The listening by token (multi-merchant mode): the listener never sees a password, it is LENT the Cyclos session token opened for it
// when the merchant logged in. What happens when that token stops working is not measured on the real Cyclos beyond 92 minutes, so
// the fallback is tested in detail: a 401 stops the listening with the state "reauth" (the merchant must log in again), the caller is
// told once per token, another token of the same merchant is tried at most once, and NOTHING is ever retried in a loop. Also: the
// token is never closed by the listener, a normal stop keeps it usable, and no password nor token reaches the log.
// All names and secrets are fictitious.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeCyclos, entry } from "./support/fake-cyclos.js";
import { readCaisseConfig } from "../src/caisse-config.js";
import { createCyclosPush } from "../src/cyclos-push.js";
import { createListenerManager } from "../src/listener-manager.js";

const MARIE = { id: "u-marie", login: "marie", password: "mdp-marie-test" };
const KEY = MARIE.id;

async function waitFor(condition, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé : ${what}`);
}
const quiet = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake Cyclos with one merchant, a manager in multi-merchant mode WITHOUT any credential, and `tokens`: the tokens the caller lends
// (the test opens them with the password, as the login will, then forgets the password). `refusals`: what the manager told the caller.
async function withTokens(options, fn) {
  const { entries = [entry(1, { amount: "1.00" })], config = {} } = options;
  const cyclos = await startFakeCyclos();
  cyclos.state.push.lifetimeMs = null;
  cyclos.addUser(MARIE.login, MARIE.password, { id: MARIE.id, entries });
  const push = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  const open = () => push.createSession(MARIE.login, MARIE.password);
  const tokens = []; // tokens lent, in order of preference (the first live one is used)
  const refusals = [];
  const lent = [];
  const logs = { info: [], error: [] };
  const log = { info: (m) => logs.info.push(m), error: (m) => logs.error.push(m) };
  const base = readCaisseConfig(
    { CAISSE_ENABLED: "true", CAISSE_CYCLOS_LOGIN: "ecouteur-test", CAISSE_CYCLOS_PASSWORD: "mdp-ecouteur-test", CAISSE_MULTI_MERCHANT: "true", CAISSE_ALLOWED_USERS: MARIE.id },
    { idleSeconds: 45, streamWatchdogSeconds: 60, reconnectMaxSeconds: 30, reauthMax: 3, safetyPollSeconds: 3600, historyInitial: 10, ticketsKept: 50, ...config },
  );
  const conf = Object.freeze({
    ...base,
    credentialsFor: undefined, // no password anywhere: only tokens
    tokenFor: (key) => {
      const token = key === KEY ? tokens.find((t) => !refusals.includes(t)) ?? null : null;
      lent.push(token);
      return token;
    },
    tokenRefused: (key, token) => refusals.push(token),
  });
  const clock = { at: Date.now() };
  const manager = createListenerManager({
    config: conf,
    push,
    log,
    now: () => clock.at,
    sweepIntervalMs: 3_600_000,
    listenerOptions: { shortStreamMs: 0, sleep: async () => {} },
    processorOptions: { debounceMs: 20 },
  });
  try {
    await fn({ cyclos, manager, open, tokens, refusals, lent, logs, clock });
  } finally {
    await manager.stopAll();
    await cyclos.close();
  }
}

const view = (manager) => manager.touch(KEY).view;
const live = (manager) => waitFor(() => view(manager).status === "live", "live");
const reauth = (manager) => waitFor(() => view(manager).status === "reauth", "reauth");
const logins = (cyclos) => cyclos.calls("POST", "/auth/session").length;

// Intention: the listening works with a lent token alone: payments load, and the listener makes no login of its own.
test("jeton : l'écoute fonctionne avec le seul jeton prêté, sans connexion de son côté", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens }) => {
    tokens.push(await open());
    assert.equal(logins(cyclos), 1, "the test's own login");
    manager.touch(KEY);
    await live(manager);
    assert.deepEqual(view(manager).tickets.map((t) => t.amount), ["1.00"]);
    assert.equal(logins(cyclos), 1, "the listener did not log in");
    for (const request of cyclos.state.requests.filter((r) => r.path !== "/auth/session")) {
      assert.equal(request.headers["session-token"], tokens[0]);
      assert.equal(request.headers.authorization, undefined, "no Basic header: no password");
    }
  }));

// Intention: no token lent at all (the session is gone): "reauth" at once, no call to Cyclos, nothing retried.
test("jeton : aucun jeton prêté, reconnexion nécessaire tout de suite, sans appel à Cyclos", () =>
  withTokens({}, async ({ cyclos, manager, lent }) => {
    manager.touch(KEY);
    await reauth(manager);
    await quiet();
    assert.equal(cyclos.state.requests.length, 0);
    assert.equal(lent.length, 1, "asked once");
    assert.equal(view(manager).status, "reauth");
  }));

// Intention: the listener never closes the token: a normal stop (idle delay) leaves it valid, and the next visit reuses it.
test("jeton : un arrêt normal ne ferme pas le jeton, la visite suivante le réutilise", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens, clock }) => {
    tokens.push(await open());
    manager.touch(KEY);
    await live(manager);
    clock.at += 46_000;
    await manager.sweep();
    assert.equal(manager.size, 0);
    assert.equal(cyclos.state.deleted.length, 0, "no DELETE: the token belongs to the merchant's session");
    assert.ok(cyclos.state.tokens.has(tokens[0]));
    manager.touch(KEY);
    await live(manager);
    assert.equal(logins(cyclos), 1, "same token, no new login");
    assert.deepEqual(view(manager).tickets.map((t) => t.amount), ["1.00"]);
  }));

// Intention: a token already dead at the start (401 on the first call): "reauth", the caller is told ONCE, no other attempt.
test("jeton : jeton déjà expiré au démarrage, reconnexion nécessaire, un seul essai", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens, refusals, lent }) => {
    tokens.push(await open());
    cyclos.expireTokens();
    manager.touch(KEY);
    await reauth(manager);
    await quiet(400);
    assert.deepEqual(refusals, [tokens[0]], "told once");
    assert.equal(logins(cyclos), 1, "no login attempted");
    const attempts = cyclos.state.requests.filter((r) => r.headers["session-token"] === tokens[0]);
    assert.ok(attempts.length <= 2, `at most the first call and the one that failed (${attempts.length})`);
    assert.equal(cyclos.calls("GET", "/push/subscribe").length, 0, "no stream opened with a dead token");
    assert.equal(view(manager).status, "reauth");
    assert.deepEqual(view(manager).tickets, []);
    assert.ok(lent.length <= 3);
  }));

// Intention: a token that dies WHILE listening (the stream is reopened every 41 s): "reauth", and no loop of reopenings.
test("jeton : jeton expiré pendant l'écoute, reconnexion nécessaire, pas de boucle", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens, refusals }) => {
    tokens.push(await open());
    manager.touch(KEY);
    await live(manager);
    const streams = cyclos.calls("GET", "/push/subscribe").length;
    cyclos.expireTokens();
    cyclos.endStreams(); // Cyclos closes the stream: the listener reopens it, with the dead token
    await reauth(manager);
    await quiet(400);
    assert.deepEqual(refusals, [tokens[0]]);
    assert.equal(cyclos.calls("GET", "/push/subscribe").length, streams + 1, "exactly one reopening, refused");
    assert.equal(logins(cyclos), 1);
    assert.equal(cyclos.openStreams(), 0);
  }));

// Intention: the 401 may come from a call of the processor (history, transfer), not only from the stream: same outcome.
test("jeton : 401 sur un appel de lecture de l'historique, reconnexion nécessaire, un seul essai", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens, refusals }) => {
    tokens.push(await open());
    cyclos.force("GET /self/accounts/membre/history", 401);
    manager.touch(KEY);
    await reauth(manager);
    await quiet(400);
    assert.deepEqual(refusals, [tokens[0]]);
    assert.equal(cyclos.calls("GET", "/self/accounts/membre/history").length, 1, "one try, no retry loop");
    assert.equal(logins(cyclos), 1);
  }));

// Intention: a 401 on a payment notification (the processor reads the transfer) also ends in "reauth", once.
test("jeton : 401 sur la lecture d'un virement pendant l'écoute, reconnexion nécessaire", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens, refusals }) => {
    tokens.push(await open());
    manager.touch(KEY);
    await live(manager);
    cyclos.force("GET /transfers/tr-9", 401);
    cyclos.expireTokens();
    cyclos.push("newNotification", { notification: { entityId: "tr-9", entityType: "transfer", type: "paymentReceived", date: new Date().toISOString() } });
    await reauth(manager);
    await quiet(300);
    assert.deepEqual(refusals, [tokens[0]]);
    assert.equal(logins(cyclos), 1);
  }));

// Intention: another token of the same merchant (another tablet) is tried ONCE after a refusal, and the listening goes on with it.
test("jeton : un autre jeton du même commerçant prend le relais, l'écoute continue", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens, refusals }) => {
    tokens.push(await open(), await open());
    manager.touch(KEY);
    await live(manager);
    cyclos.state.tokens.delete(tokens[0]); // the first token dies
    cyclos.endStreams();
    await waitFor(() => refusals.length === 1, "first token refused");
    await live(manager);
    await waitFor(() => cyclos.openStreams() === 1, "stream reopened");
    assert.deepEqual(refusals, [tokens[0]]);
    assert.equal(view(manager).status, "live");
    assert.equal(logins(cyclos), 2, "only the test's two logins");
    const last = cyclos.calls("GET", "/push/subscribe").at(-1);
    assert.equal(last.headers["session-token"], tokens[1]);
  }));

// Intention: when the second token dies too, "reauth"; each token was refused once and never tried again.
test("jeton : tous les jetons refusés, reconnexion nécessaire, chaque jeton essayé une seule fois", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens, refusals }) => {
    tokens.push(await open(), await open());
    manager.touch(KEY);
    await live(manager);
    cyclos.expireTokens();
    cyclos.endStreams();
    await reauth(manager);
    await quiet(400);
    assert.deepEqual([...refusals].sort(), [...tokens].sort());
    assert.equal(new Set(refusals).size, refusals.length, "no token reported twice");
    assert.equal(logins(cyclos), 2);
    for (const token of tokens) {
      const streams = cyclos.calls("GET", "/push/subscribe").filter((r) => r.headers["session-token"] === token);
      assert.ok(streams.length <= 2, `token tried a bounded number of times (${streams.length})`);
    }
  }));

// Intention: after "reauth" nothing restarts by itself: visits do not retry, a long time passing does not either.
test("jeton : après reconnexion nécessaire, ni les visites ni le temps ne relancent l'écoute", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens, clock, lent }) => {
    tokens.push(await open());
    cyclos.expireTokens();
    manager.touch(KEY);
    await reauth(manager);
    const calls = cyclos.state.requests.length;
    const asked = lent.length;
    for (let i = 0; i < 20; i += 1) {
      clock.at += 10_000;
      manager.touch(KEY);
      await manager.sweep();
    }
    await quiet(300);
    assert.equal(cyclos.state.requests.length, calls, "no new call to Cyclos");
    assert.equal(lent.length, asked, "no new token asked for");
    assert.equal(view(manager).status, "reauth");
  }));

// Intention: a new login (a fresh token) restarts a dead listener, and a working one is left alone.
test("jeton : une nouvelle connexion relance une écoute en reconnexion nécessaire, pas une écoute qui marche", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens }) => {
    tokens.push(await open());
    cyclos.expireTokens();
    manager.touch(KEY);
    await reauth(manager);
    tokens.length = 0;
    tokens.push(await open()); // the merchant logs in again
    assert.equal(await manager.restartIfStopped(KEY), true);
    assert.equal(manager.size, 0);
    manager.touch(KEY);
    await live(manager);
    assert.equal(await manager.restartIfStopped(KEY), false, "working: left alone");
    assert.equal(manager.size, 1);
  }));

// Intention: only a 401 means "log in again". A 403 is an error state as before, and an outage (5xx) is a reconnection, the token is kept.
test("jeton : 403 = erreur, panne de Cyclos = reconnexion, jamais « reconnexion nécessaire »", async () => {
  await withTokens({}, async ({ cyclos, manager, open, tokens, refusals }) => {
    tokens.push(await open());
    cyclos.force("GET /push/subscribe", 403);
    manager.touch(KEY);
    await waitFor(() => view(manager).status === "error", "error");
    assert.deepEqual(refusals, []);
  });
  await withTokens({}, async ({ cyclos, manager, open, tokens, refusals }) => {
    tokens.push(await open());
    cyclos.force("GET /push/subscribe", 500);
    manager.touch(KEY);
    await waitFor(() => ["reconnecting", "degraded"].includes(view(manager).status), "reconnecting");
    await quiet(200);
    assert.notEqual(view(manager).status, "reauth");
    assert.deepEqual(refusals, [], "the token is not accused");
    cyclos.state.forced.clear();
    await live(manager);
    assert.equal(logins(cyclos), 1);
  });
});

// Intention: nothing in the manager, the configuration or the log holds a password; no token in the log either.
test("jeton : aucun mot de passe dans la configuration ni le journal, aucun jeton dans le journal", () =>
  withTokens({}, async ({ cyclos, manager, open, tokens, logs }) => {
    tokens.push(await open());
    manager.touch(KEY);
    await live(manager);
    cyclos.expireTokens();
    cyclos.endStreams();
    await reauth(manager);
    const text = JSON.stringify(logs);
    assert.equal(text.includes(MARIE.password), false);
    assert.equal(text.includes("mdp-ecouteur-test"), false);
    for (const token of cyclos.state.tokenUsers.keys()) assert.equal(text.includes(token), false);
    assert.ok(logs.error.some((l) => /reconnexion nécessaire/.test(l)));
  }));
