// What the script does to the page (caisse-view.js), run against a tiny stand-in for `document`: no browser needed.
// The stand-in REFUSES innerHTML (and the other ways to build elements from a string): if the view used one, the test fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCaisseView } from "../caisse-view.js";
import { createNewPaymentDetector } from "../new-payments.js";

class Node {
  constructor(tag) {
    this.tag = tag;
    this.className = "";
    this.hidden = false;
    this.attributes = {};
    this.children = [];
    this.own = "";
  }
  set textContent(value) {
    this.children = [];
    this.own = String(value);
  }
  get textContent() {
    return this.own + this.children.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
  }
  set innerHTML(_) {
    throw new Error("innerHTML is forbidden");
  }
  set outerHTML(_) {
    throw new Error("outerHTML is forbidden");
  }
  insertAdjacentHTML() {
    throw new Error("insertAdjacentHTML is forbidden");
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(type, fn) {
    this.listeners = { ...this.listeners, [type]: fn };
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
    this.own = "";
  }
}

function fakeDocument() {
  const byId = new Map();
  for (const id of ["caisse-zone-direct", "caisse-zone-etat", "caisse-zone-contenu", "caisse-zone-son", "caisse-actualisation"]) byId.set(id, new Node("div"));
  return { getElementById: (id) => byId.get(id) ?? null, createElement: (tag) => new Node(tag), byId };
}

const findAll = (node, className) => [
  ...(typeof node === "string" ? [] : node.className.split(" ").includes(className) ? [node] : []),
  ...(typeof node === "string" ? [] : node.children.flatMap((child) => findAll(child, className))),
];
const first = (node, className) => findAll(node, className)[0];

const NOW = Date.parse("2026-01-10T12:00:00Z");
const ticket = (n, extra = {}) => ({
  keys: [`k${n}`],
  initial: false,
  payer: `Payeur ${n}`,
  amount: `${n},00 G`,
  amountReady: true,
  time: "12:00",
  dateLabel: "Aujourd'hui 12:00",
  at: NOW,
  description: `Objet ${n}`,
  number: `T0000${n}`,
  isNew: false,
  ...extra,
});
const data = (tickets, extra = {}) => ({ status: "live", banner: null, now: NOW, tickets, ...extra });

function setup(clock = { now: NOW }, extra = {}) {
  const document = fakeDocument();
  const view = createCaisseView(document, { pollSeconds: 3, nowMs: () => clock.now, ...extra });
  return { document, view, clock, content: document.byId.get("caisse-zone-contenu"), state: document.byId.get("caisse-zone-etat"), direct: document.byId.get("caisse-zone-direct") };
}

test("vue : les textes venant de Cyclos sont posés comme du texte, jamais comme du HTML", () => {
  const { view, content } = setup();
  const evil = "<img src=x onerror=alert(1)> <script>alert(1)</script>";
  view.update(data([ticket(1, { payer: evil, description: evil }), ticket(2, { payer: evil, description: evil, isNew: true })]));
  const big = first(content, "caisse-gros");
  assert.equal(first(big, "caisse-gros-payeur").textContent, evil);
  assert.equal(first(big, "caisse-gros-description").textContent, `Description : ${evil}`);
  const row = first(content, "caisse-ligne");
  assert.equal(first(row, "caisse-payeur").textContent, `${evil} Nouveau`);
  assert.equal(first(row, "caisse-description").textContent, evil);
});

test("vue : gros ticket complet, ligne d'âge, description et numéro masqués quand ils sont vides", () => {
  const { view, content } = setup();
  view.update(data([ticket(1, { isNew: true })]));
  const big = first(content, "caisse-gros");
  assert.equal(big.attributes["aria-label"], "Dernier paiement reçu");
  assert.equal(first(big, "caisse-nouveau").hidden, false);
  assert.equal(first(big, "caisse-gros-montant").textContent, "1,00 G");
  assert.equal(first(big, "caisse-gros-heure").textContent, "Aujourd'hui 12:00 · à l'instant");
  assert.equal(first(big, "caisse-gros-numero").textContent, "N° T00001");
  view.update(data([ticket(1, { description: "", number: "", isNew: false })]));
  assert.equal(first(big, "caisse-gros-description").hidden, true);
  assert.equal(first(big, "caisse-gros-numero").hidden, true);
  assert.equal(first(big, "caisse-nouveau").hidden, true);
});

test("vue : l'âge est recalculé sans toucher au reste", () => {
  const { view, content, clock } = setup();
  view.update(data([ticket(1)]));
  const big = first(content, "caisse-gros");
  clock.now = NOW + 5 * 60_000;
  view.refreshAges();
  assert.equal(first(big, "caisse-gros-heure").textContent, "Aujourd'hui 12:00 · il y a 5 min");
  assert.equal(first(content, "caisse-gros"), big, "same element");
});

test("vue : même paiement = même élément (pas de clignotement, le fond ne repart pas), nouveau paiement = nouvel élément", () => {
  const { view, content } = setup();
  const detector = createNewPaymentDetector();
  const load = (tickets) => {
    const d = data(tickets);
    view.update(d, detector.update(d.tickets));
  };
  load([ticket(1)]);
  const firstBig = first(content, "caisse-gros");
  assert.ok(!firstBig.className.includes("caisse-gros-neuf"), "first load: no fade");
  load([ticket(1)]);
  assert.equal(first(content, "caisse-gros"), firstBig);
  // The payment is completed later (new key, old one kept): still the same element.
  load([ticket(1, { keys: ["k1", "k9"], amount: "1,50 G" })]);
  assert.equal(first(content, "caisse-gros"), firstBig);
  assert.equal(first(firstBig, "caisse-gros-montant").textContent, "1,50 G");
  load([ticket(2, { isNew: true }), ticket(1)]);
  const secondBig = first(content, "caisse-gros");
  assert.notEqual(secondBig, firstBig);
  assert.equal(secondBig.className, "caisse-gros caisse-gros-neuf");
  load([ticket(2, { isNew: false }), ticket(1)]);
  assert.equal(first(content, "caisse-gros"), secondBig, "the mark going out does not replay the fade");
  assert.equal(findAll(content, "caisse-ligne").length, 1);
});

test("vue : liste rebuilt seulement si elle change, 'Paiements précédents' absent sans liste", () => {
  const { view, content } = setup();
  view.update(data([ticket(1)]));
  assert.equal(findAll(content, "caisse-ligne").length, 0);
  view.update(data([ticket(2), ticket(1)]));
  const row = first(content, "caisse-ligne");
  assert.ok(row);
  view.update(data([ticket(2), ticket(1)]));
  assert.equal(first(content, "caisse-ligne"), row, "same list, same elements");
});

test("vue : phrase de mise à jour au pluriel, et « toutes les secondes » pour 1", () => {
  const { view, document } = setup();
  view.update(data([ticket(1)]));
  assert.equal(document.byId.get("caisse-actualisation").textContent, "Mise à jour automatique toutes les 3 secondes.");
  const one = fakeDocument();
  createCaisseView(one, { pollSeconds: 1, nowMs: () => NOW }).update(data([ticket(1)]));
  assert.equal(one.byId.get("caisse-actualisation").textContent, "Mise à jour automatique toutes les secondes.");
});

test("vue : ligne du son = bouton et état en toutes lettres, le clic appelle le rappel", () => {
  let clicks = 0;
  const { view, document } = setup({ now: NOW }, { onSoundToggle: () => (clicks += 1) });
  const zone = document.byId.get("caisse-zone-son");
  assert.equal(zone.textContent, "", "nothing before the script gives its state");
  view.updateSound({ text: "Son désactivé : cliquer pour activer", buttonText: "Activer le son", active: false });
  const line = first(zone, "caisse-son");
  const button = line.children[0];
  assert.equal(button.tag, "button");
  assert.equal(button.attributes.type, "button");
  assert.equal(button.textContent, "Activer le son");
  assert.equal(first(line, "caisse-son-etat").textContent, "Son désactivé : cliquer pour activer");
  assert.equal(first(line, "caisse-son-etat").attributes.role, "status");
  button.listeners.click();
  assert.equal(clicks, 1);
  view.updateSound({ text: "Son activé", buttonText: "Couper le son", active: true });
  assert.equal(zone.children[0], line, "same line updated in place");
  assert.equal(line.className, "caisse-son caisse-son-actif");
  assert.equal(button.textContent, "Couper le son");
  view.updateSound({ text: "Son non disponible sur ce navigateur", buttonText: null, active: false });
  assert.equal(button.hidden, true);
  assert.equal(first(line, "caisse-son-etat").textContent, "Son non disponible sur ce navigateur");
});

test("vue : montant en cours de lecture = phrase, pas un grand chiffre", () => {
  const { view, content } = setup();
  view.update(data([ticket(1, { amount: "Montant en cours de lecture", amountReady: false })]));
  const big = first(content, "caisse-gros");
  assert.equal(first(big, "caisse-gros-attente").textContent, "Montant en cours de lecture");
  assert.equal(first(big, "caisse-gros-montant"), undefined);
});

test("vue : aucun paiement = phrase d'attente seulement si l'écoute fonctionne", () => {
  const { view, content } = setup();
  view.update(data([]));
  assert.match(content.textContent, /Aucun paiement pour l'instant/);
  view.update(data([], { status: "reconnecting", banner: { level: "warning", text: "Connexion interrompue." } }));
  assert.ok(!/Aucun paiement/.test(content.textContent));
});

test("vue : bannière et pastille 'En direct' selon l'état, bannière réseau quand le serveur ne répond plus", () => {
  const { view, state, direct } = setup();
  view.update(data([ticket(1)]));
  assert.equal(state.textContent, "");
  assert.match(direct.textContent, /En direct/);

  view.update(data([ticket(1)], { status: "reconnecting", banner: { level: "warning", text: "Reconnexion en cours." } }));
  const banner = first(state, "caisse-bandeau");
  assert.equal(banner.className, "caisse-bandeau avertissement");
  assert.equal(banner.attributes.role, "status");
  assert.match(banner.textContent, /Reconnexion en cours\./);
  assert.equal(direct.textContent, "", "no badge while reconnecting");

  view.update(data([ticket(1)], { status: "error", banner: { level: "error", text: "Impossible de lire." } }));
  assert.equal(first(state, "caisse-bandeau").className, "caisse-bandeau erreur");

  view.update(data([ticket(1)]));
  view.setOffline(true);
  assert.match(state.textContent, /Connexion au serveur interrompue\./);
  assert.equal(direct.textContent, "");
  assert.match(first(state, "caisse-bandeau").className, /avertissement/);
  view.setOffline(false);
  assert.equal(state.textContent, "");
  assert.match(direct.textContent, /En direct/);
});

test("vue : l'affichage reste en place pendant une coupure réseau", () => {
  const { view, content } = setup();
  view.update(data([ticket(1), ticket(2)]));
  const big = first(content, "caisse-gros");
  view.setOffline(true);
  assert.equal(first(content, "caisse-gros"), big);
  assert.equal(first(big, "caisse-gros-payeur").textContent, "Payeur 1");
});

// Intention: the files the browser loads never build HTML from a string, never evaluate text and never use storage or other pages.
test("fichiers du navigateur : ni innerHTML, ni eval, ni document.write", async () => {
  for (const name of ["caisse", "caisse-view", "caisse-texts", "new-payments", "date-line", "age", "sound", "sound-logic"]) {
    const code = await readFile(new URL(`../${name}.js`, import.meta.url), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\(\s*["'`]/.test(code), name);
  }
});
