// The browser side of the notifications (notification.js) against a stand-in for the Notification API: nothing is asked by itself,
// the permission is requested only by request(), a click on a notification brings the page back, and a refusing browser breaks nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNotifier } from "../web/js/notification.js";

function fakeNotification({ permission = "default", answer = "granted", throwOnCreate = false } = {}) {
  const log = { requested: 0, shown: [] };
  class FakeNotification {
    static permission = permission;
    static async requestPermission() {
      log.requested += 1;
      FakeNotification.permission = answer;
      return answer;
    }
    constructor(title, options) {
      if (throwOnCreate) throw new TypeError("Illegal constructor");
      this.title = title;
      this.options = options;
      this.closed = false;
      log.shown.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  return { FakeNotification, log };
}

test("notifier : rien n'est demandé à la création, la permission est demandée seulement par request()", async () => {
  const { FakeNotification, log } = fakeNotification();
  let changes = 0;
  const notifier = createNotifier({ NotificationClass: FakeNotification, secure: true, onChange: () => (changes += 1) });
  assert.equal(log.requested, 0);
  assert.deepEqual(notifier.status(), { supported: true, secure: true, permission: "default" });
  await notifier.request();
  assert.equal(log.requested, 1);
  assert.equal(notifier.status().permission, "granted");
  assert.equal(changes, 1, "the page is told");
});

test("notifier : permission refusée = état refusé, aucune notification montrée", async () => {
  const { FakeNotification, log } = fakeNotification({ answer: "denied" });
  const notifier = createNotifier({ NotificationClass: FakeNotification, secure: true });
  await notifier.request();
  assert.equal(notifier.status().permission, "denied");
  notifier.show({ title: "Paiement reçu", body: "1 G de X", tag: "k1" });
  assert.equal(log.shown.length, 0);
});

test("notifier : show() n'agit qu'avec la permission (jamais d'autorisation demandée par show)", () => {
  const { FakeNotification, log } = fakeNotification({ permission: "default" });
  const notifier = createNotifier({ NotificationClass: FakeNotification, secure: true });
  notifier.show({ title: "t", body: "b", tag: "k" });
  assert.equal(log.shown.length, 0);
  assert.equal(log.requested, 0);
});

test("notifier : titre, corps et tag donnés tels quels, un clic ramène l'onglet au premier plan et ferme la notification", () => {
  const { FakeNotification, log } = fakeNotification({ permission: "granted" });
  let focused = 0;
  const notifier = createNotifier({ NotificationClass: FakeNotification, secure: true, focusWindow: () => (focused += 1) });
  notifier.show({ title: "Paiement reçu : 7,50 G", body: "de Payeur 9", tag: "kabc" });
  const [shown] = log.shown;
  assert.equal(shown.title, "Paiement reçu : 7,50 G");
  assert.equal(shown.options.body, "de Payeur 9");
  assert.equal(shown.options.tag, "kabc");
  assert.equal(shown.options.icon, "/icon.png", "the square icon, not the wide logo");
  assert.deepEqual(Object.keys(shown.options).sort(), ["body", "icon", "tag"], "nothing else (no data, no description)");
  shown.onclick();
  assert.equal(focused, 1);
  assert.equal(shown.closed, true);
});

test("notifier : hors HTTPS (contexte non sûr) = rien demandé, rien montré", async () => {
  const { FakeNotification, log } = fakeNotification({ permission: "granted" });
  const notifier = createNotifier({ NotificationClass: FakeNotification, secure: false });
  await notifier.request();
  notifier.show({ title: "t", body: "b", tag: "k" });
  assert.equal(log.requested, 0);
  assert.equal(log.shown.length, 0);
});

test("notifier : un navigateur qui refuse le constructeur (téléphone) ne casse pas la page", () => {
  const { FakeNotification } = fakeNotification({ permission: "granted", throwOnCreate: true });
  const notifier = createNotifier({ NotificationClass: FakeNotification, secure: true });
  notifier.show({ title: "t", body: "b", tag: "k" });
});

test("notifier : navigateur sans API = non pris en charge, aucune erreur", async () => {
  const notifier = createNotifier({ NotificationClass: undefined, secure: true });
  assert.equal(notifier.status().supported, false);
  await notifier.request();
  notifier.show({ title: "t", body: "b", tag: "k" });
});

test("notifier : requestPermission qui échoue ne casse rien", async () => {
  class Broken {
    static permission = "default";
    static requestPermission() {
      throw new Error("boom");
    }
  }
  const notifier = createNotifier({ NotificationClass: Broken, secure: true });
  await notifier.request();
  assert.equal(notifier.status().permission, "default");
});

// Intention: no service worker, no push, nothing stored, no request for the permission outside request().
test("notifier : ni service worker, ni push, ni stockage dans notification.js", async () => {
  const code = await readFile(new URL("../web/js/notification.js", import.meta.url), "utf8");
  assert.ok(!/serviceWorker|PushManager|pushManager|localStorage|sessionStorage|indexedDB|fetch\(/i.test(code));
  assert.equal(code.match(/requestPermission/g).length, 1, "asked in one place only (request())");
  assert.deepEqual([...code.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]), []);
});
