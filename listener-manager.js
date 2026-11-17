// Life cycle of the listeners: one per registered merchant, started by a visit to the page,
// kept alive by the following visits, stopped when nobody comes any more or when the server stops.
//
// - Registration: the prototype has ONE registered merchant, the owner of the listening account.
//   A visitor is registered only if his Cyclos user id is the same as the listening account's
//   (never a comparison of display names). When an id cannot be read reliably, the answer is
//   "not registered" (403): refusing is the safe side. To know the id of the listening account
//   WITHOUT starting a listener, the manager logs in once with it, reads the id, and logs out
//   (no stream); the id is kept. A failure is not retried at once, and after `reauthMax`
//   failures the manager stops trying until the server restarts (no hammering of the login).
// - Several tabs or tablets = one listener (touch() only renews the delay).
// - touchAndWait() is the same visit for the JSON of the script: it waits (at most `readyWaitMs`) for a fresh listener to finish its first
//   load of the history.
// - Without a visit for `idleSeconds`, the listener is stopped: stream cut, Cyclos session closed,
//   session and tickets forgotten. The next visit starts again from the history.
// - At most `maxListeners` at the same time; beyond that, a clear refusal (503).
import { createListener, consoleLog, describeError } from "./cyclos-listener.js";
import { createPaymentProcessor } from "./payment-processor.js";
import { createTicketStore } from "./ticket-store.js";
import { PROTOTYPE_MERCHANT } from "./caisse-config.js";

const IDENTITY_RETRY_MS = 30_000;

export function createListenerManager({
  config,
  push,
  log = consoleLog(),
  now = Date.now,
  sweepIntervalMs = 10_000,
  // Longest wait of touchAndWait() for the listening to finish its first load of the history.
  readyWaitMs = 5000,
  // Test hooks passed to every listener and processor.
  listenerOptions = {},
  processorOptions = {},
}) {
  const entries = new Map(); // merchantKey -> { listener, store, lastTouch }
  const identity = { id: null, pending: null, failures: 0, nextTryAt: 0, blocked: false };
  let closed = false;

  // Id of the listening account, read once with a short session that is closed at once.
  async function resolveListenerId() {
    if (identity.id) return identity.id;
    if (identity.blocked) return null;
    if (identity.pending) return identity.pending;
    if (now() < identity.nextTryAt) return null;

    identity.pending = (async () => {
      let token = null;
      try {
        const credentials = config.credentialsFor(PROTOTYPE_MERCHANT);
        if (!credentials) return null;
        token = await push.createSession(credentials.login, credentials.password);
        const id = await push.getUserId(token);
        if (!id) throw new Error("user id unreadable");
        identity.id = id;
        identity.failures = 0;
        return id;
      } catch (error) {
        identity.failures += 1;
        identity.nextTryAt = now() + IDENTITY_RETRY_MS;
        log.error(`identité du compte d'écoute illisible : ${describeError(error)}`);
        if (identity.failures >= config.reauthMax) {
          identity.blocked = true;
          log.error(`plus aucun essai avant le redémarrage du serveur (${identity.failures} échecs)`);
        }
        return null;
      } finally {
        if (token) await push.closeSession(token);
        identity.pending = null;
      }
    })();
    return identity.pending;
  }

  async function stopEntry(key, reason) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key); // first: a visit arriving now starts a fresh listener
    await entry.listener.stop();
    if (reason) log.info(`écoute arrêtée (${reason})`);
  }

  // Stops the listeners nobody asked for during `idleSeconds`.
  function sweep(at = now()) {
    const limit = config.idleSeconds * 1000;
    const idle = [...entries].filter(([, entry]) => at - entry.lastTouch > limit).map(([key]) => key);
    return Promise.all(idle.map((key) => stopEntry(key, "inactivité")));
  }

  const timer = setInterval(() => void sweep(), sweepIntervalMs);
  timer.unref?.();

  const viewOf = (entry) => ({ status: entry.store.status(), tickets: entry.store.list(), loaded: entry.store.loaded });

  // A visit: starts the listener if there is none, renews its delay. Returns { ok: true, view } or { ok: false, status: 503 }.
  function touch(merchantKey) {
    if (closed) return { ok: false, status: 503 };
    let entry = entries.get(merchantKey);
    if (!entry) {
      if (entries.size >= config.maxListeners) {
        log.error(`plafond de ${config.maxListeners} écouteur(s) atteint`);
        return { ok: false, status: 503 };
      }
      const store = createTicketStore({ ticketsKept: config.ticketsKept });
      const processor = createPaymentProcessor({ config, push, store, log, now, ...processorOptions });
      const listener = createListener({ merchantKey, config, push, store, log, processor, now, ...listenerOptions });
      entry = { listener, store, lastTouch: now() };
      entries.set(merchantKey, entry);
      listener.start();
    }
    entry.lastTouch = now();
    return { ok: true, view: viewOf(entry) };
  }

  return {
    // Identity given by the login of the page (executable): the first account that logged in is THE merchant. Never
    // replaced afterwards. No login to Cyclos is made for it (resolveListenerId is not needed any more).
    bindIdentity(id) {
      if (typeof id === "string" && id !== "" && !identity.id) identity.id = id;
    },

    // Cyclos id of the registered merchant, or null while it is not known (read only, never triggers a login).
    get listenerId() {
      return identity.id;
    },

    // Is this visitor the registered merchant? `visitorId`: his Cyclos user id, or null when unreadable.
    // Returns { ok: true, merchantKey } | { ok: false, status: 403 | 503 }.
    async authorize(visitorId) {
      if (closed) return { ok: false, status: 503 };
      if (typeof visitorId !== "string" || visitorId === "") return { ok: false, status: 403 };
      const listenerId = await resolveListenerId();
      if (!listenerId) return { ok: false, status: 503 };
      return visitorId === listenerId ? { ok: true, merchantKey: PROTOTYPE_MERCHANT } : { ok: false, status: 403 };
    },

    touch,

    // Same visit, but when the listening has just started, waits (at most `readyWaitMs`) for it to finish its first load of the
    // history, so that the answer holds the tickets instead of an empty "starting" list. Past the delay: the answer as it is.
    async touchAndWait(merchantKey) {
      const visit = touch(merchantKey);
      if (!visit.ok) return visit;
      const entry = entries.get(merchantKey);
      if (!entry || entry.store.status() !== "starting") return visit;
      let timeout;
      await Promise.race([
        entry.store.whenSettled(),
        new Promise((resolve) => {
          timeout = setTimeout(resolve, readyWaitMs);
          timeout.unref?.();
        }),
      ]);
      clearTimeout(timeout);
      return { ok: true, view: viewOf(entry) };
    },

    sweep,
    get size() {
      return entries.size;
    },

    // Stops everything (server stop): streams cut, Cyclos sessions closed, tickets forgotten, no timer left.
    async stopAll() {
      closed = true;
      clearInterval(timer);
      await Promise.all([...entries.keys()].map((key) => stopEntry(key, null)));
      log.info("tous les écouteurs sont arrêtés");
    },
  };
}
