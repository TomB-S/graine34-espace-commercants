// How old a payment is, as a short French text ("à l'instant", "il y a 5 min", "il y a 2 h").
//
// Pure function: no import, no dependency on Node or on a library, so that the browser can load the
// same file later. Both arguments are milliseconds (Date.now() style).
//
// - less than 60 seconds, or a negative gap (clocks that disagree): "à l'instant"
// - 1 to 59 minutes: "il y a N min"
// - 1 to 23 hours: "il y a N h"
// - 24 hours or more, or a value that is not a number: "" (the page shows the date only)
// Always rounded down.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function ageText(thenMs, nowMs) {
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return "";
  const gap = nowMs - thenMs;
  if (gap < MINUTE) return "à l'instant";
  if (gap < HOUR) return `il y a ${Math.floor(gap / MINUTE)} min`;
  if (gap < DAY) return `il y a ${Math.floor(gap / HOUR)} h`;
  return "";
}
