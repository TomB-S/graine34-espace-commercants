// What the script does to the page (caisse-view.js), run against a tiny stand-in for `document`: no browser needed.
// The stand-in REFUSES innerHTML (and the other ways to build elements from a string): if the view used one, the test fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCaisseView } from "../web/js/caisse-view.js";
import { createNewPaymentDetector } from "../web/js/new-payments.js";

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
  for (const id of ["caisse-zone-direct", "caisse-zone-etat", "caisse-zone-contenu", "caisse-zone-son", "caisse-zone-notif", "caisse-zone-actualiser", "caisse-actualisation"]) byId.set(id, new Node("div"));
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

test("vue : numéro de transaction dans la ligne, entre le payeur et le montant, rien s'il n'y en a pas", () => {
  const { view, content } = setup();
  view.update(data([ticket(1), ticket(2), ticket(3, { number: "" })]));
  const [withNumber, without] = findAll(content, "caisse-ligne");
  assert.equal(first(withNumber, "caisse-numero").textContent, "N° T00002");
  const names = withNumber.children.map((child) => child.className);
  assert.deepEqual(names, ["caisse-heure", "caisse-qui", "caisse-numero", "caisse-montant"]);
  assert.deepEqual(without.children.map((child) => child.className), ["caisse-heure", "caisse-qui", "caisse-montant"], "no element, no text");
  view.update(data([ticket(1), ticket(2, { number: "" }), ticket(3)]));
  assert.equal(findAll(content, "caisse-numero").length, 1, "the list follows the new data");
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

test("vue : mode manuel (0 seconde) = phrase « Mise à jour manuelle », jamais « toutes les 0 secondes »", () => {
  const document = fakeDocument();
  createCaisseView(document, { pollSeconds: 0, nowMs: () => NOW }).update(data([ticket(1)]));
  assert.equal(document.byId.get("caisse-actualisation").textContent, "Mise à jour manuelle : cliquer sur Actualiser pour relire les paiements.");
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

test("vue : ligne des notifications = état en toutes lettres, bouton seulement quand il y a une action", () => {
  let clicks = 0;
  const { view, document } = setup({ now: NOW }, { onNotificationToggle: () => (clicks += 1) });
  const zone = document.byId.get("caisse-zone-notif");
  assert.equal(zone.textContent, "");
  view.updateNotifications({ text: "Notifications désactivées : cliquer pour activer", buttonText: "Activer les notifications", active: false });
  const line = first(zone, "caisse-notif");
  assert.equal(line.children[0].textContent, "Activer les notifications");
  assert.equal(first(line, "caisse-notif-etat").attributes.role, "status");
  line.children[0].listeners.click();
  assert.equal(clicks, 1);
  view.updateNotifications({ text: "Notifications activées", buttonText: null, active: true });
  assert.equal(zone.children[0], line, "same line updated in place");
  assert.equal(line.children[0].hidden, true, "no button once granted");
  assert.equal(line.className, "caisse-notif caisse-notif-actif");
  assert.equal(first(line, "caisse-notif-etat").textContent, "Notifications activées");
  // The sound line is a different zone, untouched.
  assert.equal(document.byId.get("caisse-zone-son").textContent, "");
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
  for (const name of ["caisse", "caisse-view", "caisse-texts", "new-payments", "date-line", "age", "sound", "sound-logic", "notification", "notification-logic", "controls-logic", "refresh-logic"]) {
    const code = await readFile(new URL(`../web/js/${name}.js`, import.meta.url), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\(\s*["'`]/.test(code), name);
  }
});

test("vue : bouton « Actualiser » = texte posé avec textContent, désactivé pendant la lecture, le clic appelle le rappel", () => {
  let clicks = 0;
  const { view, document } = setup({ now: NOW }, { onRefresh: () => (clicks += 1) });
  const zone = document.byId.get("caisse-zone-actualiser");
  assert.equal(zone.textContent, "", "nothing before the script builds it");
  view.updateRefresh({ text: "Actualiser", disabled: false });
  const line = first(zone, "caisse-actualiser");
  const button = line.children[0];
  assert.equal(button.tag, "button");
  assert.equal(button.attributes.type, "button");
  assert.equal(button.textContent, "Actualiser");
  assert.equal(button.disabled, false);
  button.listeners.click();
  assert.equal(clicks, 1);
  view.updateRefresh({ text: "Actualisation...", disabled: true });
  assert.equal(zone.children[0], line, "same button updated in place");
  assert.equal(button.textContent, "Actualisation...");
  assert.equal(button.disabled, true);
});

test("vue : sans zone « actualiser » dans la page, la mise à jour du bouton ne casse rien", () => {
  const { view, document } = setup({ now: NOW });
  document.byId.delete("caisse-zone-actualiser");
  const bare = createCaisseView(document, { pollSeconds: 3, nowMs: () => NOW });
  bare.updateRefresh({ text: "Actualiser", disabled: false });
  assert.ok(view);
});
