// The "Actualiser" button: which text and whether it is disabled. Pure logic, no browser API, so that the browser loads this very
// file and the tests run it as it is. `busy`: a reading of /caisse/data started by the click is under way.
import { TEXTS } from "./caisse-texts.js";

export function refreshState(busy) {
  return busy ? { text: TEXTS.refreshing, disabled: true } : { text: TEXTS.refreshButton, disabled: false };
}

// A click starts a reading unless one started by a click is already under way (a double click reads once).
export function canStartRefresh(busy) {
  return !busy;
}

// Reading rhythm from the data-poll-seconds attribute. "0" is the manual mode: no automatic reading at all (no timer, no reading when
// the tab comes back or the network returns), only the first reading at the opening and the "Actualiser" button. Anything unreadable
// falls back to 3 seconds; the minimum otherwise is 1 second. Returns { manual, pollMs }.
export function pollSettings(raw) {
  if (String(raw).trim() === "0") return { manual: true, pollMs: 0 };
  return { manual: false, pollMs: Math.max(1, Number(raw) || 3) * 1000 };
}

// The line at the bottom of the page. `seconds` 0 = manual mode (an instruction is shown); automatic mode shows nothing.
export function pollFooterText(seconds) {
  return seconds === 0 ? TEXTS.manualMode : "";
}
