// The "eye" button of the login pages: shows or hides the password being typed. Loaded by src, at the end of the login pages only
// (the area's login, the cash register's login, and the login of the executable, which is the same page).
//
// The button is created here, never by the server: without JavaScript the page has no dead button and the login works as before.
// The module never reads, copies, stores or logs what is typed: it only switches the `type` of the field between "password" and "text".
// No innerHTML, no eval, no document.write, no browser storage, no network.
//
// `document` and `window` are given by the caller so that Node can run the module with stand-ins for the browser (see the tests).

const SVG_NS = "http://www.w3.org/2000/svg";
export const LABEL_SHOW = "Afficher le mot de passe";
export const LABEL_HIDE = "Masquer le mot de passe";

// An eye drawn with a path and a circle, in the current colour; a slash is added over it while the password is visible. Decorative.
function eyeIcon(document) {
  const svg = document.createElementNS(SVG_NS, "svg");
  const set = (node, attributes) => {
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };
  set(svg, {
    viewBox: "0 0 24 24", width: "24", height: "24", fill: "none", stroke: "currentColor", "stroke-width": "2",
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
  });
  svg.appendChild(set(document.createElementNS(SVG_NS, "path"), { d: "M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" }));
  svg.appendChild(set(document.createElementNS(SVG_NS, "circle"), { cx: "12", cy: "12", r: "3" }));
  const slash = set(document.createElementNS(SVG_NS, "line"), { x1: "3", y1: "3", x2: "21", y2: "21", visibility: "hidden" });
  svg.appendChild(slash);
  return { svg, slash };
}

// One field: a wrapper around it, the button next to it. Returns { hide }.
function attach(document, input) {
  const button = document.createElement("button");
  button.type = "button"; // never a button that submits the form
  button.className = "voir-mot-de-passe";
  const { svg, slash } = eyeIcon(document);
  button.appendChild(svg);

  const wrapper = document.createElement("span");
  wrapper.className = "champ-secret";
  const hadFocus = document.activeElement === input;
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  wrapper.appendChild(button);
  if (hadFocus) input.focus();

  let visible = false;
  function show(on) {
    visible = on;
    input.type = on ? "text" : "password"; // the only thing done to the field
    button.setAttribute("aria-label", on ? LABEL_HIDE : LABEL_SHOW);
    button.setAttribute("aria-pressed", on ? "true" : "false");
    slash.setAttribute("visibility", on ? "visible" : "hidden");
  }
  show(false);

  // A mouse or finger press would take the focus away from the field: it stays where it is (the keyboard activates the button itself).
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    const focused = document.activeElement === input;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    show(!visible);
    if (focused) {
      input.focus();
      try {
        input.setSelectionRange(start, end); // the cursor stays where it was
      } catch {
        // a field type that refuses a selection: nothing to restore
      }
    }
  });
  return { hide: () => visible && show(false), form: input.form };
}

export function enablePasswordToggles(document, window) {
  const toggles = [...document.querySelectorAll('input[type="password"]')].filter((input) => input.form).map((input) => attach(document, input));
  if (toggles.length === 0) return toggles;
  const hideAll = () => toggles.forEach((toggle) => toggle.hide());
  // Hidden again when the form is sent, when the tab is hidden, and when the page comes back from the history of the browser.
  for (const form of new Set(toggles.map((toggle) => toggle.form))) form.addEventListener("submit", hideAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hideAll();
  });
  window.addEventListener("pageshow", hideAll);
  return toggles;
}

if (typeof document !== "undefined" && typeof window !== "undefined") enablePasswordToggles(document, window);
