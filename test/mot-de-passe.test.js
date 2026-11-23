// === WHAT THIS FILE CHECKS ===
// The "eye" button of the login pages (web/js/password-toggle.js): the module run in Node with stand-ins for the browser (one button per
// password field, a click switches the type and the accessible name, the value of the field is never touched, the field is hidden again
// on submit, on visibilitychange and on pageshow, the focus and the cursor stay), and the module served like the other browser modules.
// The password used here is a made-up string, never a real one.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { appTest, EXPECTED_CSP } from "./support/harness.js";
import { enablePasswordToggles, LABEL_SHOW, LABEL_HIDE } from "../web/js/password-toggle.js";

const MODULE = new URL("../web/js/password-toggle.js", import.meta.url);
const SECRET = "valeur-de-test-fictive";

// ---------------------------------------------------------------- stand-ins for the browser

class Node {
  constructor(tag, ns = null) {
    Object.assign(this, { tag, ns, attributes: new Map(), children: [], parentNode: null, listeners: {}, className: "" });
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  appendChild(child) {
    child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, child);
    return child;
  }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() { event.prevented = true; }, ...event }); return event; }
}

// A password field whose value is a trap: any read or write of it is counted.
function field(form, { type = "password" } = {}) {
  const input = new Node("input");
  const access = { reads: 0, writes: 0 };
  Object.defineProperty(input, "value", { get: () => (access.reads += 1, SECRET), set: () => { access.writes += 1; } });
  Object.assign(input, { type, form, selectionStart: 3, selectionEnd: 5, selections: [] });
  input.focus = () => { input.document.activeElement = input; };
  input.setSelectionRange = (a, b) => input.selections.push([a, b]);
  input.access = access;
  return input;
}

function page({ fields = 1, focused = false } = {}) {
  const document = { activeElement: null, visibilityState: "visible", listeners: {} };
  const window = { listeners: {} };
  for (const target of [document, window]) target.addEventListener = (type, fn) => (target.listeners[type] ??= []).push(fn);
  const form = new Node("form");
  const parent = new Node("p");
  const inputs = Array.from({ length: fields }, () => {
    const input = field(form);
    input.document = document;
    parent.appendChild(input);
    return input;
  });
  const other = field(form, { type: "text" });
  other.document = document;
  parent.appendChild(other);
  const alone = field(null);
  alone.document = document;
  parent.appendChild(alone);
  document.querySelectorAll = (selector) => {
    assert.equal(selector, 'input[type="password"]');
    return [...inputs, alone];
  };
  document.createElement = (tag) => new Node(tag);
  document.createElementNS = (ns, tag) => new Node(tag, ns);
  if (focused) document.activeElement = inputs[0];
  const toggles = enablePasswordToggles(document, window);
  const buttons = inputs.map((input) => input.parentNode.children.find((n) => n.tag === "button"));
  const fire = (target, type) => (target.listeners[type] ?? []).forEach((fn) => fn({}));
  return { document, window, form, inputs, other, alone, toggles, buttons, fire };
}

// ---------------------------------------------------------------- the module

// Intention: one button per password field of a form, created by the script, next to the field (in a wrapper), of type "button" (it
// never submits the form), starting hidden with the accessible name "Afficher le mot de passe" and aria-pressed false. A field that is
// not a password, or not in a form, gets nothing.
test("module : un bouton par champ mot de passe, de type button, à côté du champ", () => {
  const { inputs, buttons, other, alone, form } = page({ fields: 2 });
  assert.equal(buttons.length, 2);
  for (const [i, button] of buttons.entries()) {
    assert.ok(button, "a button");
    assert.equal(button.type, "button");
    assert.equal(button.className, "voir-mot-de-passe");
    assert.equal(button.getAttribute("aria-label"), LABEL_SHOW);
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(inputs[i].type, "password");
    const wrapper = inputs[i].parentNode;
    assert.equal(wrapper.className, "champ-secret");
    assert.deepEqual(wrapper.children, [inputs[i], button], "the button right after its field");
  }
  assert.ok(other.parentNode.className !== "champ-secret", "a text field is left alone");
  assert.ok(alone.parentNode.className !== "champ-secret", "a field outside a form is left alone");
  assert.deepEqual(form.listeners.submit.length, 1, "one submit listener for the form");
  assert.equal(LABEL_SHOW, "Afficher le mot de passe");
  assert.equal(LABEL_HIDE, "Masquer le mot de passe");
});

// Intention: the icon is an SVG made by createElementNS (no innerHTML: the stand-in throws on it), hidden from screen readers, in the
// current colour, with a slash that only shows while the password is visible.
test("module : l'oeil est un SVG créé par createElementNS, décoratif, barré seulement quand le mot de passe est visible", () => {
  const { buttons } = page();
  const [svg] = buttons[0].children;
  assert.equal(svg.tag, "svg");
  assert.equal(svg.ns, "http://www.w3.org/2000/svg");
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.getAttribute("stroke"), "currentColor");
  assert.deepEqual(svg.children.map((n) => [n.tag, n.ns]), [["path", svg.ns], ["circle", svg.ns], ["line", svg.ns]]);
  const slash = svg.children[2];
  assert.equal(slash.getAttribute("visibility"), "hidden");
  buttons[0].fire("click");
  assert.equal(slash.getAttribute("visibility"), "visible");
  buttons[0].fire("click");
  assert.equal(slash.getAttribute("visibility"), "hidden");
});

// Intention: a click switches the field between password and text and updates the name and aria-pressed; a second click goes back.
test("module : un clic bascule le type, le nom accessible et aria-pressed", () => {
  const { inputs, buttons } = page();
  const [input] = inputs;
  const [button] = buttons;
  button.fire("click");
  assert.equal(input.type, "text");
  assert.equal(button.getAttribute("aria-label"), LABEL_HIDE);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  button.fire("click");
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-label"), LABEL_SHOW);
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

// Intention: the value of the field is never read nor written, by the setup, by a click, or by any of the hiding events.
test("module : la valeur du champ n'est jamais lue ni modifiée", () => {
  const { inputs, buttons, form, document, window, fire } = page({ focused: true });
  buttons[0].fire("click");
  buttons[0].fire("click");
  buttons[0].fire("click");
  form.fire("submit");
  document.visibilityState = "hidden";
  fire(document, "visibilitychange");
  fire(window, "pageshow");
  assert.deepEqual(inputs[0].access, { reads: 0, writes: 0 });
  assert.equal(inputs[0].value, SECRET, "the trap itself still answers: only this assertion read it");
});

// Intention: hidden again on submit, when the tab becomes hidden (not when it becomes visible), and on pageshow; never shown by those.
test("module : le champ redevient masqué à l'envoi, à visibilitychange (caché) et à pageshow", () => {
  const { inputs, buttons, form, document, window, fire } = page();
  const reveal = () => { if (inputs[0].type === "password") buttons[0].fire("click"); assert.equal(inputs[0].type, "text"); };

  reveal();
  form.fire("submit");
  assert.equal(inputs[0].type, "password");
  assert.equal(buttons[0].getAttribute("aria-pressed"), "false");
  assert.equal(buttons[0].getAttribute("aria-label"), LABEL_SHOW);

  reveal();
  document.visibilityState = "visible";
  fire(document, "visibilitychange");
  assert.equal(inputs[0].type, "text", "a tab that becomes visible does not hide it");
  document.visibilityState = "hidden";
  fire(document, "visibilitychange");
  assert.equal(inputs[0].type, "password");

  reveal();
  fire(window, "pageshow");
  assert.equal(inputs[0].type, "password");
  fire(window, "pageshow");
  assert.equal(inputs[0].type, "password", "hiding what is already hidden changes nothing");
});

// Intention: the field keeps the focus and the cursor when the button is clicked with the mouse or a finger (the press must not take the
// focus), and a field that did not have the focus is not given it.
test("module : le champ garde le focus et la position du curseur", () => {
  const focused = page({ focused: true });
  const press = focused.buttons[0].fire("mousedown");
  assert.equal(press.prevented, true, "the press does not move the focus to the button");
  focused.buttons[0].fire("click");
  assert.equal(focused.document.activeElement, focused.inputs[0]);
  assert.deepEqual(focused.inputs[0].selections, [[3, 5]]);
  const unfocused = page();
  unfocused.buttons[0].fire("click");
  assert.equal(unfocused.document.activeElement, null);
  assert.deepEqual(unfocused.inputs[0].selections, []);
});

// Intention: nothing is added to a page without a password field.
test("module : page sans champ mot de passe -> rien n'est ajouté", () => {
  const { toggles, document, window } = page({ fields: 0 });
  assert.deepEqual(toggles, []);
  assert.equal(document.listeners.visibilitychange, undefined);
  assert.equal(window.listeners.pageshow, undefined);
});

// ---------------------------------------------------------------- served like the other modules

// Intention: the module is served with the right type, revalidated each time (no-cache + ETag, 304), its content is the file's, with
// the same security headers; a path outside the list is a 404.
appTest("module : /password-toggle.js servi comme les autres modules ; hors liste = 404", async (app) => {
  const res = await app.request("/password-toggle.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(await res.text(), await readFile(MODULE, "utf8"));
  const again = await app.request("/password-toggle.js", { headers: { "If-None-Match": res.headers.get("etag") } });
  assert.equal(again.status, 304);
  for (const path of ["/password-toggle", "/password-toggle.js/", "/password-toggle.js.map", "/js/password-toggle.js", "/web/js/password-toggle.js", "/password-toggles.js", "/mot-de-passe.js"]) {
    assert.equal((await app.request(path)).status, 404, path);
  }
  assert.equal(app.cyclos.state.requests.length, 0, "no call to Cyclos");
});
