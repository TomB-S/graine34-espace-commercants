// Script of the cash register page (loaded as a module from /caisse.js, never inline). It asks /caisse/data every few
// seconds, hands the answer to the view, and keeps going when the tab is in the background (the use case of the
// sound and notification of the next steps). The logic is in pure modules (new-payments.js, date-line.js, age.js);
// the elements are built in caisse-view.js. This file only holds the timers and the network.
import { createCaisseView } from "./caisse-view.js";
import { createNewPaymentDetector } from "./new-payments.js";
import { clockOffset } from "./date-line.js";

const AGE_REFRESH_MS = 15_000;

function start() {
  const root = document.getElementById("caisse");
  if (!root) return;
  const pollMs = Math.max(1, Number(root.dataset.pollSeconds) || 3) * 1000;
  const dataUrl = root.dataset.dataUrl || "/caisse/data";
  const loginUrl = root.dataset.loginUrl || "/";

  let offset = 0; // server clock minus browser clock
  const view = createCaisseView(document, { pollSeconds: pollMs / 1000, nowMs: () => Date.now() + offset });
  const detector = createNewPaymentDetector();
  let timer = null;
  let running = false;

  async function poll() {
    if (running) return;
    running = true;
    clearTimeout(timer);
    try {
      const response = await fetch(dataUrl, { headers: { Accept: "application/json" }, cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) {
        location.assign(loginUrl);
        return;
      }
      if (response.status === 403) {
        // Not (or no longer) the registered account: the page itself explains the refusal.
        location.reload();
        return;
      }
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = await response.json();
      offset = clockOffset(data.now, Date.now());
      const fresh = detector.update(data.tickets);
      view.update(data, fresh);
    } catch {
      view.setOffline(true);
    } finally {
      running = false;
      // A timeout chain, not an interval: the next read starts a few seconds after the end of this one.
      // Never paused when the tab is hidden.
      timer = setTimeout(poll, pollMs);
    }
  }

  // Back in the foreground: read at once, the browser may have slowed the timers of a hidden tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });
  window.addEventListener("online", poll);
  setInterval(() => view.refreshAges(), AGE_REFRESH_MS);
  poll();
}

start();
