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
//
// Multi-merchant mode (config.multiMerchant, see caisse-config.js): there is no listening account and no single registered
// merchant. The key of a listener is the merchant's own internal Cyclos number, authorize() accepts a visitor only if the
// whitelist (CAISSE_ALLOWED_USERS) lists him, and every merchant has his own listener, store and processor: nothing is shared
// between two merchants but the code. The listeners do not all start at once: at most `startConcurrency` are loading their first
// history at the same time, the others wait in a queue (they show "starting" meanwhile). How a listener gets its Cyclos
// session is the business of config.credentialsFor(merchantKey), as in the single-merchant mode.
import { createListener, consoleLog, describeError } from "./cyclos-listener.js";
import { createPaymentProcessor } from "./payment-processor.js";
import { createTicketStore } from "./ticket-store.js";
import { PROTOTYPE_MERCHANT } from "./caisse-config.js";
import { createAllowedUsers, refusedAccountLine } from "./allowed-users.js";

// A merchant key of the multi-merchant mode is an internal Cyclos number: a plain name, nothing else.
const MERCHANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
  // Multi-merchant mode: how many listeners may be loading their first history at the same time.
  startConcurrency = 3,
}) {
  const multi = config.multiMerchant === true;
  const allowed = multi ? createAllowedUsers(config.allowedUsers) : null;
  const entries = new Map(); // merchantKey -> { listener, store, lastTouch, started, released }
  const startQueue = []; // multi mode: entries waiting for a free start slot, in order of arrival
  let starting = 0; // multi mode: start slots in use
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

  // Multi mode: gives back the start slot of an entry (once), and starts the next one waiting.
  function releaseSlot(entry) {
    if (!entry.started || entry.released) return;
    entry.released = true;
    starting -= 1;
    pump();
  }

  function pump() {
    while (starting < startConcurrency && startQueue.length > 0) {
      const entry = startQueue.shift();
      if (entries.get(entry.key) !== entry) continue; // stopped while waiting
      starting += 1;
      entry.started = true;
      entry.listener.start();
      void entry.store.whenSettled().then(() => releaseSlot(entry));
    }
  }

  async function stopEntry(key, reason) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key); // first: a visit arriving now starts a fresh listener
    const waiting = startQueue.indexOf(entry);
    if (waiting !== -1) startQueue.splice(waiting, 1);
    releaseSlot(entry);
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

  const viewOf = (entry) => ({ status: entry.store.status(), tickets: entry.store.list(), loaded: entry.store.loaded, recap: entry.store.recap });

  // A visit: starts the listener if there is none, renews its delay. Returns { ok: true, view } or { ok: false, status: 503 }.
  function touch(merchantKey) {
    if (closed) return { ok: false, status: 503 };
    if (multi && !(typeof merchantKey === "string" && MERCHANT_ID.test(merchantKey))) return { ok: false, status: 403 };
    let entry = entries.get(merchantKey);
    if (!entry) {
      if (entries.size >= config.maxListeners) {
        log.error(`plafond de ${config.maxListeners} écouteur(s) atteint`);
        return { ok: false, status: 503 };
      }
      const store = createTicketStore({ ticketsKept: config.ticketsKept });
      const processor = createPaymentProcessor({ config, push, store, log, now, ...processorOptions });
      const listener = createListener({ merchantKey, config, push, store, log, processor, now, ...listenerOptions });
      entry = { key: merchantKey, listener, store, lastTouch: now(), started: false, released: false };
      entries.set(merchantKey, entry);
      if (multi) {
        startQueue.push(entry);
        pump();
      } else {
        entry.started = true;
        entry.released = true; // no start slots in the single-merchant mode
        listener.start();
      }
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

    // Multi mode: true when CAISSE_ALLOWED_USERS has entries (the list then restricts); false = no restriction by list.
    get listRestricts() {
      return multi && allowed.size > 0;
    },

    // Is this visitor the registered merchant? `visitorId`: his Cyclos user id, or null when unreadable.
    // Returns { ok: true, merchantKey } | { ok: false, status: 403 | 503 }.
    // Multi-merchant mode: `visitorId` is { id, email } (a plain id is taken as { id }); allowed if the whitelist lists the
    // number or the e-mail address, and the key is then the visitor's own number. A refusal is logged with the number only.
    // `open` (multi mode only): the list does not restrict (it is empty), so only the identity is checked here; the caller then
    // requires the professional account.
    async authorize(visitorId, { open = false } = {}) {
      if (closed) return { ok: false, status: 503 };
      if (multi) {
        const visitor = typeof visitorId === "string" ? { id: visitorId } : (visitorId ?? {});
        if (typeof visitor.id !== "string" || !MERCHANT_ID.test(visitor.id)) return { ok: false, status: 403 };
        if (!open && !allowed.isAllowed(visitor)) {
          log.error(refusedAccountLine(visitor.id));
          return { ok: false, status: 403 };
        }
        return { ok: true, merchantKey: visitor.id };
      }
      if (typeof visitorId !== "string" || visitorId === "") return { ok: false, status: 403 };
      const listenerId = await resolveListenerId();
      if (!listenerId) return { ok: false, status: 503 };
      return visitorId === listenerId ? { ok: true, merchantKey: PROTOTYPE_MERCHANT } : { ok: false, status: 403 };
    },

    touch,

    // Multi-merchant mode: a merchant logs in again. A listener that ended in "error" or "reauth" would stay dead until the idle delay
    // (his visits keep it alive): stop it now, so that his next visit starts a fresh one with the new token. A working one is left alone.
    async restartIfStopped(merchantKey) {
      const entry = entries.get(merchantKey);
      if (!entry) return false;
      const status = entry.store.status();
      if (status !== "error" && status !== "reauth") return false;
      await stopEntry(merchantKey, "nouvelle connexion");
      return true;
    },

    // Stops the listener of one merchant now (his logout): stream cut, Cyclos session closed, tickets forgotten.
    stop: (merchantKey, reason = null) => stopEntry(merchantKey, reason),

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
