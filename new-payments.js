// Detection of the new payments seen by the page. Pure: no import, no DOM, no timer, so that the browser
// loads this very file and the tests run it as it is. The sound (step C) and the notification (step D) use it.
//
// Each ticket carries `keys`: every identifier it is known by (a ticket first known by its notification
// is later completed with its transaction number, so it gains a key and keeps the old one) and `initial`
// (true for the payments loaded from the history when the listening started).
//
// - The first update only learns what is there: nothing is reported, whatever the age of the payments.
// - After that, a ticket none of whose keys was seen is a new payment, unless it comes from the opening
//   history (`initial`): a restart of the listening must not look like a burst of payments.
// - A failed read is simply not given to update(): nothing changes.
export function createNewPaymentDetector() {
  const seen = new Set();
  let started = false;
  return {
    // Returns the new tickets (most recent first, as given), and remembers every key.
    update(tickets) {
      const fresh = [];
      for (const ticket of tickets) {
        const keys = Array.isArray(ticket.keys) ? ticket.keys : [];
        const known = keys.some((key) => seen.has(key));
        if (started && !known && !ticket.initial && keys.length > 0) fresh.push(ticket);
        for (const key of keys) seen.add(key);
      }
      started = true;
      return fresh;
    },
    get started() {
      return started;
    },
  };
}
