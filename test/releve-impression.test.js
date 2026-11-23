// === WHAT THIS FILE CHECKS ===
// The "Imprimer" button of the statement ticket (day ticket and month ticket share the page): the module that creates it (run in Node
// with stand-ins for the browser), how the server serves it (allow-list, no other path), the HTML of the ticket (one script tag with src,
// at the end of the body, nothing inline), the security policy of that page (script-src 'self' and nothing else new) and the policies
// of every other response (unchanged), and the print layout of the month ticket (A4, column titles) next to the 80 mm day ticket.
// All names and secrets are fictitious.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appTest, EXPECTED_CSP } from "./support/harness.js";
import { options, connected, history, RANGE, on } from "./support/releve-support.js";
import { monthRange } from "../src/releve-calcul.js";

const MODULE_URL = new URL("../web/js/print-ticket.js", import.meta.url);
const CSS = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");

// What the statement had before this button, written out in full.
const CSP_STATEMENT = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// The ticket page: the same policy plus script-src 'self'.
const CSP_TICKET = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const SCRIPT_TAG = '<script type="module" src="/print-ticket.js"></script>';

// ---------------------------------------------------------------- the module, run with stand-ins for the browser

class Element {
  constructor() {
    this.children = [];
    this.listeners = [];
    this.textContent = "";
  }
  addEventListener(type, fn) {
    this.listeners.push({ type, fn });
  }
  prepend(...items) {
    this.children.unshift(...items);
  }
}

let importCount = 0;
// Runs the module as the browser would (once, at load) with a page that has an actions zone, or not.
async function runModule({ withActions = true } = {}) {
  const actions = new Element();
  const made = [];
  const printed = { count: 0 };
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    querySelector: (selector) => (withActions && selector === ".actions" ? actions : null),
    createElement: (tag) => {
      const el = new Element();
      el.tag = tag;
      made.push(el);
      return el;
    },
  };
  globalThis.window = { print: () => (printed.count += 1) };
  const restore = () => {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  };
  try {
    importCount += 1;
    await import(`${MODULE_URL.href}?run=${importCount}`);
  } catch (error) {
    restore();
    throw error;
  }
  // The stand-ins stay in place until the test calls `restore` (the click handler reads window when it runs).
  return { actions, made, printed, restore };
}

// Intention: the script creates the button itself (so there is none without JavaScript), labelled "Imprimer", next to the other
// actions; one click prints once; there is a single listener.
test("impression : le module crée un bouton « Imprimer » ; un clic appelle window.print une seule fois", async () => {
  const { actions, made, printed, restore } = await runModule();
  try {
    check({ actions, made, printed });
  } finally {
    restore();
  }
});

function check({ actions, made, printed }) {
  assert.equal(made.length, 1);
  const [button] = made;
  assert.equal(button.tag, "button");
  assert.equal(button.type, "button", "ne soumet aucun formulaire");
  assert.equal(button.textContent, "Imprimer");
  assert.equal(button.className, "imprimer");
  assert.deepEqual(actions.children, [button], "dans la zone des actions du ticket");
  assert.equal(button.listeners.length, 1, "un seul écouteur");
  assert.equal(button.listeners[0].type, "click");
  assert.equal(printed.count, 0, "rien n'est imprimé au chargement");
  button.listeners[0].fn();
  assert.equal(printed.count, 1);
}

// Intention: without the zone of actions (another page, a changed layout) the module does nothing and does not fail.
test("impression : sans zone d'actions, le module ne crée rien", async () => {
  const { made, printed, restore } = await runModule({ withActions: false });
  restore();
  assert.equal(made.length, 0);
  assert.equal(printed.count, 0);
});

// Intention: the module stays as small and as safe as asked: text set with textContent, nothing that parses or runs a string.
test("impression : le module n'utilise ni innerHTML, ni eval, ni document.write", () => {
  const source = readFileSync(MODULE_URL, "utf8").replace(/\/\/.*$/gm, "");
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "eval(", "new Function", "document.write", "setTimeout(\"", "fetch(", "XMLHttpRequest"]) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
  assert.equal(source.match(/addEventListener/g).length, 1);
  assert.ok(source.includes("textContent"));
});

// ---------------------------------------------------------------- how the server serves it

// Intention: the module is served like the cash register scripts (same allow-list, no-cache with ETag, JavaScript type) and is
// the very file of web/js/; nothing else of that folder, or of the project, becomes reachable through it.
appTest("impression : /print-ticket.js est servi (type, no-cache, ETag, contenu exact) ; un chemin hors liste donne 404", options(), async (app) => {
  const res = await fetch(`${app.base}/print-ticket.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.ok(res.headers.get("etag"));
  assert.equal(await res.text(), readFileSync(MODULE_URL, "utf8"));
  const again = await fetch(`${app.base}/print-ticket.js`, { headers: { "If-None-Match": res.headers.get("etag") } });
  assert.equal(again.status, 304);

  for (const path of ["/print-ticket", "/print-ticket.mjs", "/print-ticket.js.map", "/js/print-ticket.js", "/web/js/print-ticket.js", "/print-ticket.js/", "/print-tickets.js", "/imprimer.js", "/print-ticket.js/../server.js", "/%2e%2e/src/server.js", "/server.js"]) {
    const other = await fetch(`${app.base}${path}`, { redirect: "manual" });
    assert.equal(other.status, 404, path);
  }
});

// ---------------------------------------------------------------- the HTML and the policy of the ticket page

const monthForm = (csrf) => {
  const m = monthRange("2026", "1", undefined);
  return { csrf, mois: String(m.from.month), annee: String(m.from.year) };
};

// Intention: both tickets load the module by a script tag with src, placed at the end of the body, and have no inline script, no
// event attribute, no inline style and no button of their own in the server's HTML (the button exists only if the script runs).
appTest("impression : le HTML du ticket (jour et mois) a la balise script avec src, aucun script en ligne, aucun bouton", options(), async (app) => {
  const { b, csrf } = await connected(app, history(3));
  const day = await b.ticket({ csrf, ...RANGE });
  assert.equal(day.status, 200);
  const month = await b.ticket(monthForm(csrf));
  assert.equal(month.status, 200);
  for (const res of [day, month]) {
    const html = await res.text();
    assert.deepEqual(html.match(/<script[\s\S]*?<\/script>/gi), [SCRIPT_TAG]);
    assert.ok(/<script[^>]* src="\/print-ticket\.js"/.test(html));
    assert.ok(/<div class="page">[\s\S]*<\/div>\s*<script[^>]*><\/script>\s*<\/body>/.test(html), "script à la fin du corps");
    assert.ok(!/<script(?![^>]* src=)/i.test(html), "aucun script en ligne");
    assert.ok(!/<style|style=| on[a-z]+=|javascript:/i.test(html));
    assert.ok(!html.includes("Imprimer"), "le serveur ne met aucun bouton dans le HTML");
    assert.ok(!/<button[^>]*type="button"/.test(html));
  }
});

// Intention: the page of the ticket allows script-src 'self' and NOTHING else new (no unsafe-inline, no connect-src, no other source).
appTest("impression : la politique de la page du ticket ajoute seulement script-src 'self'", options(), async (app) => {
  const { b, csrf } = await connected(app, history(3));
  const res = await b.ticket({ csrf, ...RANGE });
  const policy = res.headers.get("content-security-policy");
  assert.equal(policy, CSP_TICKET);
  assert.match(policy, /script-src 'self';/);
  assert.ok(!/unsafe-|connect-src|\*|https?:|data:/.test(policy));
  // Remove the one directive added: what is left is exactly the policy of the statement.
  assert.equal(policy.replace(" script-src 'self';", ""), CSP_STATEMENT);
  for (const header of ["x-content-type-options", "x-frame-options", "referrer-policy", "cache-control"]) {
    assert.ok(res.headers.get(header), header);
  }
  assert.equal(res.headers.get("cache-control"), "no-store");
});

// Intention: every other response keeps its exact current policy: filters, refused tickets (400, 403, redirect), the PDF, the cash
// register, the area, the static files and the module itself.
appTest("impression : toutes les autres politiques sont inchangées (filtres, refus, PDF, caisse, espace)", options(), async (app) => {
  const { b, csrf } = await connected(app, history(3));
  const sansScript = [
    ["filtres", await b.request("/espace/releve")],
    ["ticket refusé (dates)", await b.ticket({ csrf, start: "x", end: "y" })],
    ["ticket refusé (jeton)", await b.ticket({ csrf: "faux", ...RANGE })],
    ["ticket en GET (redirection)", await b.request("/espace/releve/ticket")],
    ["PDF", await b.request("/espace/releve/ticket.pdf", { method: "POST", form: { csrf, ...RANGE }, headers: { Origin: app.base } })],
    ["PDF du mois", await b.request("/espace/releve/ticket.pdf", { method: "POST", form: monthForm(csrf), headers: { Origin: app.base } })],
    ["PDF en GET (redirection)", await b.request("/espace/releve/ticket.pdf")],
    ["inconnu sous le relevé", await b.request("/espace/releve/inconnu")],
  ];
  assert.equal(sansScript[4][1].headers.get("content-type"), "application/pdf");
  for (const [label, res] of sansScript) {
    assert.equal(res.headers.get("content-security-policy"), CSP_STATEMENT, label);
  }
  const avecScript = [
    ["espace", await b.request("/espace")],
    ["caisse", await b.request("/caisse")],
    ["style", await b.request("/style.css")],
    ["module", await b.request("/print-ticket.js")],
    ["racine", await b.request("/")],
    ["introuvable", await b.request("/espace/releveX")],
  ];
  for (const [label, res] of avecScript) {
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, label);
  }
  // The cash register policy, written out in full.
  assert.equal(EXPECTED_CSP, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
});

// ---------------------------------------------------------------- printing: 80 mm day ticket, A4 month ticket

// Intention: the page class is set by the server from the mode: only the month ticket gets it, with the column titles (hidden on
// screen, repeated on paper); the ticket of a period has neither and keeps the 80 mm style as it was.
appTest("impression : le ticket du mois porte la classe de page A4 et les titres de colonnes, pas celui d'une plage", options(), async (app) => {
  const { b, csrf } = await connected(app, [on(1, { amount: "2.00" }), on(2, { amount: "3.00" })]);
  const day = await (await b.ticket({ csrf, ...RANGE })).text();
  const month = await (await b.ticket({ csrf, ...monthForm(csrf) })).text();
  assert.match(day, /<html lang="fr">/);
  assert.ok(!day.includes("page-mois") && !day.includes("entete-colonnes"));
  assert.match(month, /<html lang="fr" class="page-mois">/);
  assert.equal(month.match(/class="entete-colonnes"/g).length, 1);
  assert.match(month, /<ol class="detail">\s*<li class="entete-colonnes"><span>Date<\/span><span>Numéro<\/span><span>Contrepartie<\/span><span>Description<\/span><span>Montant<\/span><\/li>/);
  // The titles are not counted as transactions.
  assert.equal([...month.matchAll(/<li class="ligne">/g)].length, [...day.matchAll(/<li class="ligne">/g)].length);
});

// Intention: the day ticket keeps its 80 mm page exactly; the month ticket has its own named A4 page with normal margins, a table
// whose header group repeats on each printed page, and rows that are never cut between two pages.
test("impression : feuille de style, 80 mm inchangé pour le jour, A4 lisible pour le mois", () => {
  assert.match(CSS, /@media print \{\s*@page \{\s*size: 80mm auto;\s*margin: 4mm;\s*\}/);
  assert.equal(CSS.match(/size: 80mm auto/g).length, 1);
  assert.match(CSS, /@page mois \{\s*size: A4;\s*margin: 15mm;\s*\}/);
  assert.match(CSS, /html\.page-mois \{\s*page: mois;/);
  assert.match(CSS, /html\.page-mois \.entete-colonnes \{\s*display: table-header-group;/);
  assert.match(CSS, /html\.page-mois \.ligne \{\s*display: table-row;/);
  assert.match(CSS, /\.entete-colonnes \{\s*display: none;/, "titres cachés à l'écran");
  // Rows never split: the rule is the one of the shared print block (break-inside: avoid on .ligne).
  assert.match(CSS, /\.resume > div,\s*\.ligne \{[^}]*break-inside: avoid;/);
  // Every rule of the A4 layout is under html.page-mois: it cannot reach the 80 mm ticket.
  const a4 = CSS.slice(CSS.indexOf("/* ---------- Printing: month ticket on A4"), CSS.indexOf("/* Link back to the login page")).replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...a4.matchAll(/^\s*([^{}@/\n][^{}]*?)\s*\{/gm)].flatMap((m) => m[1].split(",")).map((s) => s.trim()).filter(Boolean);
  assert.ok(selectors.length >= 10, "les sélecteurs sont bien lus");
  for (const selector of selectors) assert.ok(selector.startsWith("html.page-mois") || selector === ".imprimer", selector);
  // The Print button is hidden on paper.
  assert.match(a4, /\.imprimer \{\s*display: none !important;/);
});

// Intention: the button follows the look of the existing buttons (the shared button rule, green) and uses nothing but styles of the sheet.
test("impression : le bouton Imprimer reprend le style des boutons (charte verte), au clavier", () => {
  assert.match(CSS, /\nbutton \{[^}]*background: var\(--vert-principal\);/);
  assert.match(CSS, /\.imprimer \{\s*display: block;/);
  assert.ok(!/\.imprimer \{[^}]*(outline: none|outline: 0)/.test(CSS), "le focus reste visible");
  assert.match(CSS, /:focus-visible \{/);
});
