// Statement of transactions (/espace/releve): the pure part. No network, no server, no state: values in, values out.
// Date ranges typed in the filter form (Paris time), amounts in exact integers (BigInt), summary totals and the content of the
// ticket as plain strings, shared by the HTML page and the PDF so that both always show the same thing.
import { DateTime } from "luxon";
import { formatAmount } from "./format.js";

export const ZONE = "Europe/Paris";

// Format of <input type="datetime-local"> values (no seconds, no zone).
export const INPUT_FORMAT = "yyyy-MM-dd'T'HH:mm";
const INPUT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export const MAX_RANGE_DAYS = 31;
// The transaction list is read page by page, up to maxRows lines in total.
export const DEFAULT_PAGE_SIZE = 200;
export const DEFAULT_MAX_ROWS = 2000;

// Reading limits from the environment: a positive whole number, otherwise the default.
export function readHistoryLimits(env = process.env) {
  const whole = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return { pageSize: whole("HISTORY_PAGE_SIZE", DEFAULT_PAGE_SIZE), maxRows: whole("HISTORY_MAX_ROWS", DEFAULT_MAX_ROWS) };
}

// ---------------------------------------------------------------------------------------------------------------
// Date ranges

// Default and preset ranges for the filter form, in ZONE wall-clock time.
// An unknown preset is ignored (same as no preset: today so far).
export function presetRange(preset, now = DateTime.now().setZone(ZONE)) {
  const minute = now.startOf("minute");
  switch (preset) {
    case "hier": {
      const yesterday = minute.minus({ days: 1 });
      return {
        start: yesterday.startOf("day"),
        end: yesterday.set({ hour: 23, minute: 59 }),
      };
    }
    case "6h":
      return { start: minute.minus({ hours: 6 }), end: minute };
    default:
      return { start: minute.startOf("day"), end: minute };
  }
}

// Field values of the filter form for a range computed by the server.
export function rangeValues({ start, end }) {
  return { start: start.toFormat(INPUT_FORMAT), end: end.toFormat(INPUT_FORMAT) };
}

// Parses one submitted datetime-local value. `label` ("début"/"fin") is used in messages. Returns { value } or { error }.
export function parseInstant(text, label) {
  if (!INPUT_SHAPE.test(text ?? "")) {
    return {
      error: `Date de ${label} invalide : le format attendu est AAAA-MM-JJThh:mm (par exemple 2026-11-05T22:00).`,
    };
  }
  const value = DateTime.fromFormat(text, INPUT_FORMAT, { zone: ZONE });
  if (!value.isValid) {
    return { error: `La date de ${label} n'existe pas dans le calendrier.` };
  }
  // Luxon silently moves a time that falls in a DST gap (02:30 on the spring change day becomes 03:30). If formatting back
  // gives something else, the wall-clock time the user typed does not exist.
  if (value.toFormat(INPUT_FORMAT) !== text) {
    return {
      error: `L'heure de ${label} saisie (${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)} à ${text.slice(11)}) n'existe pas : elle est sautée lors du passage à l'heure d'été. Choisissez une autre heure.`,
    };
  }
  return { value };
}

// Validates the submitted range. Returns { error } or { from, to, until, clamped }: `to` is the end shown to the user, `until` the
// end sent to Cyclos (the whole last minute is included, so a range ending at 23:59 contains 23:59:30), `clamped` tells that a
// future end was brought back to now.
export function parseRange(startText, endText, now = DateTime.now().setZone(ZONE)) {
  const start = parseInstant(startText, "début");
  if (start.error) return start;
  const end = parseInstant(endText, "fin");
  if (end.error) return end;

  const from = start.value;
  if (from > now) {
    return { error: "Le début ne peut pas être dans le futur." };
  }

  let to = end.value;
  let until = to.plus({ minutes: 1 }).minus({ milliseconds: 1 });
  // A future end is accepted but cannot report anything beyond this instant.
  const clamped = until > now;
  if (clamped) {
    to = now.startOf("minute");
    until = now;
  }

  if (clamped ? until <= from : to <= from) {
    return { error: "La fin doit être après le début." };
  }
  if (to > from.plus({ days: MAX_RANGE_DAYS })) {
    return {
      error: `La plage ne peut pas dépasser ${MAX_RANGE_DAYS} jours.`,
    };
  }
  return { from, to, until, clamped };
}

// ---------------------------------------------------------------------------------------------------------------
// Amounts

// Exact decimal arithmetic for amounts: "10.25" with 2 digits -> 1025n (smallest currency unit). Returns null for anything that is
// not a plain decimal or that is finer than `digits` (nothing is rounded: the caller must not invent a total).
export function toUnits(value, digits) {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const [, minus, integer, decimals = ""] = match;
  if (/[^0]/.test(decimals.slice(digits))) return null;
  const units = BigInt(integer + decimals.slice(0, digits).padEnd(digits, "0"));
  return minus ? -units : units;
}

export function fromUnits(units, digits) {
  const negative = units < 0n;
  const text = (negative ? -units : units).toString().padStart(digits + 1, "0");
  const cut = text.length - digits;
  const decimals = digits > 0 ? `.${text.slice(cut)}` : "";
  return `${negative ? "-" : ""}${text.slice(0, cut)}${decimals}`;
}

// Totals of a complete list of entries, in the shape of Cyclos' status indicators: incoming = positive amounts, outgoing = absolute
// value of the negative ones. Returns null if an amount cannot be read exactly.
export function totalsFromEntries(entries, digits) {
  let inSum = 0n;
  let outSum = 0n;
  let inCount = 0;
  let outCount = 0;
  for (const entry of entries) {
    const units = toUnits(entry?.amount, digits);
    if (units === null) return null;
    if (units > 0n) {
      inSum += units;
      inCount += 1;
    } else if (units < 0n) {
      outSum -= units;
      outCount += 1;
    }
  }
  return {
    incoming: { count: inCount, sum: fromUnits(inSum, digits) },
    outgoing: { count: outCount, sum: fromUnits(outSum, digits) },
    netInflow: fromUnits(inSum - outSum, digits),
  };
}

// Some Cyclos instances answer without the incoming/outgoing indicators. The totals are then computed from the entries, but only
// when the list is complete: a truncated list would give wrong totals. Without a usable result the totals are left as they are
// (the ticket then says "Non disponible").
export function withComputedTotals(totals, entries, truncated, digits) {
  const status = totals?.status;
  if (status?.incoming && status?.outgoing) return totals;
  if (truncated) return totals;
  const computed = totalsFromEntries(entries, digits);
  return computed ? { ...totals, status: { ...status, ...computed } } : totals;
}

// ---------------------------------------------------------------------------------------------------------------
// Ticket

function plural(count, one, many) {
  return `${count} ${count > 1 ? many : one}`;
}

// Who is on the other side of a transaction (a member, or a system account).
function counterparty(entry) {
  const related = entry.relatedAccount;
  return related?.user?.display ?? related?.type?.name ?? "";
}

// The content of the ticket as plain strings (not escaped). `maxRows`: the limit the list was read with (for the warning text).
export function ticketModel(
  { from, to, totals, entries, truncated, merchantName, currency, maxRows = DEFAULT_MAX_ROWS },
  now = DateTime.now().setZone(ZONE),
) {
  const digits = currency?.decimalDigits ?? 2;
  // Read defensively: the indicators may be missing (see withComputedTotals). They are only usable when both sums are exact
  // decimals; otherwise the three summary lines say "Non disponible" rather than showing an invented number.
  const status = totals?.status;
  const incoming = status?.incoming;
  const outgoing = status?.outgoing;
  const inUnits = toUnits(incoming?.sum, digits);
  const outUnits = toUnits(outgoing?.sum, digits);
  const available = inUnits !== null && outUnits !== null;
  const net = !available ? null : (status.netInflow ?? fromUnits(inUnits - outUnits, digits));
  const NOT_AVAILABLE = "Non disponible";
  const countLabel = (stat, one, many, bare) => (Number.isInteger(stat?.count) ? plural(stat.count, one, many) : bare);

  // Cyclos answers most recent first; the ticket reads oldest first.
  const ordered = [...entries].reverse().sort((a, b) => a.date.localeCompare(b.date));

  return {
    title: "Ticket de fin de service",
    merchantName,
    period: `Du ${from.toFormat("dd/MM/yyyy HH:mm")} au ${to.toFormat("dd/MM/yyyy HH:mm")}`,
    generated: `Ticket généré le ${now.toFormat("dd/MM/yyyy 'à' HH:mm")}`,
    unit: `Montants en ${currency?.name ?? ""}`,
    summary: [
      {
        label: countLabel(incoming, "paiement reçu", "paiements reçus", "Paiements reçus"),
        value: available ? formatAmount(incoming.sum, digits) : NOT_AVAILABLE,
      },
      {
        label: countLabel(outgoing, "paiement sorti", "paiements sortis", "Paiements sortis"),
        value: available ? formatAmount(outgoing.sum, digits) : NOT_AVAILABLE,
      },
      {
        label: "Solde net",
        value: available ? formatAmount(net, digits, { signed: true }) : NOT_AVAILABLE,
        net: true,
      },
    ],
    rows: ordered.map((entry) => ({
      // Each stored instant is rendered back into Paris wall-clock time.
      when: DateTime.fromISO(entry.date).setZone(ZONE).toFormat("dd/MM HH:mm"),
      number: entry.transactionNumber ?? "",
      counterparty: counterparty(entry),
      description: entry.description ?? "",
      amount: formatAmount(entry.amount, digits, { signed: true }),
    })),
    warning: truncated
      ? available
        ? `Attention : la liste est limitée aux ${maxRows} transactions les plus récentes de la plage, les plus anciennes ne sont pas affichées. Les totaux du résumé restent exacts : ils sont calculés par Cyclos sur toute la plage, pas à partir de cette liste.`
        : `Attention : la liste est limitée aux ${maxRows} transactions les plus récentes de la plage, les plus anciennes ne sont pas affichées. Les totaux du résumé ne peuvent pas être calculés au-delà de ${maxRows} transactions : ils sont indiqués « Non disponible ». Réduisez la plage pour les obtenir.`
      : available
        ? ""
        : "Attention : les totaux du résumé n'ont pas pu être déterminés (« Non disponible »). Le détail des transactions reste exact.",
    emptyText: "Aucune transaction sur cette plage",
    // Range in the filter form's format, for the form that asks for the PDF.
    start: from.toFormat(INPUT_FORMAT),
    end: to.toFormat(INPUT_FORMAT),
  };
}
