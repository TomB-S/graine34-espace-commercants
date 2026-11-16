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

// Short name of the payer: first name + initial of the family name ("Marie D."). `order` is the order of the words in
// the name as Cyclos writes it:
//   "nom-prenom" (default), "Dupont Marie": the first name is the LAST word, the family name is everything before it
//     and its initial is the one of its first word ("De La Fontaine Marie" -> "Marie D.");
//   "prenom-nom", "Marie Dupont": the first name is the FIRST word, the initial is the one of the last word.
// A hyphenated first name is one word ("Jean-Pierre"). A single word stays as it is, and so does a name whose two
// words used do not start with a letter ("Client 1"). Letters only: nothing else is ever cut into pieces.
export function shortPayerName(name, order = "nom-prenom") {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return words[0] ?? "";
  const [firstName, familyWord] = order === "prenom-nom" ? [words[0], words[words.length - 1]] : [words[words.length - 1], words[0]];
  const [initial] = Array.from(familyWord);
  const [firstLetter] = Array.from(firstName);
  if (!/^\p{L}$/u.test(initial) || !/^\p{L}$/u.test(firstLetter)) return words.join(" ");
  return `${firstName} ${initial.toLocaleUpperCase("fr")}.`;
}

export const payerText = (display, hidePayerName, nameOrder) => (hidePayerName ? TEXTS.clientPayer : shortPayerName(display.payer, nameOrder) || TEXTS.noPayer);

export const amountText = (display) =>
  display.amount ?? (display.amountState === "unreadable" ? TEXTS.amountUnreadable : TEXTS.amountPending);

// Opaque key: the identifiers of Cyclos never leave the server as they are.
const opaque = (key) => `k${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;

// The JSON of GET /caisse/data. Nothing but what the page shows, plus what the script needs to follow the payments
// (keys, source, date in milliseconds). No identifier of Cyclos, no session data.
export function renderCaisseData(view, { hidePayerName, nameOrder, hiddenDescriptions, now }, { formatAmount }) {
  const tickets = view.tickets.slice(0, LIST_SIZE + 1).map((ticket) => {
    const d = ticketDisplay(ticket, { now, formatAmount, hiddenDescriptions });
    return {
      keys: ticketKeys(ticket).map(opaque),
      initial: ticket.source === "initial",
      payer: payerText(d, hidePayerName, nameOrder),
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
  // `loaded`: the first load of the history is done, so the page may take what it sees as "already there" (see new-payments.js).
  return { status: view.status, banner: bannerOf(view.status), now, loaded: view.loaded === true, tickets };
}
