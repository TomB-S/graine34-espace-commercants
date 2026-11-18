// Days of the cash register page, counted in Paris time (midnight to midnight), and the recap of yesterday.
//
// Pure functions: no network, no clock of their own (the caller gives `now`). The total of the recap is worked out on the
// decimal strings with whole numbers (BigInt): no floating point, so no rounding error, whatever the number of payments.
// A line that cannot be read with certainty (amount or date) makes the whole recap fail: a wrong total is never shown.
import { DateTime } from "luxon";

export const ZONE = "Europe/Paris";

// How much of the history is read to build the recap: at most 20 pages of 100 payments. Beyond that the recap is refused
// (state "tooMany") instead of being shown possibly wrong.
export const PERIOD_PAGE_SIZE = 100;
export const PERIOD_MAX_PAGES = 20;

const EXACT_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

const parisTime = (ms) => DateTime.fromMillis(ms, { zone: ZONE });

// "2026-11-18": the day of a moment in Paris.
export const dayKey = (ms) => parisTime(ms).toFormat("yyyy-LL-dd");

// The days around `now`: keys of today and yesterday, and the moments to ask Cyclos for (start of yesterday, start of tomorrow),
// as ISO texts with the offset of Paris. Calendar arithmetic, so the days of the clock change (23 h, 25 h) are right.
export function dayBounds(now) {
  const today = parisTime(now).startOf("day");
  const yesterday = today.minus({ days: 1 });
  const tomorrow = today.plus({ days: 1 });
  return {
    todayKey: today.toFormat("yyyy-LL-dd"),
    yesterdayKey: yesterday.toFormat("yyyy-LL-dd"),
    from: yesterday.toISO(),
    to: tomorrow.toISO(),
    nextMidnight: tomorrow.toMillis(),
  };
}

// Sum of decimal amounts written as strings ("1.50"). Returns { total, digits } (total as a string with `digits` decimals,
// at least `minDigits`), or null when one amount is not an exact positive or zero decimal.
export function sumAmounts(amounts, minDigits = 0) {
  let digits = minDigits;
  const parts = [];
  for (const amount of amounts) {
    const match = typeof amount === "string" ? EXACT_AMOUNT.exec(amount.trim()) : null;
    if (!match) return null;
    parts.push({ integer: match[1], decimals: match[2] ?? "" });
    digits = Math.max(digits, (match[2] ?? "").length);
  }
  let total = 0n;
  for (const { integer, decimals } of parts) total += BigInt(integer + decimals.padEnd(digits, "0"));
  const text = total.toString().padStart(digits + 1, "0");
  return { total: digits > 0 ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text, digits };
}

// Recap of yesterday from the lines of the history read for the period. Returns
// { count, total } or null when a line of yesterday cannot be read with certainty (unreadable amount or date).
// A payment seen twice (a new payment moves the pages while they are read) is counted once, by its number.
// Only the lines dated yesterday count; the others (today) are the business of the tickets.
export function summarizeYesterday(lines, now, minDigits = 0) {
  const { yesterdayKey } = dayBounds(now);
  const seen = new Set();
  const amounts = [];
  for (const line of lines) {
    if (typeof line?.amount === "string" && line.amount.trim().startsWith("-")) continue; // a debit: not a payment received
    const date = typeof line?.date === "string" ? DateTime.fromISO(line.date) : null;
    if (!date?.isValid) return null;
    if (dayKey(date.toMillis()) !== yesterdayKey) continue;
    const number = typeof line.transactionNumber === "string" && line.transactionNumber !== "" ? line.transactionNumber : null;
    if (number) {
      if (seen.has(number)) continue;
      seen.add(number);
    }
    amounts.push(line.amount);
  }
  const sum = sumAmounts(amounts, minDigits);
  return sum ? { count: amounts.length, total: sum.total } : null;
}
