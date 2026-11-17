// The one button of the sound and the notifications: which label, and what a click does. Pure logic, no browser API, so that the
// browser loads this very file and the tests run it as it is. (The status lines are in sound-logic.js and notification-logic.js.)
//
// One button, "Activer le son et les notifications", as long as one of the two is not on and can be turned on by a click; one click
// does both (the permission is asked and the audio unlocked in the same gesture, with a test bip). Once the sound is on and nothing
// is left to ask, the button becomes "Couper le son". What cannot be turned on (notifications refused, a browser without Web Audio)
// is left out of the label, so that the button never promises something it cannot do.
import { TEXTS } from "./caisse-texts.js";
import { isSoundActive } from "./sound-logic.js";
import { canAskPermission } from "./notification-logic.js";

// `sound`: { supported, wanted, audioState }; `notification`: { supported, secure, permission }.
// Returns { buttonText (null = no button), action ("enable", "cut" or null), enableSound, askNotifications }.
export function controlsLabel(sound, notification) {
  const soundActive = isSoundActive(sound);
  const needSound = Boolean(sound.supported) && !soundActive;
  const askNotifications = canAskPermission(notification);

  if (soundActive && !askNotifications) return { buttonText: TEXTS.soundDisableButton, action: "cut", enableSound: false, askNotifications: false };
  if (!needSound && !askNotifications) return { buttonText: null, action: null, enableSound: false, askNotifications: false };

  let buttonText = TEXTS.enableBothButton;
  if (needSound && !askNotifications) buttonText = TEXTS.soundEnableButton;
  if (!needSound && askNotifications && !sound.supported) buttonText = TEXTS.notificationEnableButton;
  // The test bip only when the click turns the sound on.
  return { buttonText, action: "enable", enableSound: needSound, askNotifications };
}
