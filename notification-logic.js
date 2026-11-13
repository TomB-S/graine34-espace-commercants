// What to notify and what to say about the notifications: pure logic, no browser API, no timer, no import but the fixed
// texts, so that the browser loads this very file and the tests run it as it is. The browser API is in notification.js,
// the button in caisse-view.js.
//
// A notification NEVER carries the description nor the transaction number (a notification can show on a locked screen):
// only the amount and the payer, written like the page writes them (the server already applied CAISSE_HIDE_PAYER_NAME).
import { TEXTS } from "./caisse-texts.js";

// More new payments than this in one reading: one single notification "N nouveaux paiements".
export const MAX_SEPARATE = 3;
// A new payment whose amount is not read yet waits this long at most (milliseconds), then goes out as it is.
export const MAX_WAIT_MS = 15_000;

// `state`: { supported, secure, permission } where permission is "default", "granted" or "denied".
// Returns what the page shows: the line of state, the button label (null = no button) and whether they are on.
export function notificationLabel({ supported, secure, permission }) {
  if (!supported) return { text: TEXTS.notificationUnsupported, buttonText: null, active: false };
  if (!secure) return { text: TEXTS.notificationInsecure, buttonText: null, active: false };
  if (permission === "granted") return { text: TEXTS.notificationOn, buttonText: null, active: true };
  if (permission === "denied") return { text: TEXTS.notificationDenied, buttonText: null, active: false };
  return { text: TEXTS.notificationOff, buttonText: TEXTS.notificationEnableButton, active: false };
}

export function canNotify({ supported, secure, permission }) {
  return Boolean(supported && secure && permission === "granted");
}

// The title of one payment: "Paiement reçu : 7,50 G" (just "Paiement reçu" while the amount is not known) and its body:
// "de Payeur 9" ("de Client" when the server hid the payer). Never the description nor the number.
export function paymentTitle(ticket) {
  return ticket.amountReady ? `${TEXTS.notificationTitle} : ${ticket.amount}` : TEXTS.notificationTitle;
}

export function paymentBody(ticket) {
  return `de ${ticket.payer}`;
}

// From the tickets to announce (most recent first, as the detector gives them) to the notifications to show:
// { title, body, tag }. `tag` is the opaque key of the payment, so that the same payment never shows twice.
export function planNotifications(tickets) {
  if (!Array.isArray(tickets) || tickets.length === 0) return [];
  const withKey = tickets.filter((ticket) => Array.isArray(ticket.keys) && ticket.keys.length > 0);
  if (withKey.length === 0) return [];
  if (withKey.length > MAX_SEPARATE) {
    return [
      {
        title: `${withKey.length} nouveaux paiements`,
        body: TEXTS.notificationsOpenCash,
        tag: `lot-${withKey[0].keys[0]}`,
      },
    ];
  }
  // Oldest first, so that the most recent payment is the one left on top.
  return [...withKey].reverse().map((ticket) => ({ title: paymentTitle(ticket), body: paymentBody(ticket), tag: ticket.keys[0] }));
}

// Holds back the new payments whose amount is not read yet (the page sometimes knows a payment before its amount). The payments of one
// reading are one batch: it goes out when every amount is known, or after MAX_WAIT_MS as it is. Keeping the batch together is what makes
// "more than 3 at once" one single notification. Pure: time and tickets are given.
export function createNotificationPlanner({ maxWaitMs = MAX_WAIT_MS } = {}) {
  let groups = []; // { tickets, since }

  const sameTicket = (a, b) => a === b || (Array.isArray(a.keys) && Array.isArray(b.keys) && a.keys.some((key) => b.keys.includes(key)));

  return {
    // `fresh`: the new tickets of this reading; `current`: every ticket of this reading; `nowMs`: the clock.
    // Returns the notifications to show now.
    update(fresh, current, nowMs) {
      if (fresh.length > 0) groups.push({ tickets: [...fresh], since: nowMs });
      const out = [];
      groups = groups.filter((group) => {
        // The latest version of each ticket (a ticket completed since has its amount now).
        const latest = group.tickets.map((ticket) => current.find((candidate) => sameTicket(candidate, ticket)) ?? ticket);
        if (latest.every((ticket) => ticket.amountReady) || nowMs - group.since >= maxWaitMs) {
          out.push(...latest);
          return false;
        }
        group.tickets = latest;
        return true;
      });
      // Most recent first, as the detector gives them: the order of the current list.
      const rank = (ticket) => {
        const index = current.findIndex((candidate) => sameTicket(candidate, ticket));
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
      };
      out.sort((a, b) => rank(a) - rank(b));
      return planNotifications(out);
    },
    // Number of payments held back.
    get waiting() {
      return groups.reduce((total, group) => total + group.tickets.length, 0);
    },
  };
}
