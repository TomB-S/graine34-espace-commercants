// GET /caisse/data (the JSON the script reads) and the files the browser loads, with the real server and the fake Cyclos.
// Intention: same access rules as /caisse, a JSON with the texts already formatted and nothing secret, no cache, and the script
// files served with the right type. All values are fictitious.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { appTest, EXPECTED_CSP, USER } from "../test-support/harness.js";
import { entry, transfer, paymentNotification } from "../test-support/fake-cyclos.js";
import { renderCaisseData } from "../caisse-data.js";
import { makeTicket } from "../ticket-store.js";

const ON = { enabled: true, login: USER.login, password: USER.password };
const HOOKS = { listenerOptions: { shortStreamMs: 0, sleep: async () => {} }, processorOptions: { debounceMs: 50, retryDelaysMs: [30, 30, 30] } };
const OPTIONS = { caisse: ON, caisseHooks: HOOKS };
const withOptions = (caisse = {}) => ({ caisse: { ...ON, ...caisse }, caisseHooks: HOOKS });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dataUntil(app, predicate, what) {
  const end = Date.now() + 4000;
  let data = null;
  while (Date.now() < end) {
    const res = await app.request("/caisse/data");
    assert.equal(res.status, 200);
    data = await res.json();
    if (predicate(data)) return data;
    await pause(20);
  }
  throw new Error(`Délai dépassé : ${what}\n${JSON.stringify(data).slice(0, 1500)}`);
}

async function signIn(app) {
  app.cyclos.state.push.lifetimeMs = null;
  assert.equal((await app.login()).status, 303);
}

// ---- access ----

appTest("caisse/data : caisse désactivée = 404 JSON, sans appel à Cyclos", async (app) => {
  await signIn(app);
  const before = app.cyclos.state.requests.length;
  const res = await app.request("/caisse/data");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /^application\/json/);
  assert.equal(app.cyclos.state.requests.length, before);
});

appTest("caisse/data : sans session = 401 JSON (pas de redirection), no-store", OPTIONS, async (app) => {
  const res = await app.request("/caisse/data");
  assert.equal(res.status, 401);
  assert.match(res.headers.get("content-type"), /^application\/json; charset=utf-8$/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { error: "Session expirée" });
  assert.equal(app.cyclos.state.requests.length, 0);
});

appTest("caisse/data : seules les requêtes GET sont acceptées (405 avec Allow)", OPTIONS, async (app) => {
  await signIn(app);
  for (const method of ["HEAD", "POST", "PUT", "DELETE", "PATCH"]) {
    const res = await app.request("/caisse/data", { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET", method);
  }
  assert.equal(app.cyclos.calls("GET", "/push/subscribe").length, 0, "a refused method listens to nothing");
});

appTest("caisse/data : utilisateur non inscrit = 403 JSON, aucune écoute", OPTIONS, async (app) => {
  app.cyclos.addUser("autre", "mdp-autre-de-test", { id: "user-2" });
  assert.equal((await app.login({ login: "autre", password: "mdp-autre-de-test" })).status, 303);
  const res = await app.request("/caisse/data");
  assert.equal(res.status, 403);
  assert.match(res.headers.get("content-type"), /^application\/json/);
  assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
  assert.equal(app.cyclos.calls("GET", "/push/subscribe").length, 0);
});

appTest("caisse/data : jeton refusé par Cyclos = 401 JSON et cookie effacé", OPTIONS, async (app) => {
  await signIn(app);
  app.cyclos.expireTokens();
  const res = await app.request("/caisse/data");
  assert.equal(res.status, 401);
  assert.match(res.headers.get("set-cookie"), /session=; .*Max-Age=0/);
  assert.deepEqual(await res.json(), { error: "Session expirée" });
});

// ---- content ----

appTest("caisse/data : la première visite démarre l'écoute, JSON no-store avec CSP", OPTIONS, async (app) => {
  await signIn(app);
  const res = await app.request("/caisse/data");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/json; charset=utf-8$/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
  assert.equal(res.headers.get("set-cookie"), null);
  const data = await res.json();
  assert.deepEqual(Object.keys(data).sort(), ["banner", "loaded", "now", "status", "tickets"]);
  assert.ok(Math.abs(data.now - Date.now()) < 5000);
  assert.ok(Array.isArray(data.tickets));
});

appTest("caisse/data : paiements formatés par le serveur, champs prévus et aucun secret", OPTIONS, async (app) => {
  await signIn(app);
  app.cyclos.state.entries = [entry(2, { amount: "12.00", description: "Pain" }), entry(1, { amount: "0.50" })];
  const data = await dataUntil(app, (d) => d.tickets.length === 2 && d.status === "live", "historique chargé et écoute en route");
  const [latest, older] = data.tickets;
  assert.deepEqual(Object.keys(latest).sort(), ["amount", "amountReady", "at", "dateLabel", "description", "initial", "isNew", "keys", "number", "payer", "time"]);
  assert.equal(latest.amount, "12,00 G");
  assert.equal(latest.amountReady, true);
  assert.equal(older.amount, "0,50 G");
  assert.match(latest.payer, /^Client \d$/);
  assert.equal(latest.description, "Pain");
  assert.equal(latest.initial, true);
  assert.equal(latest.isNew, false);
  assert.ok(Number.isFinite(latest.at));
  assert.match(latest.dateLabel, /^(Aujourd'hui \d\d:\d\d|\d\d\/\d\d \d\d:\d\d)$/);
  assert.match(latest.time, /^(\d\d:\d\d|\d\d\/\d\d \d\d:\d\d)$/);
  assert.equal(data.banner, null);
  assert.equal(data.status, "live");
  // Nothing of the session or of the Cyclos credentials, and the keys are opaque.
  const text = JSON.stringify(data);
  const session = (app.cookie ?? "").toString();
  for (const secret of [USER.password, "csrf", "sessionToken", "cyclosUserId", "user-1"]) assert.ok(!text.includes(secret), secret);
  if (session) assert.ok(!text.includes(session));
  assert.ok(latest.keys.every((key) => /^k[0-9a-f]{12}$/.test(key)), "opaque keys");
});

appTest("caisse/data : un paiement notifié arrive avec isNew, ses textes sont rendus tels quels (le script les posera en texte)", OPTIONS, async (app) => {
  await signIn(app);
  await dataUntil(app, (d) => d.status === "live", "écoute en route");
  const payer = '<script>alert(1)</script> "x" & <b>gras</b>';
  app.cyclos.state.transfers.set("tr-1", transfer(1, { amount: "1.00", description: "<i>objet</i>" }));
  app.cyclos.push("newNotification", paymentNotification(1, { payer }));
  const data = await dataUntil(app, (d) => d.tickets.some((t) => t.amount === "1,00 G"), "ticket reçu");
  const ticket = data.tickets.find((t) => t.amount === "1,00 G");
  assert.equal(ticket.isNew, true);
  assert.equal(ticket.initial, false);
  assert.equal(ticket.payer, payer, "raw text in JSON: escaping is the job of textContent in the script");
  assert.equal(ticket.description, "<i>objet</i>");
});

appTest("caisse/data : CAISSE_HIDE_PAYER_NAME=true = « Client » partout, aucun nom dans le JSON", withOptions({ hidePayerName: true }), async (app) => {
  await signIn(app);
  app.cyclos.state.entries = [entry(2, { amount: "2.00", who: "Payeur" }), entry(1, { amount: "1.00", who: "Payeur" })];
  const data = await dataUntil(app, (d) => d.tickets.length === 2, "historique");
  assert.ok(data.tickets.every((t) => t.payer === "Client"));
  assert.ok(!JSON.stringify(data).includes("Payeur"));
});

appTest("caisse/data : la visite garde l'écoute en vie comme /caisse (un seul écouteur pour les deux)", OPTIONS, async (app) => {
  await signIn(app);
  await app.request("/caisse");
  await dataUntil(app, (d) => d.status === "live", "écoute en route");
  await app.request("/caisse/data");
  await app.request("/caisse");
  assert.equal(app.cyclos.calls("GET", "/push/subscribe").length, 1);
});

appTest("caisse/data : 11 paiements au plus (le gros ticket et les 10 précédents)", withOptions({ historyInitial: 30, ticketsKept: 50 }), async (app) => {
  await signIn(app);
  app.cyclos.state.entries = Array.from({ length: 15 }, (_, i) => entry(15 - i, { amount: "1.00" }));
  const data = await dataUntil(app, (d) => d.tickets.length > 0, "historique");
  assert.equal(data.tickets.length, 11);
});

// The JSON of the pure function: banner by state, no "starting" list.
test("caisse/data : bannière par état dans le JSON", () => {
  const view = (status) => renderCaisseData({ status, tickets: [] }, { hidePayerName: false, now: 1 }, { formatAmount: String }).banner;
  assert.equal(view("live"), null);
  assert.equal(view("fallback"), null);
  assert.deepEqual(view("reconnecting"), { level: "warning", text: "Connexion interrompue, reconnexion en cours. Les nouveaux paiements peuvent apparaître avec du retard." });
  assert.equal(view("degraded").level, "warning");
  assert.deepEqual(view("error"), { level: "error", text: "Impossible de lire les paiements pour le moment. Prévenir l'équipe La Graine 34." });
  assert.deepEqual(view("starting"), { level: "info", text: "Connexion à Cyclos en cours" });
});

test("caisse/data : les clés d'un ticket complété gardent celle de sa notification", () => {
  const draft = makeTicket({ notification: paymentNotification(1).notification, entityId: "tr-1", source: "push", arrivedAt: 1 });
  const done = makeTicket({ transfer: transfer(1), entityId: "tr-1", source: "push", arrivedAt: 1 });
  const keys = (ticket) => renderCaisseData({ status: "live", tickets: [ticket] }, { hidePayerName: false, now: 2 }, { formatAmount: String }).tickets[0].keys;
  assert.equal(keys(draft).length, 1);
  assert.equal(keys(done).length, 2);
  assert.ok(keys(done).includes(keys(draft)[0]));
});

// ---- files of the browser ----

const MODULES = ["caisse", "caisse-view", "caisse-texts", "new-payments", "date-line", "age", "sound", "sound-logic", "notification", "notification-logic", "controls-logic", "refresh-logic"];

appTest("scripts : servis avec le bon type, revalidés à chaque fois (no-cache + ETag, 304), contenu identique au fichier", async (app) => {
  for (const name of MODULES) {
    const route = `/${name}.js`;
    const res = await app.request(route);
    assert.equal(res.status, 200, route);
    assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8", route);
    assert.equal(res.headers.get("cache-control"), "no-cache", route);
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, route);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", route);
    assert.equal(res.headers.get("set-cookie"), null, route);
    assert.equal(await res.text(), await readFile(new URL(`../${name}.js`, import.meta.url), "utf8"), route);
    const etag = res.headers.get("etag");
    const again = await app.request(route, { headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304, route);
  }
  assert.equal(app.cyclos.state.requests.length, 0, "no call to Cyclos");
});

appTest("scripts : seuls les modules prévus sont servis (pas le serveur ni les tests)", async (app) => {
  for (const route of ["/server.js", "/caisse-data.js", "/ticket-store.js", "/cyclos-push.js", "/test/caisse.test.js", "/caisse.js/", "/caisse.js.map"]) {
    assert.equal((await app.request(route)).status, 404, route);
  }
});

test("scripts : le navigateur n'importe que des fichiers servis, jamais le code du serveur", async () => {
  for (const name of MODULES) {
    const code = await readFile(new URL(`../${name}.js`, import.meta.url), "utf8");
    for (const [, target] of code.matchAll(/^import .* from "\.\/([\w-]+)\.js";/gm)) {
      assert.ok(MODULES.includes(target), `${name} imports ${target}`);
    }
    assert.ok(!/from "node:|require\(/.test(code), `${name}: nothing of Node`);
  }
});

// Intention: the payer is shown as "first name + initial of the family name". Default order "nom-prenom" (Cyclos writes
// "Family First"): the first name is the last word, the initial is the one of the first word.
const payerOf = (name, nameOrder) =>
  renderCaisseData(
    { status: "live", loaded: true, tickets: [makeTicket({ transfer: transfer(1, { payer: name }), source: "push", arrivedAt: 1 })] },
    { hidePayerName: false, nameOrder, now: 2 },
    { formatAmount: String },
  ).tickets[0].payer;

test("caisse/data : nom-prenom (défaut) : « Nom Prénom » devient « Prénom N. »", () => {
  for (const order of [undefined, "nom-prenom"]) {
    assert.equal(payerOf("Dupont Marie", order), "Marie D.");
    assert.equal(payerOf("  dupont   Marie ", order), "Marie D.", "extra spaces and lower case initial");
    assert.equal(payerOf("Plumeau Ysolde", order), "Ysolde P.");
    assert.equal(payerOf("Éluard Émilie", order), "Émilie É.");
    assert.equal(payerOf("Martin Jean-Pierre", order), "Jean-Pierre M.", "hyphenated first name: one word");
    assert.equal(payerOf("De La Fontaine Marie", order), "Marie D.", "particles: initial of the first word of the family name");
    assert.equal(payerOf("Le Gall Marie", order), "Marie L.");
    assert.equal(payerOf("Dupont Durand Marie", order), "Marie D.", "compound family name");
    assert.equal(payerOf("Marie", order), "Marie", "one word stays");
    assert.equal(payerOf("Client 1", order), "Client 1", "not a name: untouched");
    assert.equal(payerOf("1 Client", order), "1 Client");
    assert.equal(payerOf("", order), "Payeur inconnu");
  }
});

test("caisse/data : prenom-nom : « Prénom Nom » devient « Prénom N. » (ordre d'avant)", () => {
  assert.equal(payerOf("Marie Dupont", "prenom-nom"), "Marie D.");
  assert.equal(payerOf("  Marie   dupont ", "prenom-nom"), "Marie D.");
  assert.equal(payerOf("Jean-Pierre Martin Durand", "prenom-nom"), "Jean-Pierre D.");
  assert.equal(payerOf("Émilie Éluard", "prenom-nom"), "Émilie É.");
  assert.equal(payerOf("Marie", "prenom-nom"), "Marie");
  assert.equal(payerOf("Client 1", "prenom-nom"), "Client 1");
  assert.equal(payerOf("", "prenom-nom"), "Payeur inconnu");
});

test("caisse/data : CAISSE_HIDE_PAYER_NAME l'emporte sur l'ordre des mots", () => {
  for (const nameOrder of ["nom-prenom", "prenom-nom"]) {
    const hidden = renderCaisseData({ status: "live", tickets: [makeTicket({ transfer: transfer(1, { payer: "Marie Dupont" }), source: "push", arrivedAt: 1 })] }, { hidePayerName: true, nameOrder, now: 2 }, { formatAmount: String });
    assert.equal(hidden.tickets[0].payer, "Client");
    assert.ok(!JSON.stringify(hidden).includes("Dupont"));
  }
});

appTest("caisse : la page et /caisse/data appliquent CAISSE_NAME_ORDER, sans nom en clair", withOptions({ nameOrder: "nom-prenom" }), async (app) => {
  await signIn(app);
  // A "Family First" name with a particle, received through the push.
  app.cyclos.state.transfers.set("tr-1", transfer(1, { amount: "1.00", payer: "De La Fontaine Marie" }));
  await dataUntil(app, (d) => d.status === "live", "écoute en route");
  app.cyclos.push("newNotification", paymentNotification(1, { payer: "De La Fontaine Marie" }));
  const data = await dataUntil(app, (d) => d.tickets.some((t) => t.amount === "1,00 G" && t.payer === "Marie D."), "nom abrégé");
  assert.ok(!JSON.stringify(data).includes("Fontaine"));
  const html = await (await app.request("/caisse")).text();
  assert.ok(html.includes("Marie D."));
  assert.ok(!html.includes("Fontaine"));
});

test("caisse/data : descriptions de la liste à masquer absentes du JSON, `loaded` annoncé", () => {
  const ticket = makeTicket({ transfer: transfer(1, { description: "Virement Mobile Pro" }), source: "push", arrivedAt: 1 });
  const render = (hiddenDescriptions) => renderCaisseData({ status: "live", loaded: true, tickets: [ticket] }, { hidePayerName: false, hiddenDescriptions, now: 2 }, { formatAmount: String });
  assert.equal(render(["virement mobile pro"]).tickets[0].description, "");
  assert.equal(render([]).tickets[0].description, "Virement Mobile Pro");
  assert.equal(render(["virement mobile pro"]).loaded, true);
  assert.equal(renderCaisseData({ status: "starting", tickets: [] }, { hidePayerName: false, now: 2 }, { formatAmount: String }).loaded, false);
});

// Intention: the real server uses the list of the configuration: the default hides "Virement Mobile Pro", a value set to something
// else or to nothing changes it, and a description written by the payer stays.
appTest("caisse/data : liste par défaut = « Virement Mobile Pro » masquée, le texte du payeur conservé", OPTIONS, async (app) => {
  await signIn(app);
  app.cyclos.state.entries = [entry(2, { description: "Pain" }), entry(1, { description: "  VIREMENT mobile PRO " })];
  const data = await dataUntil(app, (d) => d.tickets.length === 2 && d.status === "live", "historique chargé");
  assert.equal(data.tickets[0].description, "Pain");
  assert.equal(data.tickets[1].description, "");
});

appTest("caisse/data : plusieurs valeurs dans CAISSE_HIDDEN_DESCRIPTIONS", withOptions({ hiddenDescriptions: ["Virement Mobile Pro", "Paiement"] }), async (app) => {
  await signIn(app);
  app.cyclos.state.entries = [entry(3, { description: "Paiement" }), entry(2, { description: "Virement Mobile Pro" }), entry(1, { description: "Pain" })];
  const data = await dataUntil(app, (d) => d.tickets.length === 3 && d.status === "live", "historique chargé");
  assert.deepEqual(data.tickets.map((t) => t.description), ["", "", "Pain"]);
});

appTest("caisse/data : liste vide = aucune description masquée", withOptions({ hiddenDescriptions: [] }), async (app) => {
  await signIn(app);
  app.cyclos.state.entries = [entry(1, { description: "Virement Mobile Pro" })];
  const data = await dataUntil(app, (d) => d.tickets.length === 1 && d.status === "live", "historique chargé");
  assert.equal(data.tickets[0].description, "Virement Mobile Pro");
});

// Intention: the very first visit after a pause already carries the history (the server waited for it).
appTest("caisse/data : la première visite attend la lecture initiale et répond avec les paiements", OPTIONS, async (app) => {
  await signIn(app);
  app.cyclos.state.entries = [entry(2, { amount: "12.00" }), entry(1, { amount: "0.50" })];
  const res = await app.request("/caisse/data");
  const data = await res.json();
  assert.equal(data.loaded, true);
  assert.equal(data.tickets.length, 2, "no empty starting list");
  assert.notEqual(data.status, "starting");
});
