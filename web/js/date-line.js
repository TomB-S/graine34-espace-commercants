// The date line of the big ticket as the script rebuilds it: the label given by the server ("Aujourd'hui 10:33",
// "12/11 17:21") followed by the age worked out here ("· il y a 2 min"). Pure: the only import is age.js, which is
// itself pure, so that the browser loads this very file.
import { ageText } from "./age.js";

export function dateLine(label, atMs, nowMs) {
  const age = ageText(atMs, nowMs);
  return age ? `${label} · ${age}` : label;
}

// Gap between the clock of the server and the one of the browser (milliseconds, to add to the browser's
// clock). Without it, a browser clock a few minutes off would show "il y a 3 min" on a payment just received.
export function clockOffset(serverNowMs, clientNowMs) {
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(clientNowMs)) return 0;
  return serverNowMs - clientNowMs;
}

// The day of a moment in Paris, as "2026-11-18". The page compares it from time to time to notice the change of day (midnight in
// Paris) by itself. Intl only, so that the browser and the tests use the same file.
export function parisDayKey(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
