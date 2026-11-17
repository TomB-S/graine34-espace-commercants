// === WHAT THIS FILE CHECKS ===
// The Cyclos calls of the cash register page (cyclos-push.js), against the fake Cyclos: login, user id, account, notification
// setting, latest credits, transfer detail, and the push stream (headers, query, Last-Event-ID, normal end, abort).
// Each answer is turned into one of three errors (401, 403, other), whose message holds no URL, token or identifier.
// All values are fictitious. Basic notions: test/statique.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeCyclos, USER, entry, transfer, paymentNotification, notificationSettingsBody } from "./support/fake-cyclos.js";
import { createCyclosPush, PushAuthError, PushForbiddenError, PushUnavailableError } from "../src/cyclos-push.js";
import { createSseParser } from "../src/sse-parser.js";

// A fake Cyclos and a client, stopped at the end.
async function withClient(options, fn) {
  const cyclos = await startFakeCyclos();
  const push = createCyclosPush({ baseUrl: cyclos.url, channel: "main", ...options });
  try {
    await fn({ cyclos, push });
  } finally {
    await cyclos.close();
  }
}

const login = (push) => push.createSession(USER.login, USER.password);

// Intention: the login returns the token only, with `Channel: main` and Basic authentication.
test("cyclos-push : createSession renvoie le jeton, avec Channel et Basic", () =>
  withClient({}, async ({ cyclos, push }) => {
    const token = await login(push);
    assert.match(token, /^jeton-\d+$/);
    const [call] = cyclos.calls("POST", "/auth/session");
    assert.equal(call.headers.channel, "main");
    assert.match(call.headers.authorization, /^Basic /);
  }));

// Intention: 401 / 403 / 5xx / cut connection are three different kinds of error, with messages that
// carry no token, login or password.
test("cyclos-push : 401, 403, 5xx et réseau coupé donnent trois genres d'erreur sans donnée sensible", () =>
  withClient({}, async ({ cyclos, push }) => {
    await assert.rejects(push.createSession("inconnu", "mauvais"), PushAuthError);
    cyclos.force("POST /auth/session", 403);
    await assert.rejects(login(push), PushForbiddenError);
    cyclos.force("POST /auth/session", 500);
    await assert.rejects(login(push), (e) => e instanceof PushUnavailableError && e.status === 500);
    cyclos.force("POST /auth/session", 429);
    await assert.rejects(login(push), (e) => e instanceof PushUnavailableError && e.status === 429);
    cyclos.force("POST /auth/session", "drop");
    await assert.rejects(login(push), (e) => e instanceof PushUnavailableError && e.status === null);
    await assert.rejects(
      push.createSession(USER.login, "mauvais-mdp-de-test"),
      (e) => !e.message.includes("mauvais-mdp") && !e.message.includes(USER.login) && !e.message.includes("127.0.0.1"),
    );
  }));

// Intention: without a channel configured, no Channel header is sent (same rule as the statement).
test("cyclos-push : sans canal configuré, aucun en-tête Channel", () =>
  withClient({ channel: "" }, async ({ cyclos, push }) => {
    const token = await login(push);
    await push.getUserId(token);
    for (const r of cyclos.state.requests) assert.equal("channel" in r.headers, false, r.path);
  }));

// Intention: every call (not only the login) carries Channel and Session-Token.
test("cyclos-push : Channel et Session-Token sur chaque appel", () =>
  withClient({}, async ({ cyclos, push }) => {
    cyclos.state.entries = [entry(1)];
    cyclos.state.transfers.set("tr-1", transfer(1));
    const token = await login(push);
    await push.getUserId(token);
    await push.getAccount(token);
    await push.getPaymentReceivedSetting(token);
    await push.getRecentCredits(token, { accountType: "membre", pageSize: 5 });
    await push.getTransfer(token, "tr-1");
    const stream = await push.openStream(token, { clientId: "client-test-1" });
    for await (const chunk of stream.chunks) void chunk;
    await push.closeSession(token);
    assert.equal(cyclos.state.requests.length, 8); // login, user, account, setting, credits, transfer, stream, logout
    for (const r of cyclos.state.requests) {
      assert.equal(r.headers.channel, "main", `${r.method} ${r.path}`);
      if (r.path !== "/auth/session" || r.method === "DELETE") assert.equal(r.headers["session-token"], token, r.path);
    }
    assert.deepEqual(cyclos.state.deleted, [token]);
  }));

// Intention: the user id is read from GET /users/self?fields=id; a missing or odd id gives null (never a guess).
test("cyclos-push : getUserId lit l'identifiant, null si absent ou étrange", () =>
  withClient({}, async ({ cyclos, push }) => {
    const token = await login(push);
    assert.equal(await push.getUserId(token), USER.id);
    assert.equal(cyclos.calls("GET", "/users/self")[0].query.get("fields"), "id");
    const odd = createCyclosPush({
      baseUrl: cyclos.url,
      channel: "main",
      fetchImpl: async () => new Response(JSON.stringify({ id: "a b/../c" }), { status: 200 }),
    });
    assert.equal(await odd.getUserId(token), null);
    const none = createCyclosPush({ baseUrl: cyclos.url, fetchImpl: async () => new Response("{}", { status: 200 }) });
    assert.equal(await none.getUserId(token), null);
  }));

// Intention: the account is the first one, like the statement; an empty list, or a type that cannot go in a path, gives null.
test("cyclos-push : getAccount lit le type et la devise, null si rien d'utilisable", () =>
  withClient({}, async ({ cyclos, push }) => {
    const token = await login(push);
    assert.deepEqual(await push.getAccount(token), { accountType: "membre", currency: { name: "Graines", decimalDigits: 2 } });
    cyclos.state.accountsBody = [];
    assert.equal(await push.getAccount(token), null);
    cyclos.state.accountsBody = [{ type: { internalName: "../secret" } }];
    assert.equal(await push.getAccount(token), null);
  }));

// Intention: the setting is read in settings.notifications, in the element whose type is "paymentReceived", from its boolean `internal`.
// true, false, or null when the answer does not say (the caller then uses the fallback mode).
test("cyclos-push : getPaymentReceivedSetting lit settings.notifications, élément paymentReceived, champ internal", () =>
  withClient({}, async ({ cyclos, push }) => {
    const token = await login(push);
    const read = async (options) => {
      cyclos.state.notificationSettings = notificationSettingsBody(options);
      return push.getPaymentReceivedSetting(token);
    };
    assert.equal(await push.getPaymentReceivedSetting(token), true, "the default of the fake Cyclos");
    assert.equal(await read({ paymentReceived: { internal: true } }), true);
    assert.equal(await read({ paymentReceived: { internal: false } }), false);
    assert.equal(await read({ paymentReceived: { internal: true, email: false, app: false, sms: false } }), true, "only `internal` counts, not email or app");
    assert.equal(await read({ paymentReceived: { internal: false, email: true, app: true, sms: true } }), false);
    assert.equal(await read({ paymentReceived: null }), null, "no paymentReceived element among others");
    assert.equal(await read({ paymentReceived: null, others: false }), null, "empty array");
    assert.equal(await read({ paymentReceived: { internal: "oui" } }), null, "internal is not a boolean");
    assert.equal(await read({ paymentReceived: { internal: 1 } }), null);
    assert.equal(await read({ paymentReceived: { internal: null } }), null);
  }));

// Intention: kind is not a filter, and a duplicated type counts as enabled as soon as one of them has internal true.
test("cyclos-push : paymentReceived, kind ignoré, doublon de type = activé si au moins un internal est true", () =>
  withClient({}, async ({ cyclos, push }) => {
    const token = await login(push);
    const element = (flags) => ({ kind: "autre", type: "paymentReceived", internal: false, sms: false, email: false, app: false, ...flags });
    const read = async (options) => {
      cyclos.state.notificationSettings = notificationSettingsBody(options);
      return push.getPaymentReceivedSetting(token);
    };
    assert.equal(await read({ paymentReceived: null, extra: [element({ internal: true })] }), true, "any kind");
    assert.equal(await read({ paymentReceived: { internal: false }, extra: [element({ internal: true })] }), true, "one of two is enough");
    assert.equal(await read({ paymentReceived: { internal: true }, extra: [element({ internal: false })] }), true);
    assert.equal(await read({ paymentReceived: { internal: false }, extra: [element({ internal: false })] }), false);
    assert.equal(await read({ paymentReceived: { internal: false }, extra: [element({ internal: "oui" })] }), false);
    assert.equal(await read({ paymentReceived: null, extra: [element({ internal: "oui" })] }), null, "no boolean at all");
    assert.equal(await read({ paymentReceived: { internal: "x" }, extra: [element({ internal: true })] }), true);
  }));

// Intention: the old guesses (the setting at the root, or under notificationSettings) no longer count, and odd answers are "unknown".
test("cyclos-push : anciennes formes et réponses bizarres = inconnu (null), sans erreur", () =>
  withClient({}, async ({ cyclos, push }) => {
    const token = await login(push);
    const read = async (body) => {
      cyclos.state.notificationSettings = body;
      return push.getPaymentReceivedSetting(token);
    };
    assert.equal(await read({ paymentReceived: { internal: true, email: true, app: true } }), null, "root: no longer read");
    assert.equal(await read({ notificationSettings: { paymentReceived: { internal: true } } }), null, "notificationSettings: no longer read");
    assert.equal(await read({ settings: { paymentReceived: { internal: true } } }), null, "settings.paymentReceived: not the array");
    assert.equal(await read({ settings: { notifications: { paymentReceived: { internal: true } } } }), null, "an object, not an array");
    assert.equal(await read({ settings: { notifications: "paymentReceived" } }), null);
    assert.equal(await read({ settings: { notifications: [null, 3, "x", [], { internal: true }] } }), null, "elements without the type");
    assert.equal(await read({ settings: { notifications: [null, { type: "paymentReceived", internal: true }] } }), true, "odd elements are skipped");
    assert.equal(await read({ settings: {} }), null);
    assert.equal(await read({}), null);
    assert.equal(await read(null), null);
    assert.equal(await read([]), null);
  }));

// Intention: the latest credits are asked with the exact query of the instructions, and only credits come back.
test("cyclos-push : getRecentCredits envoie la requête prévue et ne rend que des entrées", () =>
  withClient({}, async ({ cyclos, push }) => {
    cyclos.state.entries = [entry(3), entry(2, { amount: "-4.00" }), entry(1)];
    const token = await login(push);
    const credits = await push.getRecentCredits(token, { accountType: "membre", pageSize: 20 });
    assert.deepEqual(credits.map((e) => e.transactionNumber), ["T00003", "T00001"]);
    const query = cyclos.calls("GET", "/self/accounts/membre/history")[0].query;
    assert.equal(query.get("direction"), "credit");
    assert.equal(query.get("kinds"), "payment");
    assert.equal(query.get("orderBy"), "dateDesc");
    assert.equal(query.get("pageSize"), "20");
    assert.equal(query.get("skipTotalCount"), "true");
    await assert.rejects(push.getRecentCredits(token, { accountType: "../x", pageSize: 1 }), PushUnavailableError);
  }));

// Intention: one call reads the transfer; an unknown transfer is an error (the caller makes an incomplete ticket);
// an odd identifier never reaches the network.
test("cyclos-push : getTransfer lit le transfert, 404 est une erreur, identifiant étrange jamais envoyé", () =>
  withClient({}, async ({ cyclos, push }) => {
    cyclos.state.transfers.set("tr-7", transfer(7, { amount: "1.00", description: "Objet fictif" }));
    const token = await login(push);
    const body = await push.getTransfer(token, "tr-7");
    assert.equal(body.amount, "1.00");
    assert.equal(typeof body.amount, "string");
    assert.equal(body.description, undefined, "description is not at the root");
    assert.equal(body.transaction.description, "Objet fictif");
    await assert.rejects(push.getTransfer(token, "tr-404"), (e) => e instanceof PushUnavailableError && e.status === 404 && !e.message.includes("tr-404"));
    const before = cyclos.state.requests.length;
    for (const bad of ["../x", "a/b", "a b", "", "x".repeat(65), "tr-7?x=1"]) {
      await assert.rejects(push.getTransfer(token, bad), PushUnavailableError, JSON.stringify(bad));
    }
    assert.equal(cyclos.state.requests.length, before);
    cyclos.state.transactions.set("tx-1", { transactionNumber: "T00009" });
    assert.equal((await push.getTransaction(token, "tx-1")).transactionNumber, "T00009");
    assert.equal(cyclos.calls("GET", "/transactions/tx-1").length, 1);
    assert.equal(cyclos.calls("GET", "/transfers/tx-1").length, 0, "a transaction id is never sent to /transfers");
  }));

// Intention: an answer that is not JSON is an error of the third kind, not an exception of our own code.
test("cyclos-push : réponse illisible = PushUnavailableError", async () => {
  const push = createCyclosPush({ baseUrl: "http://x/api", fetchImpl: async () => new Response("<html>", { status: 200 }) });
  await assert.rejects(push.getTransfer("t", "tr-1"), PushUnavailableError);
  await assert.rejects(push.createSession("a", "b"), PushUnavailableError);
});

// Intention: a Cyclos that never answers does not freeze the listener: the call fails with a timeout.
test("cyclos-push : un appel sans réponse échoue après le délai (timeout)", () =>
  withClient({ requestTimeoutMs: 150 }, async ({ cyclos, push }) => {
    const token = await login(push);
    cyclos.force("GET /transfers/tr-1", "hang");
    await assert.rejects(push.getTransfer(token, "tr-1"), (e) => e instanceof PushUnavailableError && e.message === "timeout");
  }));

// Reads a stream until it ends, returns the events seen.
async function readStream(stream) {
  const parser = createSseParser();
  const events = [];
  for await (const chunk of stream.chunks) events.push(...parser.feed(chunk));
  return { events, lastEventId: parser.lastEventId };
}

// Intention: the stream request has the headers and the query of section 2 (Accept, Channel, Session-Token, clientId, two kinds),
// no Last-Event-ID the first time, and it ends by itself when the "server" closes it (normal end, about 41 s for the real one).
test("cyclos-push : openStream, en-têtes, requête, fin normale", () =>
  withClient({}, async ({ cyclos, push }) => {
    const token = await login(push);
    const stream = await push.openStream(token, { clientId: "client-test-1" });
    const { events } = await readStream(stream);
    assert.deepEqual(events, []);
    const [call] = cyclos.calls("GET", "/push/subscribe");
    assert.equal(call.headers.accept, "text/event-stream");
    assert.equal(call.headers.channel, "main");
    assert.equal(call.headers["session-token"], token);
    assert.equal("last-event-id" in call.headers, false);
    assert.equal(call.query.get("clientId"), "client-test-1");
    assert.deepEqual(call.query.getAll("kinds"), ["accountStatus", "newNotification"]);
  }));

// Intention: events pushed while the stream is open arrive decoded; on reconnection the Last-Event-ID header is sent and the
// events missed in between are replayed (what Cyclos does for a short cut).
test("cyclos-push : événements reçus, Last-Event-ID envoyé à la reconnexion, rejeu des manqués", () =>
  withClient({}, async ({ cyclos, push }) => {
    cyclos.state.push.lifetimeMs = null;
    const token = await login(push);
    const stream = await push.openStream(token, { clientId: "client-test-1" });
    const reading = readStream(stream);
    await new Promise((resolve) => setTimeout(resolve, 50));
    cyclos.push("newNotification", paymentNotification(1));
    cyclos.push("accountStatus", { account: "x" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    cyclos.endStreams();
    const first = await reading;
    assert.deepEqual(first.events.map((e) => e.event), ["newNotification", "accountStatus"]);
    assert.equal(first.lastEventId, "2");

    cyclos.push("newNotification", paymentNotification(2)); // while nobody listens
    cyclos.state.push.lifetimeMs = 100;
    const second = await readStream(await push.openStream(token, { clientId: "client-test-1", lastEventId: first.lastEventId }));
    assert.equal(cyclos.calls("GET", "/push/subscribe")[1].headers["last-event-id"], "2");
    assert.equal(cyclos.calls("GET", "/push/subscribe")[1].query.get("clientId"), "client-test-1");
    assert.deepEqual(second.events.map((e) => JSON.parse(e.data).notification.entityId), ["tr-2"]);
  }));

// Intention: multi-byte characters survive the network cutting a character in two (the decoder is in stream mode).
test("cyclos-push : un caractère multi-octets coupé entre deux morceaux réseau est reconstitué", async () => {
  const bytes = new TextEncoder().encode('data: {"t":"é日"}\n\n');
  const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
  const push = createCyclosPush({ baseUrl: "http://x/api", fetchImpl: async () => new Response(body, { status: 200 }) });
  const { events } = await readStream(await push.openStream("t", { clientId: "c1" }));
  assert.equal(JSON.parse(events[0].data).t, "é日");
});

// Intention: 401 (expired token), 403 and 5xx on the stream are the three kinds of error, raised BEFORE any chunk.
test("cyclos-push : openStream, 401, 403 et 5xx donnent les trois genres d'erreur", () =>
  withClient({}, async ({ cyclos, push }) => {
    const token = await login(push);
    cyclos.expireTokens();
    await assert.rejects(push.openStream(token, { clientId: "c1" }), PushAuthError);
    const fresh = await login(push);
    cyclos.force("GET /push/subscribe", 403);
    await assert.rejects(push.openStream(fresh, { clientId: "c1" }), PushForbiddenError);
    cyclos.force("GET /push/subscribe", 503);
    await assert.rejects(push.openStream(fresh, { clientId: "c1" }), (e) => e instanceof PushUnavailableError && e.status === 503);
    cyclos.force("GET /push/subscribe", "drop");
    await assert.rejects(push.openStream(fresh, { clientId: "c1" }), PushUnavailableError);
    await assert.rejects(push.openStream(fresh, { clientId: "a b" }), PushUnavailableError);
  }));

// Intention: the stop of the listener (AbortController) ends a stream that would otherwise stay open, with the AbortError
// itself (not an incident), and the connection is really closed on the Cyclos side.
test("cyclos-push : abort() arrête un flux ouvert, AbortError, connexion fermée", () =>
  withClient({}, async ({ cyclos, push }) => {
    cyclos.state.push.lifetimeMs = null;
    const token = await login(push);
    const controller = new AbortController();
    const stream = await push.openStream(token, { clientId: "client-test-1", signal: controller.signal });
    const reading = readStream(stream);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cyclos.openStreams(), 1);
    controller.abort();
    await assert.rejects(reading, (e) => e.name === "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cyclos.openStreams(), 0);
    // Aborted before the answer: also an AbortError, not a network incident.
    const early = new AbortController();
    early.abort();
    await assert.rejects(push.openStream(token, { clientId: "client-test-1", signal: early.signal }), (e) => e.name === "AbortError");
  }));

// Intention: a stream cut in the middle (connection destroyed) is a PushUnavailableError, not a crash.
test("cyclos-push : flux coupé en route = PushUnavailableError", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(":Initialized\n\n"));
      controller.error(new TypeError("terminated"));
    },
  });
  const push = createCyclosPush({ baseUrl: "http://x/api", fetchImpl: async () => new Response(body, { status: 200 }) });
  const stream = await push.openStream("t", { clientId: "c1" });
  await assert.rejects(readStream(stream), PushUnavailableError);
});

// Intention: closeSession never throws, even when Cyclos refuses or is gone.
test("cyclos-push : closeSession n'échoue jamais", () =>
  withClient({}, async ({ cyclos, push }) => {
    await push.closeSession("jeton-inconnu");
    cyclos.force("DELETE /auth/session", "drop");
    await push.closeSession("jeton-inconnu");
  }));
