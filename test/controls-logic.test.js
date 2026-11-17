// The one button of the sound and the notifications (controls-logic.js): pure logic, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { controlsLabel } from "../web/js/controls-logic.js";

const sound = (extra = {}) => ({ supported: true, wanted: true, audioState: "none", ...extra });
const notif = (extra = {}) => ({ supported: true, secure: true, permission: "default", ...extra });
const running = { audioState: "running" };

test("bouton : tant que l'un des deux n'est pas actif = « Activer le son et les notifications », un clic fait les deux", () => {
  assert.deepEqual(controlsLabel(sound(), notif()), { buttonText: "Activer le son et les notifications", action: "enable", enableSound: true, askNotifications: true });
  // sound waiting (suspended, interrupted) or cut, notifications still to grant
  for (const extra of [{ audioState: "suspended" }, { audioState: "interrupted" }, { wanted: false }]) {
    assert.equal(controlsLabel(sound(extra), notif()).buttonText, "Activer le son et les notifications", JSON.stringify(extra));
  }
});

test("bouton : son actif mais notifications à accorder = même bouton, sans refaire le son", () => {
  assert.deepEqual(controlsLabel(sound(running), notif()), { buttonText: "Activer le son et les notifications", action: "enable", enableSound: false, askNotifications: true });
});

test("bouton : les deux actifs = « Couper le son »", () => {
  assert.deepEqual(controlsLabel(sound(running), notif({ permission: "granted" })), { buttonText: "Couper le son", action: "cut", enableSound: false, askNotifications: false });
});

test("bouton : ce qui ne peut pas être activé n'est pas promis (notifications refusées, hors HTTPS, non prises en charge)", () => {
  for (const extra of [{ permission: "denied" }, { secure: false }, { supported: false }]) {
    assert.equal(controlsLabel(sound(), notif(extra)).buttonText, "Activer le son", JSON.stringify(extra));
    assert.equal(controlsLabel(sound(), notif(extra)).askNotifications, false);
    assert.equal(controlsLabel(sound(running), notif(extra)).buttonText, "Couper le son", `sound on, ${JSON.stringify(extra)}`);
  }
});

test("bouton : son déjà accordé par les notifications, mais coupé = « Activer le son »", () => {
  assert.deepEqual(controlsLabel(sound({ wanted: false }), notif({ permission: "granted" })), { buttonText: "Activer le son", action: "enable", enableSound: true, askNotifications: false });
});

test("bouton : navigateur sans Web Audio = seulement les notifications, ou aucun bouton", () => {
  const none = { supported: false, wanted: false, audioState: "none" };
  assert.deepEqual(controlsLabel(none, notif()), { buttonText: "Activer les notifications", action: "enable", enableSound: false, askNotifications: true });
  assert.deepEqual(controlsLabel(none, notif({ permission: "granted" })), { buttonText: null, action: null, enableSound: false, askNotifications: false });
  assert.deepEqual(controlsLabel(none, notif({ permission: "denied" })), { buttonText: null, action: null, enableSound: false, askNotifications: false });
});

test("bouton : jamais plus d'un libellé possible, toujours l'un de ceux prévus", () => {
  const allowed = new Set([null, "Activer le son et les notifications", "Activer le son", "Activer les notifications", "Couper le son"]);
  for (const supported of [true, false]) {
    for (const wanted of [true, false]) {
      for (const audioState of ["none", "running", "suspended", "interrupted", "closed"]) {
        for (const nSupported of [true, false]) {
          for (const secure of [true, false]) {
            for (const permission of ["default", "granted", "denied"]) {
              const label = controlsLabel({ supported, wanted, audioState }, { supported: nSupported, secure, permission });
              assert.ok(allowed.has(label.buttonText), JSON.stringify(label));
              assert.equal(label.action === null, label.buttonText === null);
            }
          }
        }
      }
    }
  }
});
