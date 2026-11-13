// What the cash register page and its data endpoint (GET /caisse/data) both show, worked out once on the server:
// the banner, the texts of a ticket (payer, amount) and the JSON for the script. Pure functions: state in, data out.
// The texts that come from Cyclos stay plain strings here; the page escapes them, the script uses textContent.
import { createHash } from "node:crypto";
import { ticketDisplay, ticketKeys } from "./ticket-store.js";
import { TEXTS } from "./caisse-texts.js";

// Payments shown: the big ticket and the list under it.
export const LIST_SIZE = 10;

// Banner of the listening: { level, text } or null. Nothing while it works (the "fallback" state, where the
// notification setting is not confirmed at Cyclos, is a live stream too). "starting" is a neutral line.
export function bannerOf(status) {
  if (status === "live" || status === "fallback") return null;
  if (status === "error") return { level: "error", text: TEXTS.unreadable };
  if (status === "reconnecting" || status === "degraded") return { level: "warning", text: TEXTS.reconnecting };
  return { level: "info", text: TEXTS.starting };
}

export const payerText = (display, hidePayerName) => (hidePayerName ? TEXTS.clientPayer : display.payer || TEXTS.noPayer);

export const amountText = (display) =>
  display.amount ?? (display.amountState === "unreadable" ? TEXTS.amountUnreadable : TEXTS.amountPending);

// Opaque key: the identifiers of Cyclos never leave the server as they are.
const opaque = (key) => `k${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;

// The JSON of GET /caisse/data. Nothing but what the page shows, plus what the script needs to follow the payments
// (keys, source, date in milliseconds). No identifier of Cyclos, no session data.
export function renderCaisseData(view, { hidePayerName, now }, { formatAmount }) {
  const tickets = view.tickets.slice(0, LIST_SIZE + 1).map((ticket) => {
    const d = ticketDisplay(ticket, { now, formatAmount });
    return {
      keys: ticketKeys(ticket).map(opaque),
      initial: ticket.source === "initial",
      payer: payerText(d, hidePayerName),
      amount: amountText(d),
      amountReady: d.amount !== null,
      time: d.time,
      dateLabel: d.dateLabel,
      at: d.at,
      description: d.description,
      number: d.number,
      isNew: d.isNew,
    };
  });
  return { status: view.status, banner: bannerOf(view.status), now, tickets };
}
