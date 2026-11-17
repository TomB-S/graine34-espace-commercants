// Detection of the new payments seen by the page. Pure: no import, no DOM, no timer, so that the browser
// loads this very file and the tests run it as it is. The sound (step C) and the notification (step D) use it.
//
// A payment is new for THIS page when none of its keys was seen by this page before, wherever it comes from (a live notification,
// the safety net, or the history read when the listening restarted after a pause). Each ticket carries `keys`: every identifier it is
// known by (a ticket first known by its notification is later completed with its transaction number, so it gains a key and keeps
// the old one).
//
// - Nothing is reported until the page has seen the data once with `ready` true (the server finished the first load of the history):
//   what is there then is only learned, whatever the age of the payments. A first answer that is still "loading" (`ready` false)
//   is learned silently too and does not start the detection, so the old payments never ring when they show up a moment later.
// - After that, a ticket none of whose keys was seen is new.
// - A failed read is simply not given to update(): nothing changes.
const NEW_MARK_MS = 60_000; // how long the "Nouveau" mark stays (same duration as isNew() in ticket-store.js)

export function createNewPaymentDetector() {
  const seen = new Set();
  const announced = new Map(); // key -> time the page found the payment new
  let started = false;
  return {
    // Returns the new tickets (most recent first, as given), and remembers every key. `ready`: the server finished the first
    // load of the history (default true). `nowMs`: the time, to date the detection.
    update(tickets, { ready = true, nowMs = Date.now() } = {}) {
      const fresh = [];
      for (const ticket of tickets) {
        const keys = Array.isArray(ticket.keys) ? ticket.keys : [];
        const known = keys.some((key) => seen.has(key));
        if (started && ready && !known && keys.length > 0) {
          fresh.push(ticket);
          for (const key of keys) announced.set(key, nowMs);
        }
        for (const key of keys) seen.add(key);
      }
      if (ready) started = true;
      return fresh;
    },

    // Puts the "Nouveau" mark (isNew) on the tickets this page found new less than a minute ago, even when the server does not
    // (a payment read from the history). Changes the tickets in place; the mark goes after a minute like the server's own.
    markNew(tickets, nowMs = Date.now()) {
      for (const ticket of tickets) {
        const keys = Array.isArray(ticket.keys) ? ticket.keys : [];
        if (keys.some((key) => announced.has(key) && nowMs - announced.get(key) < NEW_MARK_MS)) ticket.isNew = true;
      }
    },

    get started() {
      return started;
    },
  };
}
