// Script of the cash register page (loaded as a module from /caisse.js, never inline). It asks /caisse/data every few
// seconds, hands the answer to the view, and keeps going when the tab is in the background (the use case of the
// sound and notification of the next steps). The logic is in pure modules (new-payments.js, date-line.js, age.js);
// the elements are built in caisse-view.js. This file only holds the timers and the network.
import { createCaisseView } from "./caisse-view.js";
import { createNewPaymentDetector } from "./new-payments.js";
import { clockOffset, parisDayKey } from "./date-line.js";
import { createSound } from "./sound.js";
import { shouldBeep, soundLabel } from "./sound-logic.js";
import { controlsLabel } from "./controls-logic.js";
import { canStartRefresh, pollSettings, refreshState } from "./refresh-logic.js";
import { createNotifier } from "./notification.js";
import { canNotify, createNotificationPlanner, notificationLabel } from "./notification-logic.js";

const AGE_REFRESH_MS = 15_000;

// localStorage for light comforts only (the choice to cut the sound). Every access is in a try/catch: the storage may be blocked,
// full or absent (private window), and the page must work without it.
function safeStorage() {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // not remembered, nothing else
      }
    },
  };
}

function start() {
  const root = document.getElementById("caisse");
  if (!root) return;
  // Manual mode (data-poll-seconds="0"): the first reading and the "Actualiser" button are the only readings.
  const { manual, pollMs } = pollSettings(root.dataset.pollSeconds);
  const dataUrl = root.dataset.dataUrl || "/caisse/data";
  const loginUrl = root.dataset.loginUrl || "/";

  let offset = 0; // server clock minus browser clock
  // The sound is on by default (unless the user cut it, remembered): until the browser lets the audio run, the first touch or key
  // on the page unlocks it. Notifications already granted are on at once; otherwise the permission is asked only from the click.
  const sound = createSound({
    AudioContextClass: window.AudioContext ?? window.webkitAudioContext,
    storage: safeStorage(),
    gestureTarget: document,
    onChange: () => refreshControls(),
  });
  const notifier = createNotifier({
    NotificationClass: window.Notification,
    secure: window.isSecureContext,
    focusWindow: () => window.focus(),
    onChange: () => refreshControls(),
  });
  // The two status lines and the one button. The button belongs to the sound line.
  function refreshControls() {
    const soundState = sound.status();
    const notificationState = notifier.status();
    const controls = controlsLabel(soundState, notificationState);
    const notification = notificationLabel(notificationState);
    view.updateSound({ ...soundLabel(soundState), buttonText: controls.buttonText });
    view.updateNotifications({ text: notification.text, buttonText: null, active: notification.active });
  }
  // The click: both at once, in the same gesture (the audio is unlocked and the permission asked without waiting for each other).
  function onButton() {
    const controls = controlsLabel(sound.status(), notifier.status());
    if (controls.action === "cut") sound.disable();
    else if (controls.action === "enable") {
      if (controls.enableSound) sound.enable();
      if (controls.askNotifications) notifier.request();
    }
  }
  const planner = createNotificationPlanner();
  const view = createCaisseView(document, {
    pollSeconds: pollMs / 1000,
    nowMs: () => Date.now() + offset,
    onSoundToggle: onButton,
    onRefresh: onRefreshClick,
  });
  refreshControls();
  view.updateRefresh(refreshState(false));
  const detector = createNewPaymentDetector();
  let timer = null;
  let reading = null; // the reading under way, if any: one at a time, whoever asked for it
  let wantsRetry = false; // the recap of yesterday is still being read by the server: read again soon, even in manual mode
  let shownDay = parisDayKey(Date.now()); // the day (Paris) the page was last read for
  let refreshing = false; // a reading asked by the "Actualiser" button is under way

  // A click reads at once. Same reading, same detector as the automatic one: a payment already shown is never new, so the click can
  // not ring or notify for it. If a reading is already under way, the click waits for that one instead of starting a second.
  async function onRefreshClick() {
    if (!canStartRefresh(refreshing)) return;
    refreshing = true;
    view.updateRefresh(refreshState(true));
    try {
      await poll();
    } finally {
      refreshing = false;
      view.updateRefresh(refreshState(false));
    }
  }

  function poll() {
    if (!reading) {
      reading = readOnce().finally(() => {
        reading = null;
      });
    }
    return reading;
  }

  async function readOnce() {
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
      shownDay = parisDayKey(Date.now() + offset);
      wantsRetry = data.recap?.kind === "pending";
      // New = not seen yet by this page, even when it comes from the history (after a pause of the listening). Nothing is reported
      // before the server says its first load of the history is done (`loaded`), so that the old payments never ring.
      const nowMs = Date.now() + offset;
      const fresh = detector.update(data.tickets, { ready: data.loaded !== false, nowMs });
      detector.markNew(data.tickets, nowMs);
      view.update(data, fresh);
      // One bip per batch of new payments (never for the first load, never when the sound is off or the audio suspended).
      if (shouldBeep(sound.status(), fresh.length)) sound.beep();
      refreshControls();
      // Notifications: the same detection as the sound (so never for the first load nor the opening history). The planner always
      // runs, so that a payment announced while the permission is missing is not announced late.
      const planned = planner.update(fresh, data.tickets, Date.now() + offset);
      if (canNotify(notifier.status())) for (const notification of planned) notifier.show(notification);
      refreshControls();
    } catch {
      view.setOffline(true);
    } finally {
      // A timeout chain, not an interval: the next read starts a few seconds after the end of this one.
      // Never paused when the tab is hidden.
      if (!manual || wantsRetry) timer = setTimeout(poll, manual ? 3000 : pollMs);
    }
  }

  // Back in the foreground: read at once, the browser may have slowed the timers of a hidden tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshControls(); // the browser may have suspended the audio, or the permission changed in the settings
      if (!manual) poll();
    }
  });
  if (!manual) window.addEventListener("online", poll);
  setInterval(() => {
    view.refreshAges();
    // Midnight in Paris: the day changed while the page stayed open, read at once (the payments of the day before leave the page).
    if (parisDayKey(Date.now() + offset) !== shownDay) poll();
  }, AGE_REFRESH_MS);
  poll();
}

start();
