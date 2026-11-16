// What the listener does with what it hears: turn a "payment received" notification into a ticket,
// and the "safety net" that reads the history so that no payment is missed.
//
// Why a safety net: the stream can lose events (a cut longer than a few minutes is not replayed
// by Cyclos), `accountStatus` carries no payment detail, a transfer can fail to be read. The history of
// the account is the one source that always has the payment.
//
// reconcile() reads the latest credits and adds the ones not known yet. It never removes a ticket.
// Never two at the same time for one merchant: a second request while one runs is noted ONCE and
// replayed after. Triggers:
//   1. opening of the listening (first load: tickets marked "initial", never "New");
//   2. the stream is back after a cut, a silence or a new login (`recovered`);
//   3. (same as 2, the new login makes the listener say `recovered`);
//   4. an `accountStatus` event, one second later, grouped (a burst gives one reconcile);
//   5. a payment notification with an unknown entityType, or whose transfer could not be read
//      (then at most 3 more tries per incomplete ticket);
//   6. every `safetyPollSeconds`, but not while the stream is being reopened.
//
// Nothing from Cyclos (payer, amount, description, identifiers) is written to the log: only counts,
// kinds of events and HTTP statuses.
import { PushAuthError } from "./cyclos-push.js";
import { describeError } from "./cyclos-listener.js";
import { makeTicket, transferShapeOfTransaction } from "./ticket-store.js";

const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
const SAFETY_PAGE_SIZE = 20;

// An entry of the history that is clearly a debit (in case the server did not apply `direction=credit`).
const isDebit = (line) => typeof line?.amount === "string" && line.amount.trim().startsWith("-");

export function createPaymentProcessor({
  config,
  push,
  store,
  log,
  now = Date.now,
  debounceMs = 1000,
  retryDelaysMs = [2000, 5000, 15000], // one entry per allowed retry: 3 tries at most per incomplete ticket
}) {
  let ctx = null;
  let stopped = false;
  let accountType = config.accountType ?? null;
  let currency = null;
  let initialPending = true; // the first successful read of the history marks tickets "initial"
  let running = false;
  let again = false;
  let debounce = { timer: null, dueAt: 0 };
  let poll = null;
  const stats = { ignored: 0 };

  // Finds the type and the currency of the account (same rule as the statement), unless configured.
  async function ensureAccount(token) {
    if (accountType && currency) return;
    const account = await push.getAccount(token);
    if (!account) return;
    currency ??= account.currency;
    accountType ??= account.accountType;
  }

  // Reads the latest credits and adds the new ones. Throws on any error: callers decide.
  async function syncHistory(token) {
    await ensureAccount(token);
    if (!accountType) {
      log.error("aucun compte lisible, historique ignoré");
      return;
    }
    const credits = await push.getRecentCredits(token, {
      accountType,
      pageSize: initialPending ? config.historyInitial : SAFETY_PAGE_SIZE,
    });
    if (stopped) return;
    const source = initialPending ? "initial" : "history";
    let added = 0;
    let completed = 0;
    // Oldest first, so that the arrival order follows the payment order.
    for (const line of [...credits].reverse()) {
      if (isDebit(line)) continue;
      const result = store.add(makeTicket({ historyEntry: line, source, arrivedAt: now(), fallbackCurrency: currency }));
      if (result.action === "added") added += 1;
      else if (result.action === "replaced") completed += 1;
    }
    initialPending = false;
    store.setLoaded(true);
    if (source === "initial") log.info(`chargement initial : ${added} paiement(s)`);
    else if (added + completed > 0) log.info(`filet de sécurité : ${added} paiement(s) rattrapé(s), ${completed} ticket(s) complété(s)`);
  }

  // After a reconcile: the incomplete tickets made from a notification get a few more tries, each later than the last.
  function planRetries() {
    if (stopped) return;
    const open = store.incomplete().filter((ticket) => ticket.entityId && ticket.attempts < retryDelaysMs.length);
    if (open.length === 0) return;
    const attempt = Math.min(...open.map((ticket) => ticket.attempts));
    for (const ticket of open) ticket.attempts += 1;
    scheduleReconcile(retryDelaysMs[attempt]);
  }

  async function reconcileOnce() {
    const token = ctx?.token();
    if (!token) return; // being logged in again: the "recovered" reconcile will follow
    try {
      await syncHistory(token);
    } catch (error) {
      if (error instanceof PushAuthError) {
        ctx.authLost();
        return;
      }
      log.error(`lecture de l'historique en échec : ${describeError(error)}`);
    }
    planRetries();
  }

  // Never two at once; a request made while one runs is noted once and replayed after.
  async function reconcile() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await reconcileOnce();
      } while (again && !stopped);
    } catch (error) {
      log.error(`erreur du filet de sécurité : ${describeError(error)}`);
    } finally {
      running = false;
    }
  }

  // Asks for a reconcile in `delayMs`. If one is already planned sooner, that one is enough
  // (a burst of events gives a single reconcile).
  function scheduleReconcile(delayMs) {
    if (stopped) return;
    const dueAt = now() + delayMs;
    if (debounce.timer && debounce.dueAt <= dueAt) return;
    clearTimeout(debounce.timer);
    const timer = setTimeout(() => {
      debounce = { timer: null, dueAt: 0 };
      void reconcile();
    }, delayMs);
    timer.unref?.();
    debounce = { timer, dueAt };
  }

  // A "payment received" notification.
  async function onPayment(notification) {
    const entityId = PLAIN_ID.test(String(notification.entityId ?? "")) ? String(notification.entityId) : null;
    const entityType = typeof notification.entityType === "string" ? notification.entityType : null;

    // Already handled (the same notification again): no second call.
    if (entityId && store.hasEntity(entityId)) return;

    if (!entityId || (entityType !== "transfer" && entityType !== "transaction")) {
      // Unknown kind of entity: no route is called, the history is the only source.
      log.info(`notification de paiement d'un type d'entité inattendu (${entityType && PLAIN_NAME.test(entityType) ? entityType : "illisible"}), lecture de l'historique`);
      scheduleReconcile(0);
      return;
    }

    let transfer = null;
    const token = ctx?.token();
    if (token) {
      try {
        // A transfer id goes to /transfers, a transaction id to /transactions: never the other way round.
        transfer =
          entityType === "transfer"
            ? await push.getTransfer(token, entityId)
            : transferShapeOfTransaction(await push.getTransaction(token, entityId));
      } catch (error) {
        if (error instanceof PushAuthError) throw error;
        log.error(`lecture du détail impossible (${entityType}) : ${describeError(error)}`);
      }
    }

    const ticket = makeTicket({ notification, transfer, entityId, source: "push", arrivedAt: now(), fallbackCurrency: currency });
    const result = store.add(ticket);
    if (result.action !== "duplicate") log.info(`paiement reçu par notification (${result.ticket.complete ? "complet" : "incomplet"})`);
    // Incomplete (transfer unreadable): the history completes it, now, then a few more times.
    if (!result.ticket.complete) scheduleReconcile(0);
  }

  return {
    stats,

    // After the first login: notification setting (read only), account, first load of the history.
    async prepare(ctxArg) {
      ctx = ctxArg;
      const token = ctx.token();

      let enabled = null;
      try {
        enabled = await push.getPaymentReceivedSetting(token);
      } catch (error) {
        if (error instanceof PushAuthError) throw error;
        log.error(`lecture du réglage de notification impossible : ${describeError(error)}`);
      }
      store.setFallback(enabled !== true);
      if (enabled !== true) {
        log.info("attention : notification de paiement reçu désactivée ou inconnue, mode de secours (rien n'est modifié côté Cyclos)");
      }

      try {
        await syncHistory(token);
      } catch (error) {
        if (error instanceof PushAuthError) throw error;
        log.error(`chargement initial impossible : ${describeError(error)}`); // retried by the next trigger
      }

      poll = setInterval(() => {
        if (!stopped && ctx && !ctx.isReopening() && ctx.token()) void reconcile();
      }, config.safetyPollSeconds * 1000);
      poll.unref?.();
    },

    async onEvent(event, ctxArg) {
      ctx = ctxArg;
      if (event.kind === "accountStatus") {
        // No payment detail inside: only a trigger. Also arrives for an outgoing payment (then nothing is found).
        scheduleReconcile(debounceMs);
        return;
      }
      if (event.kind !== "newNotification") return;
      const notification = event.data?.notification;
      if (!notification || typeof notification !== "object" || notification.type !== "paymentReceived") {
        stats.ignored += 1; // other notifications, and paymentReceivedChargedBack (refunds are not handled)
        return;
      }
      await onPayment(notification);
    },

    onStreamOpen(ctxArg, { recovered }) {
      ctx = ctxArg;
      if (recovered) void reconcile();
    },

    // Exposed for the tests and for a manual refresh.
    reconcile,

    stop() {
      stopped = true;
      clearTimeout(debounce.timer);
      debounce = { timer: null, dueAt: 0 };
      clearInterval(poll);
      poll = null;
    },
  };
}
