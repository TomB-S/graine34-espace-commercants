// Tickets of the cash register page, in memory only: the ticket model, the
// store (de-duplication, order, bounded list) and the display strings.
//
// Rules worth knowing:
// - `amount` is ALWAYS a string ("1.00"), checked with a regular expression. There is
//   no Number() and no parseFloat anywhere: an unreadable amount makes an incomplete
//   ticket, never an invented number.
// - The same payment can arrive three ways (newNotification, accountStatus then the
//   history, and the history again). The key is the transactionNumber; an incomplete
//   ticket (made from the notification alone) is identified by its entityId and is
//   REPLACED, never doubled, when the transfer is finally read.
// - The text of the notification `message` is never used.
// - Nothing here writes to the log.
import { DateTime } from "luxon";
import { ageText } from "../web/js/age.js";

const ZONE = "Europe/Paris";
const AMOUNT_SHAPE = /^-?\d+(\.\d+)?$/;
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 300; // payer, description: a longer text is cut, the page stays readable
const NEW_MARK_MS = 60_000;
// The coloured background of the big ticket fades in this time (see .caisse-gros-neuf in style.css).
export const FRESH_FLASH_MS = 6000;
const SAME_PAYMENT_MS = 5_000; // notification date vs transfer date, when no entityId links them
const DEFAULT_SUFFIX = " G";
const DEFAULT_DECIMALS = 2;

const text = (value, max = MAX_TEXT) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// A readable positive amount (a received payment is never zero or negative).
function readableAmount(value) {
  return typeof value === "string" && AMOUNT_SHAPE.test(value) && /[1-9]/.test(value) && !value.startsWith("-");
}

// First value that is usable, looking at the currency of the transfer, then the account's.
function pickCurrency(sources) {
  let suffix = null;
  let decimals = null;
  for (const currency of sources) {
    if (suffix === null) {
      if (typeof currency?.suffix === "string") suffix = currency.suffix.slice(0, 10);
      else if (typeof currency?.symbol === "string" && currency.symbol) suffix = ` ${currency.symbol.slice(0, 10)}`;
    }
    if (decimals === null && Number.isInteger(currency?.decimalDigits) && currency.decimalDigits >= 0 && currency.decimalDigits <= 8) {
      decimals = currency.decimalDigits;
    }
  }
  return { currencySuffix: suffix ?? DEFAULT_SUFFIX, decimals: decimals ?? DEFAULT_DECIMALS };
}

// The answer of GET /transactions/{key} has its description at the root (a transfer has it in
// `transaction.description`). Put it in the transfer shape so that one builder serves both.
export function transferShapeOfTransaction(body) {
  return body && typeof body === "object" ? { ...body, transaction: { description: body.description } } : null;
}

// Builds a ticket (a draft: the store decides what to do with it).
// `notification`: the object of a newNotification event; `transfer`: the answer of GET /transfers/{id};
// `historyEntry`: a line of the account history; `fallbackCurrency`: currency of the account.
// Any of the three may be missing. `source`: "push", "history" or "initial".
export function makeTicket({ notification = null, transfer = null, historyEntry = null, entityId = null, source, arrivedAt, fallbackCurrency = null }) {
  const id = entityId === null || entityId === undefined ? null : PLAIN_ID.test(String(entityId)) ? String(entityId) : null;
  const transactionNumber = text(transfer?.transactionNumber, 60) || text(historyEntry?.transactionNumber, 60) || null;

  // Amount: the transfer first, then the history. "pending" = nobody gave one yet;
  // "unreadable" = a value came but its format is not an exact decimal.
  const candidates = [transfer?.amount, historyEntry?.amount].filter((value) => value !== undefined && value !== null);
  const good = candidates.find(readableAmount);
  const amount = good ?? null;
  const amountState = good !== undefined ? "ok" : candidates.length > 0 ? "unreadable" : "pending";

  const date = [transfer?.date, notification?.date, historyEntry?.date].map((d) => text(d, 40)).find((d) => d && DateTime.fromISO(d).isValid) ?? null;
  const payer =
    text(notification?.relatedUser?.display) || text(transfer?.from?.user?.display) || text(historyEntry?.relatedAccount?.user?.display);
  const description = text(transfer?.transaction?.description) || text(historyEntry?.description);

  return {
    transactionNumber,
    amount,
    amountState,
    ...pickCurrency([transfer?.currency, fallbackCurrency]),
    date,
    payer,
    description,
    entityId: id,
    source,
    arrivedAt,
    attempts: 0,
    complete: amount !== null && transactionNumber !== null,
  };
}

// Milliseconds of the payment date, or of the arrival when the date is missing.
function timeOf(ticket) {
  if (ticket.date) {
    const millis = DateTime.fromISO(ticket.date).toMillis();
    if (Number.isFinite(millis)) return millis;
  }
  return ticket.arrivedAt;
}

// Most recent first: payment date, then arrival.
function byRecency(a, b) {
  return timeOf(b) - timeOf(a) || b.arrivedAt - a.arrivedAt;
}

// The "New" mark: not loaded at opening, and arrived less than 60 seconds ago.
export function isNew(ticket, now) {
  return ticket.source !== "initial" && now - ticket.arrivedAt < NEW_MARK_MS;
}

// Every identifier a ticket is known by: its transaction number, its notification entity, or (neither) its arrival.
// A ticket first known by its notification gains its number later and keeps the entity key.
export function ticketKeys(ticket) {
  const keys = [];
  if (ticket.transactionNumber) keys.push(`tx:${ticket.transactionNumber}`);
  if (ticket.entityId) keys.push(`entity:${ticket.entityId}`);
  if (keys.length === 0) keys.push(`anon:${ticket.arrivedAt}:${ticket.payer}`);
  return keys;
}

// Text compared without case, accents or extra spaces ("  Virement   MOBILE pro " and "virement mobile pro" are the same).
export const normalizeText = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("fr");

// Descriptions the instance puts on a payment when the payer wrote nothing: not shown (CAISSE_HIDDEN_DESCRIPTIONS).
function isHiddenDescription(description, hidden) {
  if (!description || !hidden?.length) return false;
  const value = normalizeText(description);
  return hidden.some((item) => normalizeText(item) === value);
}

// Strings shown for a ticket, not escaped (the page escapes them). `formatAmount` is the one of
// server.js, given by the caller (it works on strings, no floating point).
export function ticketDisplay(ticket, { now, formatAmount, hiddenDescriptions = [] }) {
  const at = DateTime.fromMillis(timeOf(ticket), { zone: ZONE });
  const today = DateTime.fromMillis(now, { zone: ZONE });
  const sameDay = at.hasSame(today, "day");
  const age = ageText(at.toMillis(), now);
  return {
    // Date of the payment in milliseconds (the arrival when the date is missing), and the label without the age:
    // the script works the age out again with the same pure function (age.js, date-line.js).
    at: at.toMillis(),
    dateLabel: sameDay ? `Aujourd'hui ${at.toFormat("HH:mm")}` : at.toFormat("dd/MM HH:mm"),
    // List: "10:32" today, otherwise "12/11 17:21".
    time: sameDay ? at.toFormat("HH:mm") : at.toFormat("dd/MM HH:mm"),
    // Big ticket: "Aujourd'hui 10:33 · il y a 2 min", or "12/11 17:21" (then "· il y a N h" under 24 h).
    dateLine: `${sameDay ? `Aujourd'hui ${at.toFormat("HH:mm")}` : at.toFormat("dd/MM HH:mm")}${age ? ` · ${age}` : ""}`,
    amount: ticket.amount === null ? null : `${formatAmount(ticket.amount, ticket.decimals)}${ticket.currencySuffix}`,
    amountState: ticket.amountState,
    payer: ticket.payer,
    description: isHiddenDescription(ticket.description, hiddenDescriptions) ? "" : ticket.description,
    number: ticket.transactionNumber ?? "",
    isNew: isNew(ticket, now),
    // Only while the fade lasts: a reload after it must not replay it.
    isFresh: isNew(ticket, now) && now - ticket.arrivedAt < FRESH_FLASH_MS,
    complete: ticket.complete,
  };
}

// A set that forgets its oldest entries beyond `limit`.
function boundedSet(limit) {
  const items = new Map();
  return {
    has: (key) => items.has(key),
    add(key) {
      items.delete(key);
      items.set(key, true);
      if (items.size > limit) items.delete(items.keys().next().value);
    },
    clear: () => items.clear(),
  };
}

// The tickets of ONE merchant. `ticketsKept`: size of the list; `seenKept`: how many keys are remembered.
export function createTicketStore({ ticketsKept = 50, seenKept = 200 } = {}) {
  const tickets = new Map(); // key -> ticket; key is "tx:<number>" or "entity:<id>" or "anon:<n>"
  const seenTransactions = boundedSet(seenKept);
  const seenEntities = boundedSet(seenKept);
  let anonymous = 0;
  let connection = "starting"; // starting, live, reconnecting, degraded, error
  let fallback = false; // the "payment received" notification is off at Cyclos
  let loaded = false; // the first load of the history succeeded (what the page may take as "what was already there")
  let settleWaiters = []; // resolved when the connection leaves "starting"

  const keyOfNumber = (number) => `tx:${number}`;
  const keyOfEntity = (id) => `entity:${id}`;

  function findKey(ticket) {
    return [...tickets.entries()].find(([, candidate]) => candidate === ticket)?.[0];
  }

  // Incomplete ticket (no number) that this draft completes: same entityId, or, without
  // an entityId on one side, a single candidate with the same payer, a date within a few
  // seconds and the same amount when both have one.
  function incompleteMatching(draft) {
    const open = [...tickets.values()].filter((ticket) => ticket.transactionNumber === null);
    if (draft.entityId) {
      const exact = open.find((ticket) => ticket.entityId === draft.entityId);
      if (exact) return exact;
    }
    const close = open.filter((ticket) => {
      if (ticket.entityId && draft.entityId) return false; // both known and different
      if (!ticket.date || !draft.date || Math.abs(timeOf(ticket) - timeOf(draft)) > SAME_PAYMENT_MS) return false;
      if (ticket.payer && draft.payer && ticket.payer.toLowerCase() !== draft.payer.toLowerCase()) return false;
      if (ticket.amount !== null && draft.amount !== null && ticket.amount !== draft.amount) return false;
      return true;
    });
    return close.length === 1 ? close[0] : null;
  }

  function trim() {
    if (tickets.size <= ticketsKept) return;
    const keep = new Set([...tickets.values()].sort(byRecency).slice(0, ticketsKept));
    for (const [key, ticket] of tickets) if (!keep.has(ticket)) tickets.delete(key);
  }

  return {
    // Has a notification already been handled for this entity? (Then do not read the transfer again.)
    hasEntity: (entityId) => seenEntities.has(String(entityId)),
    markEntity(entityId) {
      if (PLAIN_ID.test(String(entityId))) seenEntities.add(String(entityId));
    },
    hasTransaction: (number) => seenTransactions.has(number),

    // Adds a draft built by makeTicket(). Returns { action, ticket }:
    // "added", "replaced" (an incomplete ticket was completed), or "duplicate" (nothing changed).
    add(draft) {
      if (draft.entityId) seenEntities.add(draft.entityId);

      if (draft.transactionNumber !== null) {
        const key = keyOfNumber(draft.transactionNumber);
        const existing = tickets.get(key);
        if (existing) {
          // Known payment. A ticket that was missing its amount is completed by a better draft.
          if (!existing.complete && draft.complete) {
            const merged = { ...draft, arrivedAt: existing.arrivedAt, source: existing.source, entityId: existing.entityId ?? draft.entityId };
            tickets.set(key, merged);
            return { action: "replaced", ticket: merged };
          }
          if (!existing.entityId && draft.entityId) existing.entityId = draft.entityId;
          return { action: "duplicate", ticket: existing };
        }
        const open = incompleteMatching(draft);
        if (open) {
          const oldKey = findKey(open);
          tickets.delete(oldKey);
          const merged = { ...draft, arrivedAt: open.arrivedAt, source: open.source, entityId: open.entityId ?? draft.entityId };
          tickets.set(key, merged);
          seenTransactions.add(draft.transactionNumber);
          return { action: "replaced", ticket: merged };
        }
        if (seenTransactions.has(draft.transactionNumber)) {
          // Seen before but pushed out of the list since: do not bring it back.
          return { action: "duplicate", ticket: draft };
        }
        tickets.set(key, draft);
        seenTransactions.add(draft.transactionNumber);
        trim();
        return { action: "added", ticket: draft };
      }

      // No number yet: an incomplete ticket, identified by its entityId.
      if (draft.entityId) {
        // Any ticket already carrying this entityId (incomplete or completed since) means the payment is known.
        const known = [...tickets.values()].find((ticket) => ticket.entityId === draft.entityId);
        if (known) return { action: "duplicate", ticket: known };
        // The payment may already be here, complete, from the history (which has no entityId): same payer and
        // a date within a few seconds, one candidate only. Then it only learns its entityId.
        const twins = [...tickets.values()].filter(
          (ticket) =>
            ticket.transactionNumber !== null &&
            !ticket.entityId &&
            ticket.date &&
            draft.date &&
            Math.abs(timeOf(ticket) - timeOf(draft)) <= SAME_PAYMENT_MS &&
            (!ticket.payer || !draft.payer || ticket.payer.toLowerCase() === draft.payer.toLowerCase()),
        );
        if (twins.length === 1) {
          twins[0].entityId = draft.entityId;
          return { action: "duplicate", ticket: twins[0] };
        }
        tickets.set(keyOfEntity(draft.entityId), draft);
      } else {
        tickets.set(`anon:${(anonymous += 1)}`, draft);
      }
      trim();
      return { action: "added", ticket: draft };
    },

    // Tickets, most recent first, never more than `ticketsKept`.
    list: () => [...tickets.values()].sort(byRecency),
    // Incomplete tickets (no number or no readable amount), for the safety net.
    incomplete: () => [...tickets.values()].filter((ticket) => !ticket.complete),
    get size() {
      return tickets.size;
    },
    // Forgets everything (the listener stops: nothing stays in memory).
    clear() {
      tickets.clear();
      seenTransactions.clear();
      seenEntities.clear();
    },

    // State of the listening, for the page.
    setConnection(value) {
      connection = value;
      if (value !== "starting") {
        const waiters = settleWaiters;
        settleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    },
    // Resolves once the listening is no longer "starting" (first load of the history done and the stream open, or failed).
    whenSettled: () => (connection !== "starting" ? Promise.resolve() : new Promise((resolve) => settleWaiters.push(resolve))),
    setLoaded(value) {
      loaded = Boolean(value);
    },
    get loaded() {
      return loaded;
    },
    setFallback(value) {
      fallback = Boolean(value);
    },
    // One state to show: the worst first. "fallback" is a live stream whose notification is off.
    status() {
      if (connection === "error" || connection === "degraded" || connection === "reconnecting" || connection === "starting") return connection;
      return fallback ? "fallback" : "live";
    },
  };
}
