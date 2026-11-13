// The notifications of the browser: the only file that touches the Notification API. The rules (what to notify, what to write,
// what to say about the state) are in notification-logic.js. Nothing here is automatic: the permission is asked only from a click
// (request()), and a notification only works while the page is open (no service worker, no push).
//
// `NotificationClass`: window.Notification (undefined when the browser has none). `secure`: window.isSecureContext (HTTPS or localhost).
// `focusWindow`: brings the tab to the front when a notification is clicked. `onChange`: the page refreshes its line.
// Square icon of the notification (the logo is a wide rectangle that the system would cut), served by our own server.
export const ICON = "/icon.png";

export function createNotifier({ NotificationClass, secure, focusWindow = () => {}, onChange = () => {} }) {
  const supported = typeof NotificationClass === "function";

  return {
    // What notification-logic.js needs.
    status() {
      return { supported, secure: Boolean(secure), permission: supported ? String(NotificationClass.permission) : "denied" };
    },

    // To call from a click only: the browser asks the user.
    async request() {
      if (!supported || !secure) return;
      try {
        await NotificationClass.requestPermission();
      } catch {
        // old browsers or a refusal to ask: the state is read again below
      }
      onChange();
    },

    // Shows one notification { title, body, tag }. Clicking it brings the page back to the front. Never throws.
    show({ title, body, tag }) {
      if (!supported || !secure || NotificationClass.permission !== "granted") return;
      try {
        const notification = new NotificationClass(title, { body, tag, icon: ICON });
        notification.onclick = () => {
          focusWindow();
          notification.close?.();
        };
      } catch {
        // some browsers (a phone) refuse the constructor: the page goes on without
      }
    },
  };
}
