// === WHAT THIS FILE CHECKS ===
// The statement of transactions under /espace/releve, on the real server in multi-merchant mode against a fake Cyclos: the filter page,
// the ticket on screen, and everything around them. One login for the area (no second login), the Cyclos token of the area session is
// the one used for the reading; the checks of every POST (origin, session, CSRF); one reading at a time per session; a Cyclos 401
// closes the area session; pages without any script (exact security policy); the reading is complete (pages, dates in UTC, cap of
// lines); texts coming from Cyclos are escaped. Most cases come from the original statement tool, with the same expectations.
// All names and secrets are fictitious.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { appTest, until } from "./support/harness.js";
import { CAISSE_OPTIONS } from "./support/options.js";
import {
  MARIE, RANGE, NNBSP, options, seed, setEntries, browser, connected, on, history,
  summaryOf, rowsOf, numbersOf, amountsOf, cents, historyCalls,
} from "./support/releve-support.js";

// The policy of the original statement tool, written out in full: no script, no connection.
const CSP_SANS_SCRIPT = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// The ticket page (200 answer only) adds script-src 'self' for the Print button, and nothing else.
const CSP_TICKET = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const CSP_AVEC_SCRIPT = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

// ------------------------------------------------------------------------------ one login, the token of the area

// Intention: the merchant logs in ONCE, to the area; the statement is read with the Cyclos token of that session, no second
// login, no password. The Cyclos calls carry the channel.
appTest("relevé : une seule connexion (celle de l'espace), le jeton Cyclos de l'espace sert à la lecture", options(), async (app) => {
  const { b, csrf } = await connected(app, [on(1), on(2, { amount: "-1.00" })]);
  const [login] = app.cyclos.calls("POST", "/auth/session");
  const res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 200);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 1, "aucune seconde connexion à Cyclos");
  const token = [...app.cyclos.state.tokens][0];
  for (const call of [...historyCalls(app), ...app.cyclos.calls("GET", "/self/accounts/MonComptePro")]) {
    assert.equal(call.headers["session-token"], token);
    assert.equal(call.headers.channel, "main");
  }
  assert.ok(login);
  assert.ok(!JSON.stringify(app.server.inspectEspaceSessions()).includes(MARIE.password));
  assert.ok(!app.logs.join("\n").includes(MARIE.password));
});

// ------------------------------------------------------------------------------ filters

// Intention: the free range is prefilled with well-formed dates, the shortcuts are POST buttons, the hidden CSRF token is the session's one, and the page offers a way back to the area
// (and no logout button: the area has its own).
appTest("relevé : filtres, préréglages, jeton CSRF de la session, lien de retour à l'espace, pas de bouton de déconnexion", options(), async (app) => {
  const { b, csrf } = await connected(app);
  for (const preset of ["", "?preset=hier", "?preset=6h", "?preset=nimportequoi"]) {
    const res = await b.request(`/espace/releve${preset}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8$/);
    const html = await res.text();
    assert.match(html, /<h1>Choisir la période<\/h1>/); // updated: the page title was "Choisir la plage horaire" before the filters redesign
    assert.match(html, /<form method="post" action="\/espace\/releve\/ticket">/);
    assert.match(html, /id="start" name="start" value="\d{4}-\d\d-\d\dT\d\d:\d\d"/);
    assert.match(html, /id="end" name="end" value="\d{4}-\d\d-\d\dT\d\d:\d\d"/);
    assert.equal(html.match(/name="csrf" value="([0-9a-f]+)"/)[1], csrf);
    assert.match(html, /<a href="\/espace">Retour à l'espace<\/a>/);
    assert.ok(!html.includes("Se déconnecter") && !html.includes("deconnexion"));
    // updated: the shortcuts are buttons of a POST form now, not links, and an old ?preset= link prefills nothing
    assert.match(html, /<button type="submit" name="raccourci" value="hier">Hier<\/button>/);
    assert.ok(!html.includes("preset="));
  }
  // updated: ?preset=hier no longer fills the dates: the free range has the same values as without the query
  const fields = (html) => [html.match(/name="start" value="([^"]*)"/)[1], html.match(/name="end" value="([^"]*)"/)[1]];
  const plain = fields(await (await b.request("/espace/releve")).text());
  assert.deepEqual(fields(await (await b.request("/espace/releve?preset=hier")).text()).map((v) => v.slice(0, 10)), plain.map((v) => v.slice(0, 10)));
  assert.equal(app.cyclos.calls("GET", "/self/accounts").length, 1, "afficher les filtres n'appelle pas Cyclos (seul reste l'appel de la connexion)");
});

// ------------------------------------------------------------------------------ the ticket

// Intention: the ticket is COMPLETE and CONSISTENT: every transaction is read despite pagination, dates are sent in UTC (Paris in January =
// UTC+1), and the lines add up to the summary.
appTest("relevé : ticket cohérent avec les totaux sur plusieurs pages (450 lignes, 3 pages)", options(), async (app) => {
  const entries = history(450);
  const { b, csrf } = await connected(app, entries);
  const res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8$/);
  const html = await res.text();

  assert.deepEqual(historyCalls(app).map((p) => [p.query.get("page"), p.query.get("pageSize")]), [["0", "200"], ["1", "200"], ["2", "200"]]);
  for (const call of [...historyCalls(app), ...app.cyclos.calls("GET", "/self/accounts/MonComptePro")]) {
    assert.deepEqual(call.query.getAll("datePeriod"), ["2026-01-09T23:00:00.000Z", "2026-01-10T22:59:59.999Z"]);
  }
  const numbers = numbersOf(html);
  assert.equal(numbers.length, 450);
  assert.deepEqual(numbers, entries.map((e) => e.transactionNumber).reverse(), "du plus ancien au plus récent, sans doublon");
  assert.ok(!html.includes('class="avertissement"'));

  const summary = summaryOf(html);
  const incoming = entries.filter((e) => Number(e.amount) > 0);
  const outgoing = entries.filter((e) => Number(e.amount) < 0);
  assert.equal(summary[0][0], `${incoming.length} paiements reçus`);
  assert.equal(summary[1][0], `${outgoing.length} paiements sortis`);
  assert.equal(summary[2][0], "Solde net");
  const displayed = amountsOf(html).map(cents);
  assert.equal(displayed.filter((c) => c > 0).reduce((a, c) => a + c, 0), cents(summary[0][1]));
  assert.equal(-displayed.filter((c) => c < 0).reduce((a, c) => a + c, 0), cents(summary[1][1]));
  assert.equal(displayed.reduce((a, c) => a + c, 0), cents(summary[2][1]));
  assert.match(summary[2][1], /^\+/);
  assert.match(html, /<p class="commercant">Boutique de Marie<\/p>/);
  assert.match(html, /<p class="periode">Du 10\/01\/2026 00:00 au 10\/01\/2026 23:59<\/p>/);
  assert.match(html, /Montants en Graines/);
  assert.match(html, /<a href="\/espace\/releve">Changer la plage horaire<\/a>/);
  assert.match(html, /<a href="\/espace">Retour à l'espace<\/a>/);
  assert.ok(!html.includes("Se déconnecter"));
});

// Intention: Cyclos may return smaller pages than asked: the reading follows X-Has-Next-Page, not an assumption.
appTest("relevé : pages plus petites que demandé, la lecture suit l'en-tête X-Has-Next-Page", options(), async (app) => {
  const { b, csrf } = await connected(app, history(130));
  app.cyclos.state.pageSize = 50;
  assert.equal(rowsOf(await (await b.ticket({ csrf, ...RANGE })).text()).length, 130);
  assert.equal(historyCalls(app).length, 3);
});

appTest("relevé : aucune transaction", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.match(html, /Aucune transaction sur cette plage/);
  assert.equal(rowsOf(html).length, 0);
  assert.deepEqual(summaryOf(html), [["0 paiement reçu", "0,00"], ["0 paiement sorti", "0,00"], ["Solde net", "0,00"]]);
});

// Intention: beyond 2000 lines the detail is cut (the most recent are kept) and a warning says so; Cyclos' totals stay exact. The reading
// stops at the cap instead of downloading everything.
appTest("relevé : plafond de 2000 lignes -> avertissement, les plus récentes gardées, totaux exacts", options(), async (app) => {
  const entries = history(2500);
  const { b, csrf } = await connected(app, entries);
  const html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.match(html, /<p class="avertissement" role="alert">Attention : la liste est limitée aux 2000 transactions les plus récentes/);
  assert.match(html, /totaux du résumé restent exacts/);
  const numbers = numbersOf(html);
  assert.equal(numbers.length, 2000);
  assert.equal(numbers[0], "T00500", "la plus ancienne gardée");
  assert.equal(numbers.at(-1), "T02499", "la plus récente");
  const incoming = entries.filter((e) => Number(e.amount) > 0).length;
  assert.equal(summaryOf(html)[0][0], `${incoming} paiements reçus`);
  assert.ok(historyCalls(app).length <= 11, "lecture arrêtée au plafond");
});

appTest("relevé : exactement 2000 lignes -> pas d'avertissement ; 2001 -> avertissement", options(), async (app) => {
  const { b, csrf } = await connected(app, history(2000));
  let html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.equal(rowsOf(html).length, 2000);
  assert.ok(!html.includes("avertissement"));
  setEntries(app, history(2001));
  html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.equal(rowsOf(html).length, 2000);
  assert.match(html, /class="avertissement"/);
});

// Intention: the cap and the page size are settings (HISTORY_MAX_ROWS, HISTORY_PAGE_SIZE); the warning names the cap in force.
appTest("relevé : plafond et taille de page réglables", options({ history: { pageSize: 10, maxRows: 25 } }), async (app) => {
  const { b, csrf } = await connected(app, history(40));
  const html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.equal(rowsOf(html).length, 25);
  assert.match(html, /limitée aux 25 transactions les plus récentes/);
  assert.equal(historyCalls(app).length, 3);
  assert.equal(historyCalls(app)[0].query.get("pageSize"), "10");
});

// Intention: without totals from Cyclos (the real instance), the ticket computes them; with a cut list it says "Non disponible".
appTest("relevé : sans indicateurs, totaux calculés ; liste tronquée -> « Non disponible » et avertissement", options(), async (app) => {
  const { b, csrf } = await connected(app, [on(3, { amount: "0.10" }), on(2, { amount: "0.20" }), on(1, { amount: "-0.10" })]);
  app.cyclos.state.indicators = false;
  assert.deepEqual(summaryOf(await (await b.ticket({ csrf, ...RANGE })).text()), [["2 paiements reçus", "0,30"], ["1 paiement sorti", "0,10"], ["Solde net", "+0,20"]]);
  setEntries(app, history(2001));
  const html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.deepEqual(summaryOf(html), [["Paiements reçus", "Non disponible"], ["Paiements sortis", "Non disponible"], ["Solde net", "Non disponible"]]);
  assert.match(html, /totaux du résumé ne peuvent pas être calculés au-delà de 2000 transactions/);
  assert.ok(!html.includes("restent exacts"));
  setEntries(app, [on(2, { amount: "1.00" }), on(1, { amount: "abc" })]);
  const unreadable = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.deepEqual(summaryOf(unreadable).map(([, v]) => v), ["Non disponible", "Non disponible", "Non disponible"]);
  assert.equal(rowsOf(unreadable).length, 2, "le détail reste affiché");
});

// Intention: the name is a courtesy: a 500 on it gives a ticket without name; a 401 ends the session of the area.
appTest("relevé : nom indisponible (500) -> ticket sans nom ; 401 -> session de l'espace close, retour à /espace", options(), async (app) => {
  const { b, csrf } = await connected(app, [on(1), on(2)]);
  app.cyclos.force("GET /users/self", 500);
  const html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.ok(!html.includes('class="commercant"'));
  assert.equal(rowsOf(html).length, 2);
  app.cyclos.force("GET /users/self", 401);
  const res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/espace");
  assert.match(res.headers.get("set-cookie"), /^espace_session=;.*Max-Age=0/);
  assert.equal((await b.request("/espace")).status, 200);
  assert.match(await (await b.request("/espace")).text(), /Connectez-vous avec votre compte Cyclos/, "la session est fermée");
});

// Intention (security): names and descriptions come from Cyclos, hence from any user: displayed as text, never interpreted.
appTest("relevé : valeurs de Cyclos échappées (nom, contrepartie, description)", options(), async (app) => {
  const hostile = '<script>alert(1)</script><style>*{}</style><img src=x onerror=alert(1)> & "q"';
  const e = on(1, { description: hostile });
  e.relatedAccount = { user: { display: hostile } };
  const { b, csrf } = await connected(app, [e], { display: hostile });
  const html = await (await b.ticket({ csrf, ...RANGE })).text();
  // The ticket page now carries one script tag of its own (the Print button, by src): it is the only one allowed, a hostile one is not.
  assert.deepEqual(html.match(/<script[^>]*>/gi), ['<script type="module" src="/print-ticket.js">']);
  assert.ok(!/<style|<img src=x|<b>/i.test(html), "balise brute dans la page");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&amp; &quot;q&quot;"));
});

// Intention: wrong dates give 400 with the form displayed again (what the user typed, escaped), and Cyclos is NOT called.
appTest("relevé : dates invalides -> 400 sur la page des filtres, valeurs saisies conservées, Cyclos non appelé", options(), async (app) => {
  const { b, csrf } = await connected(app);
  const cases = [
    [{ start: "hier", end: RANGE.end }, /Date de début invalide/],
    [{ start: RANGE.start, end: "" }, /Date de fin invalide/],
    [{ start: RANGE.end, end: RANGE.start }, /La fin doit être après le début/],
    [{ start: "2025-01-01T00:00", end: "2026-01-10T00:00" }, /ne peut pas dépasser 31 jours/],
    [{ start: "2999-01-01T00:00", end: "2999-01-02T00:00" }, /Le début ne peut pas être dans le futur/],
    [{ start: "2026-03-29T02:30", end: "2026-03-29T10:00" }, /n'existe pas : elle est sautée/],
    [{ start: '"><b>x', end: RANGE.end }, /Date de début invalide/],
  ];
  for (const [dates, message] of cases) {
    const res = await b.ticket({ csrf, ...dates });
    assert.equal(res.status, 400, JSON.stringify(dates));
    assert.match(res.headers.get("content-type"), /^text\/html/);
    const html = await res.text();
    assert.match(html, message);
    assert.match(html, /<h1>Choisir la période<\/h1>/); // updated: the page title was "Choisir la plage horaire" before the filters redesign
    assert.ok(!html.includes('"><b>'), "saisie échappée");
  }
  assert.equal(app.cyclos.calls("GET", "/self/accounts").length, 1);
  const typed = await (await b.ticket({ csrf, start: "n'importe quoi", end: "2026-01-10T10:00" })).text();
  assert.ok(typed.includes('value="n\'importe quoi"'));
});

// Intention: a future end is accepted but sent to Cyclos as "now".
appTest("relevé : fin dans le futur acceptée (ramenée à maintenant)", options(), async (app) => {
  const { b, csrf } = await connected(app);
  const paris = (days) => DateTime.now().setZone("Europe/Paris").plus({ days }).toFormat("yyyy-MM-dd'T'HH:mm");
  const res = await b.ticket({ csrf, start: paris(-1), end: paris(1) });
  assert.equal(res.status, 200);
  const [totals] = app.cyclos.calls("GET", "/self/accounts/MonComptePro");
  const [, until] = totals.query.getAll("datePeriod");
  assert.ok(Date.parse(until) <= Date.now() && Date.now() - Date.parse(until) < 60_000, until);
});

// ------------------------------------------------------------------------------ the checks of every POST

// Intention: no session, no Origin (or another site), no or wrong CSRF token: nothing is read from Cyclos.
appTest("relevé : sans session, origine étrangère, jeton CSRF absent ou faux -> refusé, Cyclos non appelé", options(), async (app) => {
  const { b, csrf } = await connected(app, history(3));
  const stranger = browser(app);
  const noSession = await stranger.ticket({ csrf, ...RANGE });
  assert.equal(noSession.status, 303);
  assert.equal(noSession.headers.get("location"), "/espace");
  assert.equal((await stranger.request("/espace/releve")).headers.get("location"), "/espace");

  for (const origin of [null, "https://autre-site.example", "null"]) {
    const res = await b.ticket({ csrf, ...RANGE }, { origin });
    assert.equal(res.status, 403, String(origin));
    assert.match(await res.text(), /Origine de la requête non autorisée/);
  }
  for (const bad of [undefined, "", "0".repeat(64), `${csrf}0`, csrf.slice(1)]) {
    const res = await b.ticket({ ...(bad === undefined ? {} : { csrf: bad }), ...RANGE });
    assert.equal(res.status, 403, String(bad));
    const html = await res.text();
    assert.match(html, /Jeton de sécurité absent ou invalide/);
    assert.match(html, /<a href="\/espace\/releve">Retour aux filtres<\/a>/);
  }
  assert.equal(app.cyclos.calls("GET", "/self/accounts").length, 1);
  assert.equal(app.cyclos.calls("GET", "/users/self").filter((c) => c.query.get("fields") === "display").length, 0);
  // The CSRF token of /espace/caisse and of the session of /caisse are other sessions' business: only the area's own is accepted.
  assert.equal((await b.ticket({ csrf, ...RANGE })).status, 200);
});

// Intention: a link or a reload cannot ask for a statement (GET on the POST routes goes back to the filters); other paths do not exist.
appTest("relevé : GET sur les routes POST -> retour aux filtres ; autres chemins et méthodes -> 404", options(), async (app) => {
  const { b, csrf } = await connected(app);
  for (const path of ["/espace/releve/ticket", "/espace/releve/ticket.pdf"]) {
    const res = await b.request(path);
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get("location"), "/espace/releve");
  }
  assert.equal((await b.request("/espace/releve", { method: "POST", form: { csrf, ...RANGE }, headers: { Origin: app.base } })).status, 404);
  for (const path of ["/espace/releve/", "/espace/releve/autre", "/espace/releve/ticket/x"]) {
    assert.equal((await b.request(path)).status, 404, path);
  }
  assert.equal((await b.request("/espace/releve", { method: "DELETE" })).status, 404);
  assert.equal((await b.request("/espace/releveX")).status, 404);
});

// Intention: a body above 10 kB is refused with 413 and nothing goes to Cyclos.
appTest("relevé : corps de plus de 10 ko -> 413", options(), async (app) => {
  const { b, csrf } = await connected(app);
  const res = await b.ticket({ csrf, start: "x".repeat(11_000), end: RANGE.end });
  assert.equal(res.status, 413);
  assert.equal(app.cyclos.calls("GET", "/self/accounts").length, 1);
});

// ------------------------------------------------------------------------------ Cyclos errors

// Intention: a refusal on the accounts (or an empty list) and a refusal elsewhere give two different pages, 403, and the session stays.
appTest("relevé : 403 de Cyclos -> page d'accès refusé, la session reste ouverte", options(), async (app) => {
  const { b, csrf } = await connected(app, history(2));
  app.cyclos.force("GET /self/accounts", 403);
  let res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /<h1>Accès aux comptes refusé<\/h1>[\s\S]*Cyclos refuse l'accès aux comptes/);
  app.cyclos.state.forced.delete("GET /self/accounts");
  app.cyclos.state.accountsBody = [];
  res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Accès aux comptes refusé/);
  app.cyclos.state.accountsBody = undefined;
  app.cyclos.force("GET /self/accounts/MonComptePro/history", 403);
  res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 403);
  const html = await res.text();
  assert.match(html, /<h1>Accès refusé<\/h1>[\s\S]*n'a pas l'autorisation/);
  assert.ok(!html.includes("Accès aux comptes"));
  assert.equal((await b.request("/espace/releve")).status, 200, "la session de l'espace est intacte");
});

appTest("relevé : Cyclos en panne ou coupé -> 502 avec page de retour, journalisé sans donnée sensible", options(), async (app) => {
  const { b, csrf } = await connected(app, history(2));
  app.cyclos.force("GET /self/accounts/MonComptePro", 500);
  let res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 502);
  assert.match(await res.text(), /Cyclos ne répond pas/);
  app.cyclos.force("GET /self/accounts/MonComptePro", "drop");
  res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 502);
  const log = app.logs.join("\n");
  assert.match(log, /Cyclos injoignable ou en erreur/);
  assert.ok(!log.includes(MARIE.password) && !/jeton-\d/.test(log));
  assert.equal((await b.request("/espace/releve")).status, 200);
});

// Intention: a Cyclos 401 on the history (the token ended on the Cyclos side) closes the area session, like for the cash register.
appTest("relevé : jeton refusé par Cyclos (401) -> session de l'espace fermée, retour à /espace", options(), async (app) => {
  const { b, csrf } = await connected(app, history(2));
  app.cyclos.expireTokens();
  const res = await b.ticket({ csrf, ...RANGE });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/espace");
  assert.equal(app.server.inspectEspaceSessions().length, 0);
  assert.equal((await b.request("/espace/releve")).headers.get("location"), "/espace");
});

// ------------------------------------------------------------------------------ one reading at a time

// Intention: while a reading runs for a session, a second request of that session is refused (429), not stacked up; the guard is
// released when the first ends (here by the time limit), and then the session reads again. Another session is not held back.
appTest("relevé : une lecture à la fois par session (429), garde libérée à la fin, délai maximal de lecture", options({ releveTimeoutMs: 600 }), async (app) => {
  const { b, csrf } = await connected(app, history(3));
  app.cyclos.force("GET /self/accounts/MonComptePro/history", "hang");
  const first = b.ticket({ csrf, ...RANGE });
  await until(() => historyCalls(app).length === 1, "la première lecture est en cours");
  const second = await b.ticket({ csrf, ...RANGE });
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("retry-after"), "5");
  assert.match(await second.text(), /déjà en cours de lecture/);
  assert.equal(historyCalls(app).length, 1, "la seconde requête n'a rien lu");

  const slow = await first;
  assert.equal(slow.status, 502, "délai dépassé : 502");
  assert.match(app.logs.join("\n"), /Cyclos injoignable ou en erreur : délai dépassé/);
  app.cyclos.state.forced.delete("GET /self/accounts/MonComptePro/history");
  const again = await b.ticket({ csrf, ...RANGE });
  assert.equal(again.status, 200, "la garde est libérée");
  assert.equal(rowsOf(await again.text()).length, 3);
});

// ------------------------------------------------------------------------------ security headers

// Intention: the pages of the statement allow NO script and no connection (the exact policy of the original tool), whatever the answer
// (filters, 400, 403, 303, 404), except the ticket itself (200), which adds script-src 'self' for its Print button and nothing else;
// the other pages keep the policy that lets the cash register script run.
appTest("relevé : politique de sécurité sans script sur /espace/releve*, identique à l'outil d'origine ; inchangée ailleurs", options(), async (app) => {
  const { b, csrf } = await connected(app, history(2));
  const ticketAnswer = await b.ticket({ csrf, ...RANGE });
  const answers = [
    await b.request("/espace/releve"),
    await b.ticket({ csrf, start: "x", end: "y" }),
    await b.ticket({ csrf: "faux", ...RANGE }),
    await b.request("/espace/releve/ticket"),
    await b.request("/espace/releve/inconnu"),
    await b.request("/espace/releve", { method: "DELETE" }),
  ];
  for (const res of answers) {
    assert.equal(res.headers.get("content-security-policy"), CSP_SANS_SCRIPT, String(res.status));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  // The ticket: same headers as the others, with the policy of the ticket page (only script-src 'self' added).
  assert.equal(ticketAnswer.status, 200);
  assert.equal(ticketAnswer.headers.get("content-security-policy"), CSP_TICKET);
  assert.ok(!/unsafe-|connect-src/.test(CSP_TICKET));
  assert.equal(ticketAnswer.headers.get("cache-control"), "no-store");
  for (const path of ["/espace", "/caisse", "/style.css", "/espace/inconnu", "/espace/releveX"]) {
    assert.equal((await b.request(path)).headers.get("content-security-policy"), CSP_AVEC_SCRIPT, path);
  }
  // No inline script and no inline style in the ticket: the only script is the external module, loaded by src at the end of the body.
  const html = await ticketAnswer.text();
  const scripts = html.match(/<script[\s\S]*?<\/script>/gi) ?? [];
  assert.deepEqual(scripts, ['<script type="module" src="/print-ticket.js"></script>']);
  assert.ok(html.indexOf("<script") > html.indexOf("</div>") && /<\/script>\s*<\/body>/.test(html), "script à la fin du corps");
  assert.ok(!/style=|<style/i.test(html), "ni style dans la page");
  assert.ok(!/ on[a-z]+=/i.test(html));
  assert.ok(!html.includes("Imprimer"), "aucun bouton dans le HTML du serveur");
});

appTest("relevé : COOKIE_SECURE actif -> HSTS sur les réponses du relevé", options({ cookieSecure: true }), async (app) => {
  seed(app);
  const res = await fetch(`${app.base}/espace/releve`, { redirect: "manual" });
  assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000");
});

// ------------------------------------------------------------------------------ modes where it does not exist

// Intention: outside the multi-merchant mode the statement does not exist: 404 on every one of its paths (single-merchant mode,
// and cash register off), exactly as /espace.
appTest("relevé : hors mode multi-commerçants, /espace/releve répond 404", CAISSE_OPTIONS, async (app) => {
  for (const [method, path] of [["GET", "/espace/releve"], ["POST", "/espace/releve/ticket"], ["GET", "/espace/releve/ticket"], ["GET", "/espace/releve/ticket.pdf"]]) {
    const res = await fetch(`${app.base}${path}`, { method, redirect: "manual", headers: { Origin: app.base } });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

appTest("relevé : caisse désactivée, /espace/releve répond 404", { cyclosChannel: "main" }, async (app) => {
  assert.equal((await fetch(`${app.base}/espace/releve`, { redirect: "manual" })).status, 404);
});

// ------------------------------------------------------------------------------ printing

// Intention: the statement prints as the 80 mm ticket of the original tool. The print block of the shared stylesheet is that very ticket
// (nothing of the cash register in it), and the classes the statement page uses are all styled there.
test("impression : le bloc @media print de la feuille de style est le ticket de 80 mm du relevé, sans règle propre à la caisse", () => {
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  const start = css.indexOf("@media print");
  assert.ok(start > 0);
  const block = css.slice(start, css.indexOf("\n}\n", css.lastIndexOf("border-left-width: 4px;")) + 3);
  assert.match(block, /size: 80mm auto/);
  assert.ok(!block.includes(".caisse-"), "aucun sélecteur de la page /caisse dans le bloc d'impression");
  for (const selector of [".ticket", ".ligne", ".resume", ".avertissement", ".actions", ".raccourcis", ".numero", ".generation"]) {
    assert.ok(block.includes(selector), selector);
  }
  // Nothing clickable on paper: the links, buttons and forms of the page (back links, PDF form) are hidden.
  assert.match(block, /a,\s*button,\s*form,\s*\.actions,\s*\.raccourcis \{\s*display: none !important;/);
});
