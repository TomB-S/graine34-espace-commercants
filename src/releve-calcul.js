// Statement of transactions (/espace/releve): the pure part. No network, no server, no state: values in, values out.
// Date ranges typed in the filter form (Paris time), amounts in exact integers (BigInt), summary totals and the content of the
// ticket as plain strings, shared by the HTML page and the PDF so that both always show the same thing.
import { DateTime } from "luxon";
import { formatAmount } from "./format.js";
import { statementCounterparty } from "./caisse-data.js";

export const ZONE = "Europe/Paris";

// Format of <input type="datetime-local"> values (no seconds, no zone).
export const INPUT_FORMAT = "yyyy-MM-dd'T'HH:mm";
const INPUT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// Longest range, counted in CALENDAR days (Luxon adds days on the wall clock of ZONE), not in elapsed hours: a range of 31 days has
// 744 hours, 745 across the October clock change and 743 across the March one. A whole month (28 to 31 days) therefore always fits.
export const MAX_RANGE_DAYS = 31;

export function exceedsMaxRange(from, to) {
  return to > from.plus({ days: MAX_RANGE_DAYS });
}
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

// Whole-month mode only: its own cap, much higher, because a month of a busy till is long. Same rule as above for the value.
export const DEFAULT_MONTH_MAX_ROWS = 10000;

export function readMonthMaxRows(env = process.env) {
  const value = Number(env.HISTORY_MAX_ROWS_MONTH);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MONTH_MAX_ROWS;
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
  if (exceedsMaxRange(from, to)) {
    return {
      error: `La plage ne peut pas dépasser ${MAX_RANGE_DAYS} jours.`,
    };
  }
  return { from, to, until, clamped };
}

// ---------------------------------------------------------------------------------------------------------------
// One day, between two hours ("Une journée ou une soirée" mode)

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^\d{2}:\d{2}$/;
const TIME_VALUE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DAY_FORMAT = "yyyy-MM-dd";
const TIME_FORMAT = "HH:mm";

// Default values of the day block, in ZONE wall-clock time: today, the whole day, the "next day" box unchecked.
export function dayDefaults(now = DateTime.now().setZone(ZONE)) {
  return { jour: now.toFormat(DAY_FORMAT), de: "00:00", a: "23:59", lendemain: false };
}

// Range of one day between two hours, Paris time. `dayText` is YYYY-MM-DD, `fromText` and `toText` are HH:mm (strict shapes, like the
// <input type="date"> and <input type="time"> values). `nextDay` is the explicit box "the service ends the next day (after midnight)":
// unchecked (default), the end hour must be strictly after the start hour on the same day; checked, the end is the next day at the end
// hour (one calendar day added on the wall clock of ZONE, so clock-change days come out right). In both cases the range lasts 24 hours
// at most, counted on the wall clock like MAX_RANGE_DAYS: the end may not be after the start plus one calendar day, so 18:00 to 18:00
// the next day is accepted, and a whole day of 23 or 25 real hours (29 March, 25 October) is never refused for being "too long".
// The two instants are then handed to parseRange, which keeps every other rule (start in the future refused, future end brought back
// to now, hours that do not exist, whole last minute included): nothing is repeated here.
// Returns { error } or what parseRange returns, plus `day: { jour, de, a, lendemain }` (the submitted values, to ask for the same range again).
export function dayRange(dayText, fromText, toText, nextDay = false, now = DateTime.now().setZone(ZONE)) {
  if (!DAY_SHAPE.test(dayText ?? "")) {
    return { error: "Jour invalide : le format attendu est AAAA-MM-JJ (par exemple 2026-11-05)." };
  }
  const day = DateTime.fromFormat(dayText, DAY_FORMAT, { zone: ZONE });
  if (!day.isValid) {
    return { error: "Le jour choisi n'existe pas dans le calendrier." };
  }
  const time = (text, label) => {
    if (!TIME_SHAPE.test(text ?? "")) return { error: `Heure de ${label} invalide : le format attendu est HH:mm (par exemple 18:30).` };
    // Checked on its own, apart from any date: 00:00 to 23:59 only (Luxon would accept 24:00), so no clock change can touch it.
    return TIME_VALUE.test(text) ? { value: text } : { error: `L'heure de ${label} n'existe pas : choisissez une heure entre 00:00 et 23:59.` };
  };
  const from = time(fromText, "début");
  if (from.error) return from;
  const to = time(toText, "fin");
  if (to.error) return to;
  const next = nextDay === true;
  if (!next && to.value <= from.value) {
    return { error: "L'heure de fin doit être après l'heure de début. Si le service finit après minuit, cochez la case." };
  }

  const startText = `${dayText}T${from.value}`;
  const endText = `${(next ? day.plus({ days: 1 }) : day).toFormat(DAY_FORMAT)}T${to.value}`;
  const range = parseRange(startText, endText, now);
  if (range.error) return range;
  // The length asked for, before any future end is brought back to now.
  if (DateTime.fromFormat(endText, INPUT_FORMAT, { zone: ZONE }) > range.from.plus({ days: 1 })) {
    return { error: "Un relevé de service dure 24 heures au plus. Pour une période plus longue, utilisez « Autre période »." };
  }
  return { ...range, day: { jour: dayText, de: from.value, a: to.value, lendemain: next } };
}

// ---------------------------------------------------------------------------------------------------------------
// Whole months ("Mois complet" mode)

export const MONTH_NAMES = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];
// Strict shapes of the submitted values: no sign, no space, no leading zero, nothing else.
const MONTH_SHAPE = /^(?:[1-9]|1[0-2])$/;
const YEAR_SHAPE = /^[1-9]\d{3}$/;
// The year list offered by the form: the current year and the two before it.
export const MONTH_YEARS_BACK = 2;

export function allowedYears(now = DateTime.now().setZone(ZONE)) {
  return Array.from({ length: MONTH_YEARS_BACK + 1 }, (_, i) => now.year - MONTH_YEARS_BACK + i);
}

// The month before the one of `now`, as { year, month } (month 1..12): the default of the monthly form.
export function previousMonth(now = DateTime.now().setZone(ZONE)) {
  const before = now.startOf("month").minus({ months: 1 });
  return { year: before.year, month: before.month };
}

// Range of one whole month, Paris time, same conventions as the other ranges: it starts on the 1st at 00:00 and ends on the last
// day at 23:59 (like "Hier"), `until` (sent to Cyclos) being the last millisecond of that minute. Everything goes through Luxon in
// ZONE, so the day count and the hours of a month with a clock change come out right (no fixed offset anywhere).
// `yearText` and `monthText` are the submitted strings and are checked strictly: a whole month number 1..12 and one of the years of
// allowedYears(); anything else is an error (`invalid: true`, the route answers 400). A month that has not started is refused. The
// current month is accepted, but its end is brought back to now (`clamped` and `current` are true, and the label says so).
// Returns { error, invalid? } or { from, to, until, clamped, current, year, month, title, label }.
export function monthRange(yearText, monthText, now = DateTime.now().setZone(ZONE)) {
  if (!YEAR_SHAPE.test(yearText ?? "") || !allowedYears(now).includes(Number(yearText))) {
    return { error: "Année invalide : choisissez une année de la liste.", invalid: true };
  }
  if (!MONTH_SHAPE.test(monthText ?? "")) {
    return { error: "Mois invalide : choisissez un mois de la liste.", invalid: true };
  }
  const year = Number(yearText);
  const month = Number(monthText);

  const from = DateTime.fromObject({ year, month, day: 1 }, { zone: ZONE }).startOf("day");
  if (from > now) {
    return { error: "Ce mois n'a pas encore commencé : choisissez le mois en cours ou un mois passé." };
  }

  let to = from.endOf("month").startOf("minute");
  let until = to.plus({ minutes: 1 }).minus({ milliseconds: 1 });
  const current = until > now;
  if (current) {
    to = now.startOf("minute");
    until = now;
  }

  // Same limit as the free range; a month never exceeds it (at most 31 calendar days).
  if (exceedsMaxRange(from, to)) {
    return { error: `La plage ne peut pas dépasser ${MAX_RANGE_DAYS} jours.` };
  }

  const monthName = MONTH_NAMES[month - 1];
  const name = `${monthName} ${year}`;
  // French elision: "mois de mars", but "mois d'avril", "d'août", "d'octobre".
  const of = /^[aeiouhéèêàâîôûœ]/i.test(monthName) ? "d'" : "de ";
  return {
    from,
    to,
    until,
    clamped: current,
    current,
    year,
    month,
    title: `Relevé du mois ${of}${name}`,
    label: current ? `${name} (mois en cours, jusqu'au ${to.toFormat("dd/MM/yyyy 'à' HH:mm")})` : name,
  };
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

// Who is on the other side of a transaction: a member (written like the cash register writes a payer) or a system account, whose
// name is the name of an account type, not a person: it is shown as Cyclos gives it.
function counterparty(entry, payerNames) {
  const related = entry.relatedAccount;
  const member = related?.user?.display;
  if (member !== undefined && member !== null) return statementCounterparty(member, payerNames);
  return related?.type?.name ?? "";
}

// The content of the ticket as plain strings (not escaped). `maxRows`: the limit the list was read with (for the warning text).
// `month`: the result of monthRange() when the ticket is a whole-month statement (it gives the title and the period note).
// `payerNames`: { hidePayerName, nameOrder }, the cash register's settings, for the counterparty column (the merchant's own name,
// at the top, is never changed).
export function ticketModel(
  { from, to, totals, entries, truncated, merchantName, currency, maxRows = DEFAULT_MAX_ROWS, month = null, day = null, payerNames = {} },
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
    title: month ? month.title : "Ticket de fin de service",
    merchantName,
    period: `Du ${from.toFormat("dd/MM/yyyy HH:mm")} au ${to.toFormat("dd/MM/yyyy HH:mm")}${month?.current ? " (mois en cours)" : ""}`,
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
      counterparty: counterparty(entry, payerNames),
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
    // Range in the filter form's format, for the form that asks for the PDF. A month is asked for again as a month ({ year, month }).
    start: from.toFormat(INPUT_FORMAT),
    end: to.toFormat(INPUT_FORMAT),
    month: month ? { year: month.year, month: month.month } : null,
    // A day with hours is asked for again as a day and two hours ({ jour, de, a }), not as two full dates.
    day: day ? { ...day } : null,
  };
}
