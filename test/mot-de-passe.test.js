// === WHAT THIS FILE CHECKS ===
// The "eye" button of the login pages (web/js/password-toggle.js): the module run in Node with stand-ins for the browser (one button per
// password field, a click switches the type and the accessible name, the value of the field is never touched, the field is hidden again
// on submit, on visibilitychange and on pageshow, the focus and the cursor stay), and the module served like the other browser modules.
// The password used here is a made-up string, never a real one.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { appTest, EXPECTED_CSP, USER } from "./support/harness.js";
import { CAISSE_OPTIONS } from "./support/options.js";
import { options, browser, connected } from "./support/releve-support.js";
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

// ---------------------------------------------------------------- the login pages

const SCRIPT_TAG = '<script type="module" src="/password-toggle.js"></script>';
const CSP_SANS_SCRIPT = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const scriptsOf = (html) => html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) ?? [];

// Intention: each login page (the cash register's, the area's, the area's after a refused login) loads the module by src, once, at the
// end of the body; the HTML of the server holds no button for the eye and no icon (so that without JavaScript nothing dead appears and
// the login works as before); the password field is empty, never prefilled, with its label tied to it; nothing inline.
appTest("pages de connexion : le module est chargé, aucun bouton ni icône dans le HTML, mot de passe jamais prérempli", options(), async (app) => {
  app.cyclos.addUser("marie", "mdp-marie-fictif", { id: "u-marie", email: "marie@exemple.test", entries: [] });
  const stranger = browser(app);
  const refused = await stranger.request("/espace/connexion", { method: "POST", form: { login: "marie", password: "mdp-faux-fictif" }, headers: { Origin: app.base } });
  assert.equal(refused.status, 401);
  const pages = {
    "/espace": await stranger.request("/espace"),
    "/espace après refus": refused,
    "/connexion": await stranger.request("/connexion"),
  };
  for (const [name, res] of Object.entries(pages)) {
    const html = await res.text();
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, name);
    assert.deepEqual(scriptsOf(html), [SCRIPT_TAG], name);
    assert.match(html, /<\/div>\n  <script type="module" src="\/password-toggle\.js"><\/script>\n<\/body>/, `${name}: at the end of the body`);
    assert.ok(!/voir-mot-de-passe|champ-secret|<svg|<img[^>]*oeil/.test(html), `${name}: the eye is not in the HTML of the server`);
    assert.equal([...html.matchAll(/<button/g)].length, 1, `${name}: only the submit button`);
    assert.match(html, /<button type="submit">Se connecter<\/button>/, name);
    assert.match(html, /<label for="password">Mot de passe :<\/label>\s*<input type="password" id="password" name="password" required/, name);
    assert.ok(!/<input[^>]*type="password"[^>]*value=/.test(html) && !/<input[^>]*value=[^>]*type="password"/.test(html), `${name}: never prefilled`);
    assert.ok(!html.includes("mdp-faux-fictif") && !html.includes("mdp-marie-fictif"), `${name}: no password in the page`);
    assert.ok(!/\sstyle\s*=|<style|\son[a-z]+\s*=/i.test(html), `${name}: nothing inline`);
  }
  // The attribute that password managers read is unchanged on the area's login (and the field of the login is untouched).
  const espace = await (await stranger.request("/espace")).text();
  assert.match(espace, /name="password" required autocomplete="current-password"/);
  assert.match(espace, /name="login" required autofocus autocomplete="username"/);
});

// Intention: the login page of the single-merchant mode (the one of the executable too) loads the module and keeps its form as before.
appTest("pages de connexion : mode simple (et exécutable), même page, module chargé", CAISSE_OPTIONS, async (app) => {
  const res = await app.request("/");
  const html = await res.text();
  assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
  assert.deepEqual(scriptsOf(html), [SCRIPT_TAG]);
  assert.match(html, /<form method="post" action="\/connexion">/);
  assert.match(html, /<input type="text" name="login" required autofocus>/);
  assert.ok(!/voir-mot-de-passe|<svg/.test(html));
  const wrong = await (await app.login({ password: "mdp-faux-fictif" })).text();
  assert.deepEqual(scriptsOf(wrong), [], "the refusal page has no password field and no script");
});

// Intention: no other page loads the module (only the login pages have a password field), and the other pages keep exactly their policy.
appTest("pages de connexion : aucune autre page ne charge le module, les politiques des autres pages sont inchangées", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const others = {
    "/espace (accueil)": await b.request("/espace"),
    "/espace/releve": await b.request("/espace/releve"),
    "ticket": await b.ticket({ csrf, jour: "2026-01-10", de: "11:00", a: "14:00" }),
    "inconnue": await b.request("/page-inconnue"),
  };
  assert.equal((await b.request("/espace/caisse", { method: "POST", form: { csrf }, headers: { Origin: app.base } })).status, 303);
  others["/caisse"] = await b.request("/caisse");
  for (const [name, res] of Object.entries(others)) {
    const html = await res.text();
    assert.ok(!html.includes("password-toggle"), name);
    assert.ok(!html.includes('type="password"'), name);
    const expected = name.startsWith("/espace/releve") || name === "ticket" ? CSP_SANS_SCRIPT : EXPECTED_CSP;
    assert.equal(res.headers.get("content-security-policy"), expected, name);
  }
  assert.deepEqual(scriptsOf(await (await b.request("/caisse")).text()), ['<script type="module" src="/caisse.js"></script>']);
  // Close the cash register once it is listening (see the other tests: closing one that is still starting waits a long time).
  for (let i = 0; i < 100 && (await (await b.request("/caisse/data")).json()).status !== "live"; i += 1) await new Promise((r) => setTimeout(r, 20));
  const caisseCsrf = (await (await b.request("/caisse")).text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  await b.request("/deconnexion", { method: "POST", form: { csrf: caisseCsrf }, headers: { Origin: app.base } });
});

// ---------------------------------------------------------------- the source of the module, the logs, the build, the style

// Intention: the module never builds HTML from text, evaluates text, writes into the document, touches the browser storage, talks to the
// network, logs, or reads the value of a field. (Comments are not code: they are taken out first.)
test("module : ni innerHTML, eval, document.write, ni stockage, réseau, journal, ni lecture de la valeur", async () => {
  const source = (await readFile(MODULE, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = [
    /innerHTML|outerHTML|insertAdjacentHTML/, /\beval\b|new Function|Function\(/, /document\.write/, /setTimeout\s*\(\s*["'`]/,
    /localStorage|sessionStorage|indexedDB|document\.cookie|caches\b/, /\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource/,
    /console\./, /\.value\b|\bvalue\s*:/, /clipboard|execCommand|getSelection|\.select\(\)/, /autocomplete/, /\.style\b|style\./,
  ];
  for (const pattern of forbidden) assert.ok(!pattern.test(source), String(pattern));
  assert.ok(source.includes("createElementNS"));
  assert.ok(!/<[a-z]/.test(source.replace(/"[^"\n]*"|`[^`]*`/g, "")), "no markup in the code");
});

// Intention: a login scenario (wrong then right password, in the single-merchant mode) leaves no password in the logs.
appTest("journaux : une connexion refusée puis réussie ne laisse aucun mot de passe", CAISSE_OPTIONS, async (app) => {
  await app.request("/");
  assert.equal((await app.login({ password: "mdp-faux-fictif" })).status, 401);
  assert.equal((await app.login()).status, 303);
  await app.request("/password-toggle.js");
  const everything = app.logs.join("\n");
  assert.ok(!everything.includes("mdp-faux-fictif") && !everything.includes(USER.password));
});

// Intention: the executable embeds the module like the others (its login page is this page), so the two lists are the same list.
test("exécutable : le module est dans la liste du build, la même que celle du serveur", async () => {
  const names = (text) => [...text.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const build = await readFile(new URL("../tools/build-sea.js", import.meta.url), "utf8");
  const served = names(server.match(/const BROWSER_MODULES = \[([^\]]*)\]/)[1]);
  const embedded = names(build.match(/const browserScripts = \[([^\]]*)\]/)[1]);
  assert.ok(served.includes("password-toggle"));
  assert.deepEqual(embedded, served);
});

// Intention: the style of the button is in the style sheet: green of the charter, on the right inside the field, a finger target of at
// least 44 px, a focus ring drawn inside the field; and the field makes room for it.
test("style : le bouton oeil est dans la feuille de style (charte verte, 44 px, focus visible)", async () => {
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  assert.match(css, /--tactile:\s*2\.75rem/, "44 px");
  const button = rule(".voir-mot-de-passe");
  assert.match(button, /position:\s*absolute/);
  assert.match(button, /right:\s*0/);
  assert.match(button, /width:\s*var\(--tactile\)/);
  assert.match(button, /min-height:\s*2\.75rem/);
  assert.match(button, /color:\s*var\(--vert-principal\)/);
  assert.match(button, /background:\s*transparent/);
  assert.match(rule(".voir-mot-de-passe:focus-visible"), /outline-offset:\s*-3px/);
  assert.match(rule(".champ-secret"), /position:\s*relative/);
  assert.match(rule(".champ-secret input"), /padding-right:\s*var\(--tactile\)/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid/, "the shared focus ring");
  assert.ok(!/url\(/.test(button));
});
