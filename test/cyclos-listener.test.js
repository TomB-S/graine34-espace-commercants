// === WHAT THIS FILE CHECKS ===
// The listening loop (cyclos-listener.js) against the fake Cyclos: opening, reopening after the normal end of the stream (same
// clientId, right Last-Event-ID, no pause, nothing in the log), Channel and Session-Token on every call, the watchdog, the growing and
// capped pause, 401 (log in again, then stop after too many refusals: the number of login calls is counted), 403, a clean stop with no
// timer left, and what the log may and may not contain. The processor (the meaning of the events) is replaced by a spy here.
// All values are fictitious. Basic notions: test/statique.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeCyclos, USER, paymentNotification } from "./support/fake-cyclos.js";
import { readCaisseConfig } from "../src/caisse-config.js";
import { createCyclosPush, PushAuthError } from "../src/cyclos-push.js";
import { createTicketStore } from "../src/ticket-store.js";
import { createListener } from "../src/cyclos-listener.js";

async function waitFor(condition, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé : ${what}`);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake Cyclos, a client, a store and a listener (not started). Everything is stopped at the end.
async function withListener(options, fn) {
  const { config = {}, processor, sleep, random, now, shortStreamMs = 0, credentials = USER, setup } = options;
  const cyclos = await startFakeCyclos();
  setup?.(cyclos);
  const push = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  const store = createTicketStore();
  const logs = { info: [], error: [] };
  const log = { info: (m) => logs.info.push(m), error: (m) => logs.error.push(m) };
  const conf = readCaisseConfig({}, {
    enabled: true,
    login: credentials.login,
    password: credentials.password,
    streamWatchdogSeconds: 60,
    reconnectMaxSeconds: 30,
    reauthMax: 3,
    ...config,
  });
  const listener = createListener({ merchantKey: "prototype", config: conf, push, store, log, processor, sleep, random, now, shortStreamMs });
  try {
    await fn({ cyclos, listener, store, logs, push });
  } finally {
    await listener.stop();
    await cyclos.close();
  }
}

const streamCalls = (cyclos) => cyclos.calls("GET", "/push/subscribe");
const loginCalls = (cyclos) => cyclos.calls("POST", "/auth/session");

// Intention: start() answers at once (the page must not wait), then the listener logs in once, opens the stream with the headers and
// the query of the instructions, and the store says "live".
test("listener : démarrage, une connexion, un flux ouvert, état live", () =>
  withListener({}, async ({ cyclos, listener, store }) => {
    assert.equal(store.status(), "starting");
    listener.start();
    assert.equal(store.status(), "starting");
    await waitFor(() => store.status() === "live", "état live");
    assert.equal(loginCalls(cyclos).length, 1);
    assert.equal(streamCalls(cyclos).length >= 1, true);
    const call = streamCalls(cyclos)[0];
    assert.equal(call.headers.channel, "main");
    assert.equal(call.headers["session-token"], [...cyclos.state.tokens][0]);
    assert.equal(call.headers.accept, "text/event-stream");
    assert.equal(call.query.get("clientId"), listener.clientId);
    assert.deepEqual(call.query.getAll("kinds"), ["accountStatus", "newNotification"]);
    assert.match(listener.clientId, /^[0-9a-f-]{36}$/);
  }));

// Intention: Cyclos closes the stream by itself (every 41 s, here 200 ms): it is reopened at once, with the SAME clientId and the
// Last-Event-ID of the last event, no new login, no pause, nothing in the error log, and Channel + Session-Token on every call.
test("listener : fin normale du flux = réouverture immédiate, même clientId, bon Last-Event-ID, journal silencieux", () => {
  const pauses = [];
  return withListener({ sleep: async (ms) => pauses.push(ms) }, async ({ cyclos, listener, logs }) => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1, "premier flux");
    cyclos.push("newNotification", paymentNotification(1));
    cyclos.push("accountStatus", { x: 1 });
    await waitFor(() => streamCalls(cyclos).length >= 3, "au moins trois flux");
    const calls = streamCalls(cyclos);
    assert.equal("last-event-id" in calls[0].headers, false);
    assert.equal(calls[1].headers["last-event-id"], "2");
    assert.equal(calls[2].headers["last-event-id"], "2");
    for (const call of calls) assert.equal(call.query.get("clientId"), listener.clientId);
    assert.equal(loginCalls(cyclos).length, 1, "no new login");
    assert.deepEqual(pauses, [], "no pause");
    assert.deepEqual(logs.error, []);
    assert.deepEqual(logs.info, ["écoute démarrée"], "the normal ends are silent");
    for (const r of cyclos.state.requests) {
      assert.equal(r.headers.channel, "main", `${r.method} ${r.path}`);
      if (r.path === "/push/subscribe") assert.ok(r.headers["session-token"], "Session-Token on the stream");
    }
  });
});

// Intention: an event without an id never erases the Last-Event-ID already known.
test("listener : Last-Event-ID conservé quand un événement n'a pas d'id", () =>
  withListener({ setup: (c) => (c.state.push.lifetimeMs = 150) }, async ({ cyclos, listener }) => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1, "flux");
    cyclos.push("accountStatus", { a: 1 }, { id: 7 });
    cyclos.pushRaw('event: accountStatus\ndata: {"b":2}\n\n');
    await waitFor(() => streamCalls(cyclos).length >= 2, "réouverture");
    assert.equal(streamCalls(cyclos)[1].headers["last-event-id"], "7");
  }));

// Intention: the events are handed to the processor, in order; an event of another kind, or with broken JSON, is not
// (the broken one is logged by its NAME only, never by its content).
test("listener : événements transmis dans l'ordre, genre inconnu ignoré, JSON illisible journalisé par son nom seulement", () => {
  const seen = [];
  const processor = { onEvent: async (event) => seen.push([event.kind, event.data.n ?? null]) };
  return withListener({ processor, setup: (c) => (c.state.push.lifetimeMs = null) }, async ({ cyclos, listener, logs }) => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1, "flux");
    cyclos.push("newNotification", { n: 1 });
    cyclos.pushRaw("id: 50\nevent: newNotification\ndata: {contenu-secret-illisible\n\n");
    cyclos.push("autreEvenement", { n: 2 });
    cyclos.push("accountStatus", { n: 3 });
    await waitFor(() => seen.length === 2, "deux événements transmis");
    assert.deepEqual(seen, [["newNotification", 1], ["accountStatus", 3]]);
    assert.ok(logs.info.includes("événement illisible ignoré (newNotification)"));
    assert.ok(!JSON.stringify(logs).includes("secret"));
  });
});

// Intention: a processor that fails (any exception) never breaks the loop: it is logged without its message (a message could quote data)
// and the next events are still handled.
test("listener : exception du processeur journalisée sans son message, la boucle continue", () => {
  let calls = 0;
  const processor = {
    onEvent: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("donnee-sensible-dans-le-message");
    },
  };
  return withListener({ processor, setup: (c) => (c.state.push.lifetimeMs = null) }, async ({ cyclos, listener, logs }) => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1, "flux");
    cyclos.push("accountStatus", { n: 1 });
    cyclos.push("accountStatus", { n: 2 });
    await waitFor(() => calls === 2, "les deux événements traités");
    assert.equal(logs.error.length, 1);
    assert.match(logs.error[0], /erreur de traitement d'un événement : TypeError/);
    assert.ok(!JSON.stringify(logs).includes("sensible"));
    assert.equal(cyclos.openStreams(), 1, "the stream is still open");
  });
});

// Intention: the processor is told, on each opening, whether it follows trouble. A first opening and the normal reopenings: no.
test("listener : onStreamOpen reçoit recovered=false au départ et après une fin normale", () => {
  const opens = [];
  return withListener({ processor: { onStreamOpen: (ctx, info) => opens.push(info.recovered) } }, async ({ cyclos, listener }) => {
    listener.start();
    await waitFor(() => streamCalls(cyclos).length >= 3, "trois flux");
    await waitFor(() => opens.length >= 3, "trois ouvertures");
    assert.deepEqual(opens.slice(0, 3), [false, false, false]);
  });
});

// Intention: prepare() is called once, after the first login, before the stream opens.
test("listener : prepare() appelé une fois, avant l'ouverture du flux", () => {
  const order = [];
  const processor = { prepare: async (ctx) => order.push(`prepare:${ctx.token() ? "token" : "none"}`) };
  return withListener({ processor }, async ({ cyclos, listener }) => {
    listener.start();
    await waitFor(() => streamCalls(cyclos).length >= 2, "deux flux");
    assert.deepEqual(order, ["prepare:token"]);
    assert.equal(cyclos.state.requests[0].path, "/auth/session");
    assert.equal(cyclos.state.requests[1].path, "/push/subscribe");
  });
});

// Intention: a silent stream (not even a comment line) is a dead connection: after the watchdog delay the request is cancelled
// and the stream reopened, and the processor is told it follows trouble (events may have been lost).
test("listener : chien de garde, silence = annulation et réouverture, recovered=true", () => {
  const opens = [];
  return withListener(
    { config: { streamWatchdogSeconds: 0.15 }, processor: { onStreamOpen: (ctx, info) => opens.push(info.recovered) }, setup: (c) => (c.state.push.silent = true) },
    async ({ cyclos, listener, logs }) => {
      listener.start();
      await waitFor(() => streamCalls(cyclos).length >= 3, "trois ouvertures malgré le silence");
      assert.equal(loginCalls(cyclos).length, 1, "no new login");
      await waitFor(() => opens.length >= 3, "trois ouvertures vues par le processeur");
      assert.deepEqual(opens.slice(0, 3), [false, true, true]);
      assert.ok(logs.info.includes("silence prolongé sur le flux, réouverture"));
      assert.deepEqual(logs.error, []);
      for (const call of streamCalls(cyclos)) assert.equal(call.query.get("clientId"), listener.clientId);
    },
  );
});

// Intention: the watchdog is re-armed by EVERY piece of data, even a comment: a stream that talks is never cut.
test("listener : le chien de garde est relancé par chaque donnée reçue", () =>
  withListener({ config: { streamWatchdogSeconds: 0.3 }, setup: (c) => (c.state.push.lifetimeMs = null) }, async ({ cyclos, listener }) => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1, "flux");
    for (let i = 0; i < 6; i += 1) {
      await pause(100);
      cyclos.pushRaw(": ping\n\n");
    }
    assert.equal(streamCalls(cyclos).length, 1, "0.6 s of life, never cut");
  }));

// Intention: the pause grows 1, 2, 4, 8, 16 s, stops at the maximum (30 s), is never longer than the step, and starts again from 1 s
// after a stream opened. The state is "reconnecting", then "degraded" once the trouble lasts more than the watchdog delay (60 s).
test("listener : pause croissante plafonnée, remise à zéro après un flux ouvert, reconnecting puis degraded", () => {
  const pauses = [];
  const statuses = [];
  let clock = 1_000_000;
  let storeRef;
  const sleep = async (ms) => {
    pauses.push(ms);
    statuses.push(storeRef.status());
    clock += ms;
    await new Promise((resolve) => setImmediate(resolve));
  };
  return withListener(
    { sleep, random: () => 1, now: () => clock, setup: (c) => c.force("GET /push/subscribe", 503) },
    async ({ cyclos, listener, store, logs }) => {
      storeRef = store;
      listener.start();
      await waitFor(() => pauses.length >= 7, "sept pauses");
      assert.deepEqual(pauses.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
      assert.deepEqual(statuses.slice(0, 6), Array(6).fill("reconnecting"));
      assert.equal(statuses[6], "degraded", "more than 60 s of trouble");
      assert.equal(loginCalls(cyclos).length, 1, "a 503 does not make a new login");
      assert.ok(logs.error.every((line) => /PushUnavailableError \(503 on openStream\)/.test(line)));

      // The stream comes back: live again, and the next failure starts at 1 s again.
      cyclos.state.forced.clear();
      await waitFor(() => store.status() === "live", "retour à live");
      const before = pauses.length;
      cyclos.force("GET /push/subscribe", 503);
      cyclos.endStreams();
      await waitFor(() => pauses.length > before, "nouvelle pause");
      assert.equal(pauses[before], 1000);
    },
  );
});

// Intention: the jitter lowers the pause (between half and the whole step), never raises it above the cap.
test("listener : le hasard (jitter) reste entre la moitié du palier et le palier", () => {
  const pauses = [];
  const sleep = async (ms) => {
    pauses.push(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return withListener(
    { sleep, random: () => 0, config: { reconnectMaxSeconds: 3 }, setup: (c) => c.force("GET /push/subscribe", 500) },
    async ({ listener }) => {
      listener.start();
      await waitFor(() => pauses.length >= 4, "quatre pauses");
      assert.deepEqual(pauses.slice(0, 4), [500, 1000, 1500, 1500]);
    },
  );
});

// Intention: a cut connection (network error) is handled like a 5xx: reconnecting, growing pause, no crash.
test("listener : réseau coupé = reconnecting avec pauses, puis retour à live", () => {
  const pauses = [];
  const sleep = async (ms) => {
    pauses.push(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return withListener({ sleep, setup: (c) => c.force("GET /push/subscribe", "drop") }, async ({ cyclos, listener, store }) => {
    listener.start();
    await waitFor(() => pauses.length >= 3, "trois pauses");
    assert.equal(store.status(), "reconnecting");
    cyclos.state.forced.clear();
    await waitFor(() => store.status() === "live", "retour à live");
  });
});

// Intention: streams that end at once, again and again, are not normal: after three, a pause (no hammering of Cyclos).
test("listener : flux qui se ferment aussitôt, plusieurs fois de suite, provoquent une pause", () => {
  const pauses = [];
  const sleep = async (ms) => {
    pauses.push(ms);
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return withListener({ sleep, shortStreamMs: 10_000, setup: (c) => (c.state.push.lifetimeMs = 20) }, async ({ cyclos, listener }) => {
    listener.start();
    await waitFor(() => pauses.length >= 1, "une pause");
    assert.ok(streamCalls(cyclos).length >= 3 && streamCalls(cyclos).length <= 5, `${streamCalls(cyclos).length} flux`);
  });
});

// Intention: when the token stops working (expired on the Cyclos side), the 401 on the reopening makes ONE new login, the stream
// reopens with the same clientId and the new token, and the processor is told it follows trouble (the safety net must run).
// prepare() is not called again.
test("listener : 401 au rouvrir = nouvelle connexion, même clientId, recovered=true, sans nouveau prepare", () => {
  const opens = [];
  let prepared = 0;
  const processor = { prepare: async () => (prepared += 1), onStreamOpen: (ctx, info) => opens.push(info.recovered) };
  return withListener({ processor }, async ({ cyclos, listener, logs }) => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1, "premier flux");
    const firstToken = [...cyclos.state.tokens][0];
    cyclos.expireTokens();
    await waitFor(() => loginCalls(cyclos).length === 2, "seconde connexion");
    await waitFor(() => opens.includes(true), "ouverture après la reconnexion");
    const calls = streamCalls(cyclos);
    const last = calls[calls.length - 1];
    assert.notEqual(last.headers["session-token"], firstToken);
    assert.ok(cyclos.state.tokens.has(last.headers["session-token"]));
    for (const call of calls) assert.equal(call.query.get("clientId"), listener.clientId);
    assert.equal(prepared, 1);
    assert.ok(logs.info.includes("session Cyclos à renouveler"));
    assert.deepEqual(logs.error, []);
  });
});

// Intention: the processor can say "my call got a 401" (by throwing a PushAuthError, or by authLost()): same outcome, a new login.
test("listener : 401 vu par le processeur (exception ou authLost) = nouvelle connexion", () => {
  let mode = "throw";
  const processor = {
    onEvent: async (event, ctx) => {
      if (mode === "throw") throw new PushAuthError("401 on getTransfer");
      ctx.authLost();
    },
  };
  return withListener({ processor, setup: (c) => (c.state.push.lifetimeMs = null) }, async ({ cyclos, listener }) => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1, "flux");
    cyclos.push("accountStatus", { n: 1 });
    await waitFor(() => loginCalls(cyclos).length === 2, "reconnexion après l'exception");
    await waitFor(() => cyclos.openStreams() === 1, "flux rouvert");
    mode = "lost";
    cyclos.push("accountStatus", { n: 2 });
    await waitFor(() => loginCalls(cyclos).length === 3, "reconnexion après authLost");
    await waitFor(() => cyclos.openStreams() === 1, "flux rouvert");
  });
});

// Intention: the credentials of the very first login are refused: state "error" at once, ONE login call, no stream, the loop is over.
test("listener : identifiants refusés au premier login = error tout de suite, un seul appel, plus rien ensuite", () =>
  withListener({ credentials: { login: USER.login, password: "mauvais-mot-de-passe-de-test" } }, async ({ cyclos, listener, store, logs }) => {
    listener.start();
    await waitFor(() => store.status() === "error", "état error");
    await waitFor(() => !listener.running, "boucle terminée");
    await pause(300);
    assert.equal(loginCalls(cyclos).length, 1);
    assert.equal(streamCalls(cyclos).length, 0);
    assert.ok(logs.error.some((line) => /identifiants refusés par Cyclos \(401\)/.test(line)));
    assert.ok(!JSON.stringify(logs).includes("mauvais-mot-de-passe"));
  }));

// Intention: after a session lost, the credentials are refused again and again: after `reauthMax` (3) refused logins the state
// is "error" and the loop STOPS. The login calls are counted: the first one plus exactly three, nothing more (no hammering).
test("listener : échecs de connexion répétés = error après reauthMax essais, pas de martelage", () => {
  const pauses = [];
  const sleep = async (ms) => {
    pauses.push(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return withListener({ sleep }, async ({ cyclos, listener, store, logs }) => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1, "flux");
    cyclos.force("POST /auth/session", 401);
    cyclos.expireTokens();
    await waitFor(() => store.status() === "error", "état error");
    await waitFor(() => !listener.running, "boucle terminée");
    await pause(400);
    assert.equal(loginCalls(cyclos).length, 4, "1 + reauthMax refused logins");
    assert.ok(logs.error.some((line) => /identifiants refusés 3 fois de suite/.test(line)));
    const streamsAtEnd = streamCalls(cyclos).length;
    await pause(300);
    assert.equal(streamCalls(cyclos).length, streamsAtEnd, "nothing more after the error");
    assert.equal(loginCalls(cyclos).length, 4);
  });
});

// Intention: a token that is refused again and again although the login works (a loop) also ends in "error" after `reauthMax`.
test("listener : jeton refusé en boucle malgré une connexion réussie = error après reauthMax", () =>
  withListener({ sleep: async () => {} }, async ({ cyclos, listener, store }) => {
    cyclos.force("GET /push/subscribe", 401);
    listener.start();
    await waitFor(() => store.status() === "error", "état error");
    await pause(200);
    assert.equal(streamCalls(cyclos).length, 3);
    assert.equal(loginCalls(cyclos).length, 3);
  }));

// Intention: 403 on the stream means rights, channel or blocked account: "error", no automatic retry, and the Cyclos session is closed.
test("listener : 403 sur le flux = error, aucun nouvel essai, session Cyclos fermée", () =>
  withListener({ setup: (c) => c.force("GET /push/subscribe", 403) }, async ({ cyclos, listener, store, logs }) => {
    listener.start();
    await waitFor(() => store.status() === "error", "état error");
    await waitFor(() => cyclos.state.deleted.length === 1, "session fermée");
    await pause(300);
    assert.equal(streamCalls(cyclos).length, 1);
    assert.equal(loginCalls(cyclos).length, 1);
    assert.ok(logs.error.some((line) => /accès refusé par Cyclos \(403\)/.test(line)));
  }));

test("listener : 403 à la connexion = error, aucun nouvel essai", () =>
  withListener({ setup: (c) => c.force("POST /auth/session", 403) }, async ({ cyclos, listener, store }) => {
    listener.start();
    await waitFor(() => store.status() === "error", "état error");
    await pause(300);
    assert.equal(loginCalls(cyclos).length, 1);
    assert.equal(streamCalls(cyclos).length, 0);
  }));

// Intention: with no credentials in the configuration (nothing to try), "error", and not a single call to Cyclos.
test("listener : aucun identifiant configuré = error, aucun appel à Cyclos", async () => {
  const cyclos = await startFakeCyclos();
  const store = createTicketStore();
  const listener = createListener({
    merchantKey: "inconnu",
    config: readCaisseConfig({}, { enabled: true, login: "l", password: "p", streamWatchdogSeconds: 60, reconnectMaxSeconds: 30, reauthMax: 3 }),
    push: createCyclosPush({ baseUrl: cyclos.url }),
    store,
    log: { info() {}, error() {} },
  });
  try {
    listener.start();
    await waitFor(() => store.status() === "error", "état error");
    assert.equal(cyclos.state.requests.length, 0);
  } finally {
    await listener.stop();
    await cyclos.close();
  }
});

// Intention: stop() cuts the stream, closes the Cyclos session (DELETE), forgets the tickets, and leaves NO timer alive
// (otherwise the tests, and the server, would not end). Timers are counted by wrapping setTimeout / clearTimeout
// (without the internal idle timers of Node's HTTP client).
test("listener : arrêt propre, flux coupé, session fermée, tickets oubliés, aucune minuterie restante", async () => {
  const alive = new Set();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = realSet((...a) => {
      alive.delete(handle);
      fn(...a);
    }, ms, ...args);
    // The idle timers of Node's own HTTP client (undici) are not ours: they only keep a pooled connection for a few seconds.
    if (!new Error().stack.includes("undici")) alive.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    alive.delete(handle);
    realClear(handle);
  };
  try {
    await withListener({ setup: (c) => (c.state.push.lifetimeMs = null) }, async ({ cyclos, listener, store, logs }) => {
      listener.start();
      await waitFor(() => cyclos.openStreams() === 1, "flux ouvert");
      const token = [...cyclos.state.tokens][0];
      store.add({ transactionNumber: "T1", entityId: null, complete: true, amount: "1.00", date: null, arrivedAt: 1, source: "push", payer: "", description: "" });
      assert.equal(store.size, 1);
      assert.ok(alive.size >= 1, "the watchdog is armed while running");
      await listener.stop();
      assert.deepEqual(cyclos.state.deleted, [token]);
      assert.equal(cyclos.openStreams(), 0);
      assert.equal(store.size, 0);
      assert.equal(listener.running, false);
      await pause(300);
      assert.equal(alive.size, 0, "no timer left");
      const calls = cyclos.state.requests.length;
      await pause(300);
      assert.equal(cyclos.state.requests.length, calls, "no call after the stop");
      assert.deepEqual(logs.error, []);
    });
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

// Intention: stop() also works in the middle of a pause (a long pause is cut) and before any start.
test("listener : arrêt pendant une pause, et arrêt d'un écouteur jamais démarré", async () => {
  await withListener({ setup: (c) => c.force("GET /push/subscribe", 503), sleep: undefined, config: { reconnectMaxSeconds: 600 } }, async ({ cyclos, listener }) => {
    listener.start();
    await waitFor(() => streamCalls(cyclos).length >= 1, "premier échec");
    await pause(100);
    const started = Date.now();
    await listener.stop();
    assert.ok(Date.now() - started < 1000, "the pause of about a second was cut");
    assert.equal(streamCalls(cyclos).length, 1);
  });
  await withListener({}, async ({ listener }) => {
    await listener.stop();
    listener.start();
    assert.equal(listener.running, false, "a stopped listener does not start again");
  });
});

// Intention: stop() during the very first login: no session is left open on the Cyclos side.
test("listener : arrêt pendant la connexion, aucune session laissée ouverte", () =>
  withListener({ setup: (c) => c.force("POST /auth/session", "hang") }, async ({ cyclos, listener }) => {
    listener.start();
    await waitFor(() => loginCalls(cyclos).length === 1, "connexion en cours");
    await listener.stop();
    assert.equal(cyclos.state.tokens.size, 0);
  }));

// Intention: whatever happens (trouble, new login, error), the log holds no password, no token, no login.
test("listener : le journal ne contient ni mot de passe, ni jeton, ni identifiant", () => {
  const pauses = [];
  const sleep = async (ms) => {
    pauses.push(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return withListener({ sleep }, async ({ cyclos, listener, store, logs }) => {
    listener.start();
    await waitFor(() => cyclos.openStreams() === 1, "flux");
    const tokens = [...cyclos.state.tokens];
    cyclos.force("GET /push/subscribe", 500);
    cyclos.endStreams();
    await waitFor(() => pauses.length >= 2, "pauses");
    cyclos.state.forced.clear();
    cyclos.expireTokens();
    cyclos.force("POST /auth/session", 401);
    await waitFor(() => store.status() === "error", "état error");
    const text = JSON.stringify(logs);
    for (const secret of [USER.password, USER.login, ...tokens, clientIdOf(listener)]) {
      assert.ok(!text.includes(secret), `the log holds "${secret.slice(0, 4)}..."`);
    }
  });
});
const clientIdOf = (listener) => listener.clientId;
