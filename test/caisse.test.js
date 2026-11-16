// === WHAT THIS FILE CHECKS ===
// The /caisse page and its route, with the real server, the real listener and the fake Cyclos: 404 when the page is disabled, the redirection
// when not logged in, 405 for other methods, 403 for a user who is not the registered merchant (and nothing is listened to), the
// headers (no Refresh, no-store, the CSP with only script-src and connect-src added), HTML with no inline script, no style attribute and a <meta refresh> only inside <noscript>, the escaping of a
// hostile payer or description, the option that hides the payer, every state in words, the big ticket and the list, the "New" mark, the
// stop of the server (SIGTERM included), and a log with no sensitive data. All values are fictitious. Basic notions: test/statique.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appTest, EXPECTED_CSP, USER } from "../test-support/harness.js";
import { envEnfant } from "../test-support/env-propre.js";
import { startFakeCyclos, entry, transfer, paymentNotification, notificationSettingsBody } from "../test-support/fake-cyclos.js";
import { escapeHtml, formatAmount } from "../server.js";
import { renderCaissePage, renderCaisseRefused } from "../caisse-page.js";
import { makeTicket } from "../ticket-store.js";

const ON = { enabled: true, login: USER.login, password: USER.password };
// Shorter pauses and grouping for the tests; the stream stays open (events are pushed by the tests).
const HOOKS = { listenerOptions: { shortStreamMs: 0, sleep: async () => {} }, processorOptions: { debounceMs: 50, retryDelaysMs: [30, 30, 30] } };
const OPTIONS = { caisse: ON, caisseHooks: HOOKS };
const withOptions = (caisse = {}) => ({ caisse: { ...ON, ...caisse }, caisseHooks: HOOKS });

// The page says nothing while the listening works (no banner), so "up" means "no longer connecting".
const isLive = (html) => !html.includes("Connexion à Cyclos en cours");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads /caisse again and again until `predicate(html)` is true (what the browser does every 5 seconds).
async function pageUntil(app, predicate, what) {
  const end = Date.now() + 4000;
  let html = "";
  while (Date.now() < end) {
    html = await (await app.request("/caisse")).text();
    if (predicate(html)) return html;
    await pause(20);
  }
  throw new Error(`Délai dépassé : ${what}\n${html.slice(0, 1500)}`);
}

async function ready(app) {
  app.cyclos.state.push.lifetimeMs = null;
  await signIn(app);
}

// Logs in WITHOUT visiting /caisse (app.loggedIn() reads the CSRF token on /caisse, which starts the listening).
async function signIn(app) {
  const res = await app.login();
  assert.equal(res.status, 303);
}

// ---- the route ----

// Intention: disabled (the default), /caisse is a page that does not exist, for every method, and Cyclos is never called for it.
appTest("caisse désactivée : /caisse répond 404 pour toutes les méthodes, sans appel à Cyclos", async (app) => {
  await signIn(app);
  const before = app.cyclos.state.requests.length;
  for (const method of ["GET", "POST", "PUT", "DELETE", "HEAD"]) {
    const res = await app.request("/caisse", { method });
    assert.equal(res.status, 404, method);
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
  }
  assert.equal(app.cyclos.state.requests.length, before);
});

// Intention: not logged in, like the other pages: back to the login page.
appTest("caisse : non connecté = redirection vers la connexion", OPTIONS, async (app) => {
  const res = await app.request("/caisse");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.equal(app.cyclos.state.requests.length, 0);
});

// Intention: only GET is allowed (HEAD and the others: 405 with Allow), logged in or not, and the CSP stays the same.
appTest("caisse : méthodes autres que GET = 405 (HEAD compris)", OPTIONS, async (app) => {
  await signIn(app);
  for (const method of ["HEAD", "POST", "PUT", "DELETE", "PATCH"]) {
    const res = await app.request("/caisse", { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "GET", method);
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
  }
  assert.equal(app.cyclos.calls("GET", "/push/subscribe").length, 0, "a refused method listens to nothing");
});

// Intention: the registered merchant gets the page at once, in the state "starting", with the headers of the instructions.
appTest("caisse : visite de l'inscrit = 200, pas d'en-tête Refresh, no-store, CSP, état 'Connexion en cours'", OPTIONS, async (app) => {
  await ready(app);
  const res = await app.request("/caisse");
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("refresh"), null, "one reload mechanism only: the script, or the noscript fallback");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8$/);
  assert.match(html, /Connexion à Cyclos en cours/);
  assert.ok(!html.includes("Aucun paiement reçu"), "not announced while connecting");
});

// Intention: the reload delay of the fallback follows CAISSE_REFRESH_SECONDS (in the <noscript> meta refresh, never in a
// header), and the reading rhythm of the script follows CAISSE_POLL_SECONDS.
appTest("caisse : CAISSE_REFRESH_SECONDS (repli sans script) et CAISSE_POLL_SECONDS (script) réglés", withOptions({ refreshSeconds: 7, pollSeconds: 4 }), async (app) => {
  await ready(app);
  const res = await app.request("/caisse");
  const html = await res.text();
  assert.equal(res.headers.get("refresh"), null);
  assert.match(html, /<noscript><meta http-equiv="refresh" content="7"><\/noscript>/);
  assert.match(html, /data-poll-seconds="4"/);
  assert.match(html, /Mise à jour automatique toutes les 7 secondes\./);
});

// Intention: manual mode (CAISSE_POLL_SECONDS=0): the page tells the script not to read by itself and says so in words.
appTest("caisse : CAISSE_POLL_SECONDS=0 = mode manuel annoncé à la page", withOptions({ pollSeconds: 0 }), async (app) => {
  await ready(app);
  const html = await (await app.request("/caisse")).text();
  assert.match(html, /data-poll-seconds="0"/);
  assert.match(html, /Mise à jour manuelle : cliquer sur Actualiser pour relire les paiements\./);
  assert.ok(!html.includes("Mise à jour automatique"));
});

// Intention: the HTML follows the strict CSP: no script, no style attribute, no <style>, no <meta refresh>, nothing external,
// one h1, a French page. (The existing security test keeps passing without change: this page is only added.)
appTest("caisse : HTML sans script, sans style en ligne, sans meta refresh, un seul h1, lang=fr", OPTIONS, async (app) => {
  await ready(app);
  app.cyclos.state.entries = [entry(2, { amount: "2.00" }), entry(1, { amount: "1.00" })];
  const html = await pageUntil(app, (h) => h.includes("Paiements précédents"), "page avec paiements");
  assert.deepEqual(html.match(/<script[^>]*>/gi), ['<script type="module" src="/caisse.js">'], "one external script, nothing inline");
  assert.ok(!/<script[^>]*>\s*[^<\s]/i.test(html), "no script content");
  assert.ok(!/\sstyle\s*=/i.test(html));
  assert.ok(!/<style/i.test(html));
  assert.deepEqual(html.match(/<meta[^>]+refresh[^>]*>/gi), ['<meta http-equiv="refresh" content="5">'], "refresh only as the noscript fallback");
  assert.ok(html.includes('<noscript><meta http-equiv="refresh" content="5"></noscript>'));
  assert.ok(!/\son[a-z]+\s*=/i.test(html), "no event attribute");
  assert.ok(!/(src|href)="https?:/i.test(html), "nothing external");
  assert.equal(html.match(/<h1[\s>]/g).length, 1);
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /<link rel="stylesheet" href="\/style\.css\?v=[0-9a-f]{16}">/);
  assert.match(html, /<link rel="icon" type="image\/png" href="\/icon\.png">/, "favicon declared, no request for /favicon.ico");
  assert.match(html, /<form method="post" action="\/deconnexion">/, "a logout button");
});

// ---- who may see it ----

// Intention: a logged in user who is NOT the listening account's owner gets a French 403 page, and nothing is listened to
// (no stream, no history read). A second refusal does not log in again for the identity.
appTest("caisse : utilisateur non inscrit = 403 en français, aucune écoute", OPTIONS, async (app) => {
  app.cyclos.addUser("autre", "mdp-autre-de-test", { id: "user-2" });
  assert.equal((await app.login({ login: "autre", password: "mdp-autre-de-test" })).status, 303);
  for (let i = 0; i < 2; i += 1) {
    const res = await app.request("/caisse");
    const html = await res.text();
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("refresh"), null);
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
    assert.match(html, /<html lang="fr">/);
    assert.match(html, /Accès à la caisse refusé/);
    assert.match(html, /Erreur :/);
    assert.match(html, /n'est pas inscrit/);
  }
  assert.equal(app.cyclos.calls("GET", "/push/subscribe").length, 0);
  assert.equal(app.cyclos.calls("GET", "/self/accounts/membre/history").length, 0);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 2, "the visitor's login + ONE login to learn the listening account's id");
});

// Intention: when the id of the visitor cannot be read, the answer is "not registered": never a comparison of display names.
appTest("caisse : identifiant utilisateur illisible = 403 (jamais de comparaison de noms)", OPTIONS, async (app) => {
  app.cyclos.state.omitUserId = true;
  await signIn(app);
  const res = await app.request("/caisse");
  assert.equal(res.status, 403);
  assert.equal(app.cyclos.calls("GET", "/push/subscribe").length, 0);
  assert.ok(app.logs.some((l) => /identifiant utilisateur du visiteur illisible, accès refusé/.test(l)));
});

// Intention: the token of the visitor is refused by Cyclos while the id is read: like the statement, the local session ends and the
// browser goes back to the login page, with the cookie cleared.
appTest("caisse : jeton du visiteur refusé par Cyclos = retour à la connexion, cookie effacé", OPTIONS, async (app) => {
  await signIn(app);
  app.cyclos.expireTokens();
  const res = await app.request("/caisse");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.match(res.headers.get("set-cookie"), /session=; .*Max-Age=0/);
});

// Intention: Cyclos failing while the visitor's id is read is a 503 page (not a 403, not a crash), and it is not remembered:
// the next visit works.
appTest("caisse : Cyclos en panne à la lecture de l'identifiant = 503, pas retenu", OPTIONS, async (app) => {
  await ready(app);
  app.cyclos.force("GET /users/self", 500);
  const down = await app.request("/caisse");
  assert.equal(down.status, 503);
  assert.match(await down.text(), /momentanément indisponible/);
  app.cyclos.state.forced.clear();
  assert.equal((await app.request("/caisse")).status, 200);
});

// ---- what it shows ----

// Intention: the most recent payment is the big ticket (amount with a comma and the suffix, time, description, number); the others
// are in the list; payments loaded at opening are never "New".
appTest("caisse : gros ticket du dernier paiement et liste des précédents (chargés à l'ouverture, jamais Nouveau)", OPTIONS, async (app) => {
  await ready(app);
  const line = (n, amount) => entry(n, { amount, who: "Payeur" });
  app.cyclos.state.entries = [line(3, "3.50"), line(2, "12.00"), line(1, "0.50")];
  const html = await pageUntil(app, (h) => h.includes("Paiements précédents"), "paiements chargés");
  assert.ok(!html.includes("État"), "no state banner while it works");
  const big = html.match(/<section class="caisse-gros"[\s\S]*?<\/section>/)[0];
  assert.match(big, /Payeur 3/);
  assert.match(big, /3,50 G/);
  assert.match(big, /Description : Achat 3/);
  assert.match(big, /N° T00003/);
  assert.match(big, /\d\d:\d\d|\d\d\/\d\d \d\d:\d\d/);
  const rows = html.match(/<li class="caisse-ligne">[\s\S]*?<\/li>/g);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /Payeur 2[\s\S]*12,00 G/);
  assert.match(rows[1], /Payeur 1[\s\S]*0,50 G/);
  assert.ok(!/Nouveau/.test(html), "opening payments are not New");
  assert.ok(!/Aucun paiement/.test(html));
});

// Intention: at most 10 previous payments in the list, whatever is kept in memory.
appTest("caisse : la liste montre 10 paiements précédents au plus", withOptions({ historyInitial: 30 }), async (app) => {
  await ready(app);
  app.cyclos.state.entries = Array.from({ length: 15 }, (_, i) => entry(15 - i, { amount: "1.00" }));
  const html = await pageUntil(app, (h) => h.includes("Paiements précédents"), "paiements chargés");
  assert.equal(html.match(/<li class="caisse-ligne">/g).length, 10);
});

// Intention: no payment yet, once the listening is up: the sentence of the instructions.
appTest("caisse : aucun paiement = phrase dédiée, sans ticket ni liste", OPTIONS, async (app) => {
  await ready(app);
  const html = await pageUntil(app, isLive, "état live");
  assert.match(html, /Aucun paiement pour l'instant/);
  assert.match(html, /Le prochain paiement s'affichera ici/);
  assert.ok(!html.includes("caisse-gros"));
  assert.ok(!html.includes("Paiements précédents"));
});

// Intention: a payment notification shows up with the "New" word (text, not colour only) and the right data; an empty
// description gives no "Description" line.
appTest("caisse : paiement notifié = ticket marqué Nouveau, ligne Description omise si vide", OPTIONS, async (app) => {
  await ready(app);
  await pageUntil(app, isLive, "état live");
  app.cyclos.state.transfers.set("tr-1", transfer(1, { amount: "1.00", description: "" }));
  app.cyclos.push("newNotification", paymentNotification(1));
  const html = await pageUntil(app, (h) => h.includes("1,00 G"), "ticket affiché");
  const big = html.match(/<section class="caisse-gros[^"]*"[\s\S]*?<\/section>/)[0];
  assert.match(big, /<p class="caisse-nouveau">Nouveau<\/p>/);
  assert.match(big, /Payeur 1/);
  assert.ok(!big.includes("Description"));
  assert.match(big, /N° T00001/);
});

// Intention: two payments a few seconds apart are two tickets (the older one moves to the list), never a duplicate.
appTest("caisse : deux paiements rapprochés = deux tickets, aucun doublon", OPTIONS, async (app) => {
  await ready(app);
  await pageUntil(app, isLive, "état live");
  app.cyclos.state.transfers.set("tr-1", transfer(1, { amount: "1.00" }));
  app.cyclos.state.transfers.set("tr-2", transfer(2, { amount: "1.00" }));
  app.cyclos.state.entries = [entry(2, { amount: "1.00" }), entry(1, { amount: "1.00" })];
  app.cyclos.push("newNotification", paymentNotification(1));
  app.cyclos.push("accountStatus", { n: 1 });
  app.cyclos.push("newNotification", paymentNotification(2));
  app.cyclos.push("accountStatus", { n: 2 });
  const html = await pageUntil(app, (h) => h.includes("Payeur 2") && h.includes("Paiements précédents"), "deux tickets");
  await pause(200);
  const again = await (await app.request("/caisse")).text();
  assert.equal((again.match(/Payeur 1/g) ?? []).length, 1);
  assert.equal((again.match(/Payeur 2/g) ?? []).length, 1);
  assert.equal(again.match(/<li class="caisse-ligne">/g).length, 1);
  assert.ok(html.includes("Nouveau"));
});

// Intention: a payer or a description written like HTML shows as plain text: the page cannot be turned into a script.
appTest("caisse : payeur et description malveillants affichés en texte brut", OPTIONS, async (app) => {
  await ready(app);
  await pageUntil(app, isLive, "état live");
  const payer = `<script>alert(1)</script> "Payeur" & <b>gras</b>`;
  const description = `"><img src=x onerror=alert(1)> 'quote'`;
  app.cyclos.state.transfers.set("tr-1", transfer(1, { amount: "1.00", payer, description }));
  app.cyclos.push("newNotification", paymentNotification(1, { payer }));
  const html = await pageUntil(app, (h) => h.includes("1,00 G"), "ticket affiché");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &quot;Payeur&quot; &amp; &lt;b&gt;gras&lt;/b&gt;"));
  assert.ok(html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"));
  assert.equal(html.match(/<script/gi).length, 1, "only the external script of the page, none from the payer");
  assert.ok(!/<img src=x/i.test(html));
  assert.ok(!/<b>/i.test(html));
});

// Intention: CAISSE_HIDE_PAYER_NAME=true: "Client" everywhere (big ticket and list), the real name nowhere.
appTest("caisse : CAISSE_HIDE_PAYER_NAME=true remplace le payeur par Client partout", withOptions({ hidePayerName: true }), async (app) => {
  await ready(app);
  app.cyclos.state.entries = [entry(2, { amount: "2.00", who: "Payeur" }), entry(1, { amount: "1.00", who: "Payeur" })];
  const html = await pageUntil(app, (h) => h.includes("Paiements précédents"), "paiements chargés");
  assert.ok(!html.includes("Payeur"), "no real name");
  assert.match(html.match(/<section class="caisse-gros"[\s\S]*?<\/section>/)[0], /<p class="caisse-gros-payeur">Client<\/p>/);
  assert.match(html.match(/<li class="caisse-ligne">[\s\S]*?<\/li>/)[0], /<span class="caisse-payeur">Client<\/span>/);
});

// Intention: "payment received" notification switched off at Cyclos (fallback mode): NO banner for the merchant, and a
// payment still shows up.
appTest("caisse : mode de secours = aucune bannière, le paiement s'affiche quand même", OPTIONS, async (app) => {
  app.cyclos.state.notificationSettings = notificationSettingsBody({ paymentReceived: { internal: false, email: false, app: false } });
  await ready(app);
  const html = await pageUntil(app, isLive, "écoute en route");
  assert.ok(!html.includes("Mode de secours") && !html.includes("caisse-bandeau") && !html.includes("avertissement"));
  app.cyclos.state.transfers.set("tr-1", transfer(1, { amount: "4.00" }));
  app.cyclos.state.entries = [entry(1, { amount: "4.00" })];
  app.cyclos.push("accountStatus", { n: 1 });
  const shown = await pageUntil(app, (h) => h.includes("4,00 G"), "paiement affiché en mode de secours");
  assert.ok(!shown.includes("caisse-bandeau"));
});

// Intention: the listener ends in "error" (credentials refused again and again): the banner of the instructions, role="status",
// an icon, and NO technical detail.
appTest("caisse : état error = bandeau d'erreur durable, sans détail technique", OPTIONS, async (app) => {
  await ready(app);
  await pageUntil(app, isLive, "état live");
  app.cyclos.force("POST /auth/session", 401);
  app.cyclos.expireTokens();
  app.cyclos.endStreams();
  const html = await pageUntil(app, (h) => h.includes("Impossible de lire les paiements"), "état error");
  assert.match(html, /<p class="caisse-bandeau erreur" role="status"><span class="icone" aria-hidden="true">⚠<\/span> Impossible de lire les paiements pour le moment\. Prévenir l'équipe La Graine 34\.<\/p>/);
  assert.ok(!/401|jeton|session|identifiant|mot de passe/i.test(html.replace(/<[^>]+>/g, " ")), "no technical detail");
});

// ---- every state, in words (pure rendering) ----

const helpers = {
  escapeHtml,
  formatAmount,
  htmlPage: (title, body) => `<html lang="fr"><title>${escapeHtml(title)}</title>${body}</html>`,
  errorMessage: (text) => `<p class="erreur"><strong>Erreur :</strong> ${text}</p>`,
  logoutForm: () => "<form></form>",
};
const NOW = Date.parse("2026-01-10T12:00:00Z");
const render = (view, extra = {}) => renderCaissePage(view, { refreshSeconds: 5, hidePayerName: false, now: NOW, csrfToken: "x", ...extra }, helpers);

// Intention: the banner of each state (table of step A1): none while it works, a warning when reconnecting, a durable error.
test("page : bannière selon l'état (aucune en direct, avertissement, erreur durable)", () => {
  for (const status of ["live", "fallback"]) {
    const html = render({ status, tickets: [] });
    assert.ok(!html.includes("caisse-bandeau") && !html.includes("role=\"status\"") && !html.includes("État"), status);
  }
  for (const status of ["reconnecting", "degraded"]) {
    const html = render({ status, tickets: [] });
    assert.ok(
      html.includes('<p class="caisse-bandeau avertissement" role="status"><span class="icone" aria-hidden="true">⚠</span> Connexion interrompue, reconnexion en cours. Les nouveaux paiements peuvent apparaître avec du retard.</p>'),
      status,
    );
  }
  const error = render({ status: "error", tickets: [] });
  assert.match(error, /role="status"[^>]*>[\s\S]*Impossible de lire les paiements pour le moment\. Prévenir l'équipe La Graine 34\./);
  assert.ok(render({ status: "starting", tickets: [] }).includes("Connexion à Cyclos en cours"));
  assert.ok(!render({ status: "starting", tickets: [] }).includes("Aucun paiement"));
  assert.match(render({ status: "live", tickets: [] }), /Aucun paiement pour l'instant/);
  for (const status of ["reconnecting", "degraded", "error"]) {
    assert.ok(!render({ status, tickets: [] }).includes("Aucun paiement"), `no empty line while ${status}: the banner speaks`);
  }
  for (const status of ["starting", "live", "reconnecting", "degraded", "fallback", "error"]) {
    assert.ok(!/État :|::/.test(render({ status, tickets: [] })), `no "État :" prefix or double colon (${status})`);
  }
});

// Intention: the big ticket, top to bottom: mark, payer, amount, date line with the age, description, number.
test("page : grand ticket dans l'ordre, ligne de date avec l'ancienneté, description et numéro", () => {
  const at = new Date(NOW - 2 * 60_000).toISOString();
  const ticket = makeTicket({ transfer: transfer(1, { date: at, description: "Pain & fromage" }), source: "push", arrivedAt: NOW - 30_000 });
  const big = render({ status: "live", tickets: [ticket] }).match(/<section class="caisse-gros"[\s\S]*?<\/section>/)[0];
  const order = ["caisse-nouveau", "caisse-gros-payeur", "caisse-gros-montant", "caisse-gros-heure", "caisse-gros-description", "caisse-gros-numero"].map((c) => big.indexOf(c));
  assert.ok(order.every((n) => n >= 0) && order.every((n, i) => i === 0 || n > order[i - 1]), `order ${order}`);
  assert.match(big, /<p class="caisse-gros-heure">Aujourd'hui 12:58 · il y a 2 min<\/p>/);
  assert.match(big, /Description : Pain &amp; fromage/);
  assert.match(big, /N° T00001/);
});

// Intention: another day: the date, with "il y a N h" only under 24 hours; 24 hours or more: the date alone.
test("page : date d'un autre jour = jj/MM HH:mm, âge seulement sous 24 h", () => {
  const dateLine = (ms) => render({ status: "live", tickets: [makeTicket({ transfer: transfer(1, { date: new Date(ms).toISOString() }), source: "initial", arrivedAt: ms })] })
    .match(/<p class="caisse-gros-heure">([^<]*)<\/p>/)[1];
  assert.equal(dateLine(NOW - 20 * 3_600_000), "09/01 17:00 · il y a 20 h");
  assert.equal(dateLine(NOW - 30 * 3_600_000), "09/01 07:00");
});

// Intention: no description = no description line; the list shows the description under the payer, escaped; the time stays on one line.
test("page : description dans la liste (échappée), ligne absente si vide", () => {
  const withText = makeTicket({ transfer: transfer(2, { description: '<b>Gras</b> "x"' }), source: "initial", arrivedAt: NOW - 1000 });
  const without = makeTicket({ transfer: transfer(3, { description: "" }), source: "initial", arrivedAt: NOW - 2000 });
  const top = makeTicket({ transfer: transfer(1), source: "initial", arrivedAt: NOW });
  const rows = render({ status: "live", tickets: [top, withText, without] }).match(/<li class="caisse-ligne">[\s\S]*?<\/li>/g);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /<span class="caisse-description">&lt;b&gt;Gras&lt;\/b&gt; &quot;x&quot;<\/span>/);
  assert.ok(!rows[1].includes("caisse-description"));
  assert.ok(!/<b>/.test(rows[0]));
});

// Intention: the page without script hides the descriptions of the list too, and keeps the ones the payer wrote.
test("page : descriptions de la liste à masquer absentes du HTML, texte du payeur conservé", () => {
  const view = { status: "live", tickets: [makeTicket({ transfer: transfer(2, { description: "Pain" }), source: "initial", arrivedAt: NOW }), makeTicket({ transfer: transfer(1, { description: "virement mobile pro" }), source: "initial", arrivedAt: NOW - 1000 })] };
  const html = render(view, { hiddenDescriptions: ["Virement Mobile Pro"] });
  assert.ok(html.includes("Description : Pain"));
  assert.ok(!/virement mobile pro/i.test(html));
  assert.ok(/virement mobile pro/i.test(render(view, { hiddenDescriptions: [] })));
});

// Intention: the CSS keeps the date on one line and the description on one cut line (no inline style possible).
test("page : CSS = heure sur une ligne, description en une ligne avec points de suspension", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../style.css", import.meta.url), "utf8");
  assert.match(css.match(/\.caisse-heure\s*{[^}]*}/)[0], /white-space:\s*nowrap/);
  const description = css.match(/\.caisse-description\s*{[^}]*}/)[0];
  assert.match(description, /text-overflow:\s*ellipsis/);
  assert.match(description, /white-space:\s*nowrap/);
  assert.match(css, /\.caisse-bandeau/);
});

// Intention: the header says "En direct" only while the listening works, and drops it during a reconnection or an error.
test("page : pastille 'En direct' dans l'en-tête seulement quand l'écoute fonctionne", () => {
  for (const status of ["live", "fallback"]) {
    const html = render({ status, tickets: [] });
    assert.match(html, /<header[\s\S]*<span class="caisse-direct"><span class="caisse-direct-point" aria-hidden="true"><\/span>En direct<\/span>[\s\S]*<\/header>/, status);
  }
  for (const status of ["starting", "reconnecting", "degraded", "error"]) {
    assert.ok(!render({ status, tickets: [] }).includes("En direct"), status);
  }
});

// Intention: the fading background (class caisse-gros-neuf) is only on a payment that has just arrived, so a reload after the
// fade does not replay it; the CSS holds the animation (no script, no inline style).
test("page : fond coloré qui s'estompe sur un paiement qui vient d'arriver, sans script", async () => {
  const { readFile } = await import("node:fs/promises");
  const fresh = makeTicket({ transfer: transfer(1), source: "push", arrivedAt: NOW - 1000 });
  const older = makeTicket({ transfer: transfer(2), source: "push", arrivedAt: NOW - 20_000 });
  const opening = makeTicket({ transfer: transfer(3), source: "initial", arrivedAt: NOW - 1000 });
  const big = (ticket) => render({ status: "live", tickets: [ticket] }).match(/<section class="caisse-gros[^"]*"/)[0];
  assert.match(big(fresh), /caisse-gros caisse-gros-neuf/);
  assert.ok(!big(older).includes("caisse-gros-neuf"), "still Nouveau, but the fade is over");
  assert.ok(render({ status: "live", tickets: [older] }).includes("caisse-nouveau"));
  assert.ok(!big(opening).includes("caisse-gros-neuf"));
  const css = await readFile(new URL("../style.css", import.meta.url), "utf8");
  assert.match(css.match(/\.caisse-gros-neuf\s*{[^}]*}/)[0], /animation:\s*caisse-fond-neuf/);
  assert.match(css, /@keyframes caisse-fond-neuf/);
  assert.match(css, /prefers-reduced-motion/);
});

// Intention: big ticket hierarchy: the description is smaller than the date line and grey; the amount has room around it.
test("page : gros ticket = description plus petite et grise que la date, marge autour du montant", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../style.css", import.meta.url), "utf8");
  const rem = (selector) => Number(css.match(new RegExp(`${selector.replaceAll(".", "\\.")}\\s*{[^}]*font-size:\\s*([\\d.]+)rem`))[1]);
  assert.ok(rem(".caisse-gros .caisse-gros-description") <= 1.05);
  assert.ok(rem(".caisse-gros .caisse-gros-heure") > rem(".caisse-gros .caisse-gros-description") * 1.4);
  assert.match(css.match(/\.caisse-gros \.caisse-gros-description\s*{[^}]*}/)[0], /color:\s*var\(--texte-secondaire\)/);
  assert.match(css.match(/\.caisse-gros \.caisse-gros-montant\s*{[^}]*}/)[0], /margin:\s*0\.75rem 0/);
});

// Intention: an incomplete ticket shows the payer and time, and says the amount is being read; an unreadable one says so.
test("page : ticket incomplet = 'Montant en cours de lecture', illisible = 'Montant indisponible'", () => {
  const pending = makeTicket({ notification: paymentNotification(1).notification, entityId: "tr-1", source: "push", arrivedAt: NOW });
  const html = render({ status: "live", tickets: [pending] });
  assert.match(html, /Payeur 1/);
  assert.match(html, /Montant en cours de lecture/);
  assert.ok(!html.includes("caisse-gros-montant"), "no big figure");
  const unreadable = makeTicket({ transfer: transfer(2, { amount: "abc" }), source: "push", arrivedAt: NOW });
  assert.match(render({ status: "live", tickets: [unreadable] }), /Montant indisponible/);
  assert.match(render({ status: "live", tickets: [pending, pending] }), /<span class="caisse-montant">Montant en cours de lecture<\/span>/);
});

// Intention: the amount of the big ticket is in very large type (3 rem at least), and the CSS holds the new classes (no inline style).
test("page : le montant est en très grand (3 rem au moins), classes dans style.css", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../style.css", import.meta.url), "utf8");
  assert.match(css.match(/\.caisse-gros-montant\s*{[^}]*}/)[0], /font-size:\s*clamp\(3rem,/);
  for (const name of ["caisse-gros", "caisse-nouveau", "caisse-ligne", "caisse-precedents", "caisse-etat", "caisse-actualisation"]) {
    assert.ok(css.includes(`.${name}`), name);
  }
  const html = render({ status: "live", tickets: [makeTicket({ transfer: transfer(1), source: "push", arrivedAt: NOW })] });
  assert.ok(html.includes('class="caisse-gros-montant"'));
});

// Intention: the refusal pages say why, in French, with the error label.
test("page : pages de refus (403, indisponible, plafond atteint) en français avec le libellé Erreur", () => {
  for (const [kind, text] of [["denied", /pas inscrit/], ["unavailable", /momentanément indisponible/], ["busy", /trop d'écoutes/]]) {
    const html = renderCaisseRefused(kind, "x", helpers);
    assert.match(html, /<strong>Erreur :<\/strong>/);
    assert.match(html, text);
  }
});

// ---- the stop of the server ----

// Intention: stopping the server stops every listener: the stream is cut, the Cyclos sessions (the listener's and the short one used to
// learn its identity) are closed.
appTest("caisse : arrêt du serveur = flux coupé et sessions Cyclos de l'écoute fermées", OPTIONS, async (app) => {
  await ready(app);
  await pageUntil(app, isLive, "état live");
  assert.equal(app.cyclos.openStreams(), 1);
  const visitorToken = app.cyclos.calls("GET", "/users/self")[0].headers["session-token"];
  await app.server.close();
  assert.equal(app.cyclos.openStreams(), 0);
  assert.equal(app.cyclos.state.deleted.length, 2, "identity session + listener session");
  assert.ok(!app.cyclos.state.deleted.includes(visitorToken), "the page's own session is not the listener's");
});

// Intention: for real: `node server.js` receives SIGTERM, closes the listening cleanly (stream cut, DELETE /auth/session) and exits with code 0.
test("node server.js : SIGTERM arrête les écouteurs proprement et sort avec le code 0", async () => {
  const cyclos = await startFakeCyclos();
  cyclos.state.push.lifetimeMs = null;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: envEnfant({
      PORT: String(port),
      CYCLOS_BASE_URL: cyclos.url,
      CYCLOS_CHANNEL: "main",
      CAISSE_ENABLED: "true",
      CAISSE_CYCLOS_LOGIN: USER.login,
      CAISSE_CYCLOS_PASSWORD: USER.password,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    for (let i = 0; i < 100 && !output.includes("Caisse : activée"); i += 1) await pause(30);
    assert.match(output, /^Serveur démarré sur http:\/\/localhost:\d+\nCanal Cyclos : main\nCaisse : activée, page \/caisse\n$/);
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/connexion`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login: USER.login, password: USER.password }).toString(),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${base}/caisse`, { headers: { Cookie: cookie } })).status, 200);
    for (let i = 0; i < 100 && cyclos.openStreams() !== 1; i += 1) await pause(20);
    assert.equal(cyclos.openStreams(), 1);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(cyclos.openStreams(), 0);
    assert.equal(cyclos.state.deleted.length, 2);
    assert.ok(!output.includes(USER.password));
  } finally {
    child.kill();
    await cyclos.close();
  }
});

// ---- the log ----

// Intention: a full scenario (visits, a payment, a hostile name, a refused user, an error) leaves a log with no password,
// token, payer, amount, description, number or identifier.
appTest("caisse : le journal d'un scénario complet ne contient aucune donnée sensible", OPTIONS, async (app) => {
  await ready(app);
  app.cyclos.state.entries = [entry(1, { amount: "1.00" })];
  await pageUntil(app, (h) => h.includes("Paiements précédents") || h.includes("caisse-gros"), "premier chargement");
  app.cyclos.state.transfers.set("tr-2", transfer(2, { amount: "2.00", description: "Objet fictif secret", payer: "Payeur Secret" }));
  app.cyclos.push("newNotification", paymentNotification(2, { payer: "Payeur Secret" }));
  app.cyclos.push("newNotification", paymentNotification(3, { entityType: "etrange" }));
  app.cyclos.pushRaw("event: newNotification\ndata: {Payeur-Secret-illisible\n\n");
  await pageUntil(app, (h) => h.includes("2,00 G"), "ticket affiché");
  app.cyclos.force("GET /self/accounts/membre/history", 500);
  app.cyclos.push("accountStatus", { n: 1 });
  await pause(300);
  app.cyclos.state.forced.clear();
  app.cyclos.force("POST /auth/session", 401);
  app.cyclos.expireTokens();
  app.cyclos.endStreams();
  await pageUntil(app, (h) => h.includes("Impossible de lire les paiements"), "état error");
  await app.server.close();

  const text = app.logs.join("\n");
  assert.ok(app.logs.length >= 4, "the scenario did write to the log");
  const tokens = [...app.cyclos.state.requests.map((r) => r.headers["session-token"]).filter(Boolean)];
  for (const secret of [USER.password, USER.login, ...tokens, "Payeur", "Secret", "Objet", "tr-", "T0000", "1.00", "2.00", "Achat", "Payeur-Secret-illisible"]) {
    assert.ok(!text.includes(secret), `le journal contient "${secret}"`);
  }
});
