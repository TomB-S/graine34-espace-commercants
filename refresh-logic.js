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
