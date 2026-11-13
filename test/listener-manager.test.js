// === WHAT THIS FILE CHECKS ===
// The life cycle of the listeners (listener-manager.js), with the real listener and the fake Cyclos: the first visit starts the
// listening, a second tab does not start a second one, no visit for the idle delay stops it (stream cut, Cyclos session closed,
// tickets forgotten) and the next visit starts again from the history, a visitor who is not the registered merchant is refused
// without any listening, the ceiling of listeners, and the stop of the server. The idle delay is driven by an injected clock and
// by simulated timers (mock.timers): no real waiting. All values are fictitious. Basic notions: test/statique.test.js.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { startFakeCyclos, USER, entry } from "../test-support/fake-cyclos.js";
import { readCaisseConfig } from "../caisse-config.js";
import { createCyclosPush } from "../cyclos-push.js";
import { createListenerManager } from "../listener-manager.js";

async function waitFor(condition, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé : ${what}`);
}

// A fake Cyclos, a client and a manager with a clock the test moves by hand.
async function withManager(options, fn) {
  const { config = {}, setup, sweepIntervalMs = 3_600_000 } = options;
  const cyclos = await startFakeCyclos();
  cyclos.state.push.lifetimeMs = null;
  cyclos.addUser("autre", "mdp-autre-de-test", { id: "user-2" });
  setup?.(cyclos);
  const push = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  const clock = { at: 1_000_000, reads: 0 }; // `reads` counts how many times the manager looked at the clock
  const logs = { info: [], error: [] };
  const log = { info: (m) => logs.info.push(m), error: (m) => logs.error.push(m) };
  const conf = readCaisseConfig({}, {
    enabled: true,
    login: USER.login,
    password: USER.password,
    idleSeconds: 45,
    maxListeners: 5,
    streamWatchdogSeconds: 60,
    reconnectMaxSeconds: 30,
    reauthMax: 3,
    safetyPollSeconds: 3600,
    historyInitial: 10,
    ticketsKept: 50,
    ...config,
  });
  const manager = createListenerManager({
    config: conf,
    push,
    log,
    now: () => {
      clock.reads += 1;
      return clock.at;
    },
    sweepIntervalMs,
    listenerOptions: { shortStreamMs: 0 },
    processorOptions: { debounceMs: 50 },
  });
  try {
    await fn({ cyclos, manager, clock, logs });
  } finally {
    await manager.stopAll();
    await cyclos.close();
  }
}

const streamCalls = (cyclos) => cyclos.calls("GET", "/push/subscribe");
const loginCalls = (cyclos) => cyclos.calls("POST", "/auth/session");
const KEY = "prototype";

// Intention: the registered merchant (same Cyclos user id as the listening account) is accepted.
test("gestionnaire : le commerçant inscrit est reconnu par son identifiant utilisateur", () =>
  withManager({}, async ({ manager }) => {
    assert.deepEqual(await manager.authorize(USER.id), { ok: true, merchantKey: KEY });
  }));

// Intention: another user, or an id that cannot be read, is refused (403) and NOTHING is listened to: no listener, no stream.
test("gestionnaire : utilisateur non inscrit ou identifiant illisible = 403, aucune écoute", () =>
  withManager({}, async ({ cyclos, manager }) => {
    assert.deepEqual(await manager.authorize("user-2"), { ok: false, status: 403 });
    for (const unreadable of [null, undefined, "", 42]) {
      assert.deepEqual(await manager.authorize(unreadable), { ok: false, status: 403 }, String(unreadable));
    }
    assert.equal(manager.size, 0);
    assert.equal(streamCalls(cyclos).length, 0);
    assert.equal(cyclos.calls("GET", "/self/accounts/membre/history").length, 0);
  }));

// Intention: to know the id of the listening account the manager logs in ONCE (no stream), then closes that session; the id is kept,
// so many visits (even simultaneous ones) do not log in again.
test("gestionnaire : l'identité du compte d'écoute est lue une seule fois, session fermée aussitôt", () =>
  withManager({}, async ({ cyclos, manager }) => {
    const answers = await Promise.all([manager.authorize(USER.id), manager.authorize("user-2"), manager.authorize(USER.id)]);
    assert.deepEqual(answers.map((a) => a.ok), [true, false, true]);
    await manager.authorize(USER.id);
    assert.equal(loginCalls(cyclos).length, 1);
    assert.equal(cyclos.state.deleted.length, 1, "the short session is closed");
    assert.equal(streamCalls(cyclos).length, 0);
  }));

// Intention: if the id of the listening account cannot be read (Cyclos down), the answer is 503, not a 403 for everybody,
// no retry within 30 seconds, and after `reauthMax` failures no more tries at all (no hammering of the login).
test("gestionnaire : identité du compte d'écoute illisible = 503, pas de martelage, arrêt des essais après reauthMax", () =>
  withManager({ setup: (c) => c.force("POST /auth/session", 401) }, async ({ cyclos, manager, clock, logs }) => {
    assert.deepEqual(await manager.authorize(USER.id), { ok: false, status: 503 });
    assert.deepEqual(await manager.authorize(USER.id), { ok: false, status: 503 });
    assert.equal(loginCalls(cyclos).length, 1, "no retry within 30 s");
    clock.at += 31_000;
    await manager.authorize(USER.id);
    clock.at += 31_000;
    await manager.authorize(USER.id);
    assert.equal(loginCalls(cyclos).length, 3, "reauthMax tries");
    clock.at += 3_600_000;
    await manager.authorize(USER.id);
    assert.equal(loginCalls(cyclos).length, 3, "blocked until the server restarts");
    assert.ok(logs.error.some((l) => /plus aucun essai avant le redémarrage/.test(l)));
    assert.ok(!JSON.stringify(logs).includes(USER.password));
  }));

// Intention: an id missing from the answer of Cyclos is a failure of the same kind (never a guess, never "everybody is registered").
test("gestionnaire : identifiant absent de la réponse de Cyclos = 503", () =>
  withManager({}, async ({ cyclos, manager }) => {
    const odd = createCyclosPush({ baseUrl: cyclos.url, channel: "main", fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      return String(url).includes("/users/self") ? new Response("{}", { status: 200 }) : response;
    } });
    const strange = createListenerManager({
      config: readCaisseConfig({}, { enabled: true, login: USER.login, password: USER.password, reauthMax: 3, idleSeconds: 45, maxListeners: 5 }),
      push: odd,
      log: { info() {}, error() {} },
    });
    try {
      assert.deepEqual(await strange.authorize(USER.id), { ok: false, status: 503 });
    } finally {
      await strange.stopAll();
    }
    assert.deepEqual(await manager.authorize(USER.id), { ok: true, merchantKey: KEY });
  }));

// Intention: the first visit starts the listening and answers at once with the state "starting" (the first reload will show the payments).
test("gestionnaire : la première visite démarre l'écoute et répond tout de suite", () =>
  withManager({}, async ({ cyclos, manager }) => {
    const first = manager.touch(KEY);
    assert.equal(first.ok, true);
    assert.equal(first.view.status, "starting");
    assert.deepEqual(first.view.tickets, []);
    assert.equal(manager.size, 1);
    await waitFor(() => cyclos.openStreams() === 1, "flux ouvert");
    assert.equal(manager.touch(KEY).view.status, "live");
  }));

// Intention: a second visit (another tab, another tablet) does NOT start a second listener: one login, one stream.
test("gestionnaire : deux onglets, un seul écouteur (une connexion, un flux)", () =>
  withManager({}, async ({ cyclos, manager }) => {
    manager.touch(KEY);
    manager.touch(KEY);
    await waitFor(() => cyclos.openStreams() === 1, "flux ouvert");
    manager.touch(KEY);
    manager.touch(KEY);
    assert.equal(manager.size, 1);
    assert.equal(loginCalls(cyclos).length, 1);
    assert.equal(streamCalls(cyclos).length, 1);
  }));

// Intention: the tickets of the listener come back through touch(): the opening loads the history.
test("gestionnaire : la visite suivante voit les paiements chargés depuis l'historique", () =>
  withManager({ setup: (c) => (c.state.entries = [entry(2, { amount: "2.00" }), entry(1, { amount: "1.00" })]) }, async ({ manager }) => {
    manager.touch(KEY);
    await waitFor(() => manager.touch(KEY).view.status === "live", "état live");
    const { view } = manager.touch(KEY);
    assert.deepEqual(view.tickets.map((t) => t.amount), ["2.00", "1.00"]);
  }));

// Intention: no visit for the idle delay (45 s) stops the listener: stream cut, Cyclos session closed (DELETE), tickets forgotten.
// Just before the delay, nothing is stopped; a visit renews the delay.
test("gestionnaire : inactivité de 45 s = flux coupé, session fermée, tickets oubliés ; une visite relance le délai", () =>
  withManager({ setup: (c) => (c.state.entries = [entry(1, { amount: "1.00" })]) }, async ({ cyclos, manager, clock, logs }) => {
    manager.touch(KEY);
    await waitFor(() => cyclos.openStreams() === 1 && manager.touch(KEY).view.tickets.length === 1, "écoute active");
    const token = [...cyclos.state.tokens][0];

    clock.at += 44_000;
    await manager.sweep();
    assert.equal(manager.size, 1, "44 s: still listening");
    manager.touch(KEY); // renews the delay
    clock.at += 44_000;
    await manager.sweep();
    assert.equal(manager.size, 1, "44 s after the last visit: still listening");

    clock.at += 2_000;
    await manager.sweep();
    assert.equal(manager.size, 0);
    assert.deepEqual(cyclos.state.deleted, [token]);
    assert.equal(cyclos.openStreams(), 0);
    assert.ok(logs.info.includes("écoute arrêtée (inactivité)"));
    assert.ok(!JSON.stringify(logs).includes(token));
  }));

// Intention: after the stop, a new visit starts from the beginning: a new login, a new first load of the history.
test("gestionnaire : réouverture après l'arrêt = nouvelle connexion et historique rechargé", () =>
  withManager({ setup: (c) => (c.state.entries = [entry(1, { amount: "1.00" })]) }, async ({ cyclos, manager, clock }) => {
    manager.touch(KEY);
    await waitFor(() => manager.touch(KEY).view.tickets.length === 1, "premier chargement");
    const logins = loginCalls(cyclos).length;
    const histories = cyclos.calls("GET", "/self/accounts/membre/history").length;
    clock.at += 46_000;
    await manager.sweep();
    assert.equal(manager.size, 0);
    assert.deepEqual(manager.touch(KEY).view.tickets, [], "nothing was kept in memory");
    await waitFor(() => manager.touch(KEY).view.tickets.length === 1, "paiement revenu par l'historique");
    assert.equal(loginCalls(cyclos).length, logins + 1);
    assert.equal(cyclos.calls("GET", "/self/accounts/membre/history").length, histories + 1);
    assert.equal(manager.touch(KEY).view.tickets[0].source, "initial");
  }));

// Intention: the sweep is run by a timer every 10 s (here simulated: no real waiting), and a visit every 5 s keeps the listener alive.
test("gestionnaire : minuterie de 10 s (simulée) qui arrête l'écoute inactive, et arrêt de la minuterie à stopAll", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    await withManager({ sweepIntervalMs: 10_000 }, async ({ cyclos, manager, clock }) => {
      manager.touch(KEY);
      await waitFor(() => cyclos.openStreams() === 1, "flux ouvert");
      // A visit every 5 s: never idle.
      for (let i = 0; i < 6; i += 1) {
        clock.at += 5_000;
        manager.touch(KEY);
        if (i % 2 === 1) mock.timers.tick(10_000);
      }
      assert.equal(manager.size, 1);
      // Then nobody comes: 50 s later the next tick of the timer stops it.
      clock.at += 50_000;
      mock.timers.tick(10_000);
      await waitFor(() => manager.size === 0 && cyclos.state.deleted.length === 1, "arrêt par la minuterie");

      // After stopAll(), the timer is gone: a tick does not even look at the clock (a live timer would call sweep, which reads it).
      await manager.stopAll();
      const reads = clock.reads;
      mock.timers.tick(10_000);
      mock.timers.tick(10_000);
      assert.equal(clock.reads, reads, "no sweep after stopAll");
    });
  } finally {
    mock.timers.reset();
  }
});

// Intention: at most `maxListeners` listeners at the same time; beyond that a clear refusal (503), and a free slot is reusable.
test("gestionnaire : plafond d'écouteurs atteint = 503", () =>
  withManager({ config: { maxListeners: 2 } }, async ({ manager, clock, logs }) => {
    assert.equal(manager.touch("a").ok, true);
    assert.equal(manager.touch("b").ok, true);
    assert.deepEqual(manager.touch("c"), { ok: false, status: 503 });
    assert.equal(manager.touch("a").ok, true, "an existing listener is still served");
    assert.equal(manager.size, 2);
    assert.ok(logs.error.some((l) => /plafond de 2 écouteur\(s\) atteint/.test(l)));
    clock.at += 46_000;
    await manager.sweep();
    assert.equal(manager.touch("c").ok, true, "a slot is free again");
  }));

// Intention: stopping the server stops every listener: streams cut, Cyclos sessions closed, tickets forgotten, and no new visit
// is accepted afterwards.
test("gestionnaire : stopAll coupe les flux, ferme les sessions, refuse ensuite toute visite", () =>
  withManager({}, async ({ cyclos, manager }) => {
    manager.touch(KEY);
    await waitFor(() => cyclos.openStreams() === 1, "flux ouvert");
    const token = [...cyclos.state.tokens][0];
    await manager.stopAll();
    assert.equal(manager.size, 0);
    assert.equal(cyclos.openStreams(), 0);
    assert.ok(cyclos.state.deleted.includes(token));
    assert.deepEqual(manager.touch(KEY), { ok: false, status: 503 });
    assert.deepEqual(await manager.authorize(USER.id), { ok: false, status: 503 });
  }));

// Intention: a listener that ended in "error" (credentials refused) is still served as such: the page can say so; and it is
// stopped like any other when nobody comes.
test("gestionnaire : un écouteur en erreur reste servi (état error) puis s'arrête comme les autres", () =>
  withManager({ setup: (c) => c.force("POST /auth/session", 401) }, async ({ manager, clock }) => {
    manager.touch(KEY);
    await waitFor(() => manager.touch(KEY).view.status === "error", "état error");
    clock.at += 46_000;
    await manager.sweep();
    assert.equal(manager.size, 0);
  }));
