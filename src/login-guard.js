// Brakes on the logins of the multi-merchant mode. Pure memory, no network, no clock of its own (`now` is given).
//
// Three protections, all about not hammering Cyclos and not being locked out by it:
//  - per IDENTIFIER (what was typed as login): at most `maxPerIdentifier` refused passwords per window, whatever the address.
//    It protects the merchant's account, which Cyclos blocks after repeated failures, and the server's address with it;
//  - per ADDRESS: at most `maxPerAddress` refused passwords per window, whatever the identifiers (one visitor trying many accounts);
//  - a CIRCUIT BREAKER on Cyclos: after `breakerThreshold` failures of Cyclos itself (429, 5xx, network) within
//    `breakerWindowMs`, every login is turned away for `breakerPauseMs` without calling Cyclos. After the pause one try is
//    allowed; if it fails again the pause starts again at once.
// Only refused passwords count for the first two (a 403 or an outage of Cyclos is not the merchant's fault). A success
// forgets the failures of its identifier. The tables are bounded: beyond `maxEntries` the oldest entries are dropped.
// The identifiers are kept in memory only, never written anywhere, and never part of an answer of this module.

const MAX_IDENTIFIER_LENGTH = 200;

export function createLoginGuard({
  now = Date.now,
  windowMs = 15 * 60_000,
  maxPerIdentifier = 5,
  maxPerAddress = 10,
  maxEntries = 10_000,
  breakerThreshold = 5,
  breakerWindowMs = 30_000,
  breakerPauseMs = 60_000,
} = {}) {
  const byIdentifier = new Map(); // normalized identifier -> [timestamps of refusals]
  const byAddress = new Map(); // address -> [timestamps of refusals]
  const breaker = { failures: [], openUntil: 0, probing: false };

  const normalize = (identifier) => String(identifier ?? "").trim().toLowerCase().slice(0, MAX_IDENTIFIER_LENGTH);

  // The refusals still inside the window, as a fresh list (stored back, or the key is dropped when empty).
  function recent(table, key, at) {
    const list = (table.get(key) ?? []).filter((time) => at - time < windowMs);
    if (list.length === 0) table.delete(key);
    else table.set(key, list);
    return list;
  }

  // `{ blocked: false }` or `{ blocked: true, reason, retryAfterSeconds }` (reason: "identifier" | "address" | "cyclos").
  function check({ identifier, address }, at = now()) {
    if (breaker.openUntil > at) {
      return { blocked: true, reason: "cyclos", retryAfterSeconds: Math.ceil((breaker.openUntil - at) / 1000) };
    }
    for (const [reason, table, key, max] of [
      ["identifier", byIdentifier, normalize(identifier), maxPerIdentifier],
      ["address", byAddress, String(address ?? "unknown"), maxPerAddress],
    ]) {
      const list = recent(table, key, at);
      if (list.length >= max) {
        // Free again when the oldest refusal that keeps the count at the maximum leaves the window.
        const frees = list[list.length - max] + windowMs;
        return { blocked: true, reason, retryAfterSeconds: Math.max(1, Math.ceil((frees - at) / 1000)) };
      }
    }
    return { blocked: false };
  }

  function remember(table, key, at) {
    const list = recent(table, key, at);
    list.push(at);
    table.delete(key); // re-inserted last: the oldest keys stay first for the eviction
    table.set(key, list);
    while (table.size > maxEntries) table.delete(table.keys().next().value);
  }

  // A refused password (401 from Cyclos).
  function recordRefusal({ identifier, address }, at = now()) {
    remember(byIdentifier, normalize(identifier), at);
    remember(byAddress, String(address ?? "unknown"), at);
  }

  // A login accepted: the failures of this identifier are forgotten (not those of the address).
  function recordSuccess({ identifier }) {
    byIdentifier.delete(normalize(identifier));
    breaker.failures = [];
    breaker.probing = false;
  }

  // Cyclos itself failed (429, 5xx, network error, timeout).
  function recordCyclosFailure(at = now()) {
    breaker.failures = breaker.failures.filter((time) => at - time < breakerWindowMs);
    breaker.failures.push(at);
    // After the pause, the first failure is enough to open again.
    if (breaker.failures.length >= breakerThreshold || breaker.probing) {
      breaker.openUntil = at + breakerPauseMs;
      breaker.failures = [];
      breaker.probing = true;
    }
  }

  // Drops what is expired. Called by the periodic cleanup of the server.
  function sweep(at = now()) {
    for (const table of [byIdentifier, byAddress]) for (const key of [...table.keys()]) recent(table, key, at);
    if (breaker.openUntil !== 0 && breaker.openUntil <= at && breaker.failures.length === 0 && !breaker.probing) breaker.openUntil = 0;
  }

  return {
    check,
    recordRefusal,
    recordSuccess,
    recordCyclosFailure,
    sweep,
    // Sizes only, for the tests.
    get sizes() {
      return { identifiers: byIdentifier.size, addresses: byAddress.size };
    },
  };
}
