// === WHAT THIS FILE CHECKS ===
// Single sign-on from the merchants' area to the cash register (multi-merchant mode). A merchant connected to /espace presses
// "Notifications de caisse" (a POST form, /espace/caisse) and lands on /caisse without typing his Cyclos password again: the session
// of /caisse is built from the Cyclos token the area already holds. The password is never kept. Checked here: the access, the refusals
// (no session of the area, no CSRF token, wrong origin, account no longer listed, token no longer valid at Cyclos), the direct login of
// /connexion (unchanged), and what happens to the SHARED token: Cyclos is told to close it only when no local session holds it any more
// (logout of the cash register, logout of the area, inactivity of the listening, expiry of the sessions). All names and secrets are fictitious.
import "./support/env-propre.js";
import assert from "node:assert/strict";
import { appTest, until } from "./support/harness.js";
import { CAISSE_OPTIONS } from "./support/options.js";
import { entry } from "./support/fake-cyclos.js";

const MARIE = { id: "u-marie", login: "marie", password: "mdp-marie-fictif", email: "marie@exemple.test" };
const ZOE = { id: "u-zoe", login: "zoe", password: "mdp-zoe-fictif", email: "zoe@exemple.test" };

const options = ({ more = {}, caisse = {}, hooks = {} } = {}) => ({
  cyclosChannel: "main",
  caisseHooks: { ...CAISSE_OPTIONS.caisseHooks, ...hooks },
  caisse: { enabled: true, multiMerchant: true, allowedUsers: { ids: ["u-marie"], emails: [] }, ...caisse },
  ...more,
});

function seed(app) {
  app.cyclos.addUser(MARIE.login, MARIE.password, {
    id: MARIE.id,
    display: "Marie",
    email: MARIE.email,
    entries: [entry(12, { amount: "12.00", description: "Achat de marie", who: "Cliente Marie" })],
  });
  app.cyclos.addUser(ZOE.login, ZOE.password, { id: ZOE.id, email: ZOE.email, entries: [] });
  app.cyclos.state.push.lifetimeMs = null;
}

// A small browser: one jar for all the cookies (the server sets them with their own paths, the test sends them all).
function browser(app) {
  const jar = new Map();
  const cookieLine = () => [...jar].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  async function request(path, { method = "GET", form, headers = {} } = {}) {
    const init = { method, redirect: "manual", headers: { ...headers } };
    if (cookieLine()) init.headers.Cookie = cookieLine();
    if (form) {
      init.headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    }
    const res = await fetch(`${app.base}${path}`, init);
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, ...value] = pair.split("=");
      jar.set(name, value.join("="));
    }
    return res;
  }
  const csrfIn = async (path) => (await (await request(path)).text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  const same = { Origin: app.base };
  return {
    request,
    jar,
    enter: (who = MARIE) => request("/espace/connexion", { method: "POST", form: { login: who.login, password: who.password }, headers: same }),
    espaceCsrf: () => csrfIn("/espace"),
    caisseCsrf: () => csrfIn("/caisse"),
    // The button of the page: the CSRF token read in the page, the origin of the site.
    toCaisse: async (more = {}) => request("/espace/caisse", { method: "POST", form: { csrf: await csrfIn("/espace") }, headers: same, ...more }),
    directLogin: (who = MARIE) => request("/connexion", { method: "POST", form: { login: who.login, password: who.password }, headers: same }),
    leaveEspace: async () => request("/espace/deconnexion", { method: "POST", form: { csrf: await csrfIn("/espace") }, headers: same }),
    leaveCaisse: async () => request("/deconnexion", { method: "POST", form: { csrf: await csrfIn("/caisse") }, headers: same }),
  };
}

const logins = (app) => app.cyclos.calls("POST", "/auth/session").length;
const closed = (app) => app.cyclos.state.deleted;
const everything = (app) => app.logs.join("\n");
const liveData = async (app, b) => {
  for (let i = 0; i < 100; i += 1) {
    const data = await (await b.request("/caisse/data")).json();
    if (data.status === "live") return data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pas en direct");
};

// === Access ===

// Intention: connected to the area, one click on the button opens /caisse. No second login at Cyclos, no password anywhere, the cash
// register shows the merchant's own payments.
appTest("connexion unique : espace puis POST /espace/caisse, accès à /caisse sans mot de passe", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  assert.equal(logins(app), 1);
  const res = await b.toCaisse();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/caisse");
  assert.match(res.headers.get("set-cookie"), /^session=[0-9a-f-]+;.*HttpOnly/);
  const page = await b.request("/caisse");
  assert.equal(page.status, 200);
  const data = await liveData(app, b);
  assert.match(JSON.stringify(data), /12,00/);
  assert.equal(logins(app), 1, "the Cyclos token of the area is reused: no new login");

  const [caisseSession] = app.server.inspectSessions();
  assert.equal(caisseSession.merchantKey, "u-marie");
  assert.equal(caisseSession.credentials, undefined, "no password in the session of the cash register");
  const everyRecord = JSON.stringify([app.server.inspectSessions(), app.server.inspectEspaceSessions()]);
  assert.ok(!everyRecord.includes(MARIE.password));
  assert.ok(!everything(app).includes(MARIE.password));
  assert.ok(app.cyclos.calls("POST", "/auth/session").every((r) => r.headers.channel === "main"));
});

// Intention: pressing the button twice, or from two tabs, does not pile up sessions of the cash register.
appTest("connexion unique : un second POST garde la session de caisse ouverte", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  await b.toCaisse();
  const first = b.jar.get("session");
  const again = await b.toCaisse();
  assert.equal(again.status, 303);
  assert.equal(again.headers.get("location"), "/caisse");
  assert.equal(again.headers.get("set-cookie"), null);
  assert.equal(b.jar.get("session"), first);
  assert.equal(app.server.inspectSessions().length, 1);
});

// Intention: the direct login (identifier and password on /connexion) works as before: its own two tokens, own session.
appTest("connexion unique : /connexion directe fonctionne toujours avec identifiant et mot de passe", options(), async (app) => {
  seed(app);
  const b = browser(app);
  const res = await b.directLogin();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/caisse");
  assert.equal(logins(app), 2, "page token and listening token, as before");
  assert.equal((await b.request("/caisse")).status, 200);
  assert.match(JSON.stringify(await liveData(app, b)), /12,00/);
  assert.equal((await b.request("/connexion", { method: "POST", form: { login: "marie", password: "faux" }, headers: { Origin: app.base } })).status, 401);
});

// === Refusals ===

// Intention: without a session of the area the button leads nowhere: back to the area's form, no session of the cash register.
appTest("connexion unique : sans session d'espace, refus", options(), async (app) => {
  seed(app);
  const b = browser(app);
  const res = await b.request("/espace/caisse", { method: "POST", form: { csrf: "0".repeat(64) }, headers: { Origin: app.base } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/espace");
  assert.ok(!(res.headers.get("set-cookie") ?? "").startsWith("session="));
  assert.equal(app.server.inspectSessions().length, 0);
  assert.equal((await b.request("/caisse")).status, 303, "/caisse still asks for a login");
  assert.equal(logins(app), 0);
});

// Intention: a missing or wrong CSRF token, and a missing or foreign origin, are refused (403) and open nothing.
appTest("connexion unique : sans jeton CSRF, mauvais jeton, mauvaise origine, refus", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  const csrf = await b.espaceCsrf();
  const attempts = [
    ["no token", { form: {}, headers: { Origin: app.base } }],
    ["wrong token", { form: { csrf: "f".repeat(64) }, headers: { Origin: app.base } }],
    ["token under another field name", { form: { token: csrf }, headers: { Origin: app.base } }],
    ["no origin", { form: { csrf }, headers: {} }],
    ["foreign origin", { form: { csrf }, headers: { Origin: "https://autre.exemple.test" } }],
    ["null origin", { form: { csrf }, headers: { Origin: "null" } }],
  ];
  for (const [name, init] of attempts) {
    const res = await b.request("/espace/caisse", { method: "POST", ...init });
    assert.equal(res.status, 403, name);
    assert.ok(!(res.headers.get("set-cookie") ?? "").startsWith("session="), name);
  }
  assert.equal(app.server.inspectSessions().length, 0);
  assert.equal((await b.request("/caisse")).status, 303);
  assert.equal(app.server.inspectEspaceSessions().length, 1, "the session of the area is not touched by a refused attempt");
  // The same form with the right token and origin still works afterwards.
  assert.equal((await b.toCaisse()).headers.get("location"), "/caisse");
});

// Intention: the account is looked at again: if it is no longer the listed one, no session of the cash register is opened.
appTest("connexion unique : compte non listé, refus", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  // At Cyclos the token now belongs to an account that is not on the list.
  for (const user of app.cyclos.state.tokenUsers.values()) user.id = ZOE.id;
  const res = await b.toCaisse();
  assert.equal(res.status, 403);
  assert.match(await res.text(), /pas autorisé/);
  assert.equal(app.server.inspectSessions().length, 0);
  assert.equal((await b.request("/caisse")).status, 303);
});

// Intention: an account that never passed the list cannot get in through the area either (the area itself refuses its login).
appTest("connexion unique : compte hors liste, pas de session d'espace donc pas de caisse", options(), async (app) => {
  seed(app);
  const b = browser(app);
  assert.equal((await b.enter(ZOE)).status, 401);
  assert.equal((await b.toCaisse()).headers.get("location"), "/espace");
  assert.equal(app.server.inspectSessions().length, 0);
  assert.equal(app.server.inspectEspaceSessions().length, 0);
});

// Intention: the Cyclos token ended on the Cyclos side while the merchant was reading the area's page: the button does not open a
// cash register that cannot work. The area's session ends too (its token is dead), the merchant logs in again.
appTest("connexion unique : jeton expiré chez Cyclos, retour à la connexion de l'espace", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  app.cyclos.expireTokens();
  const res = await b.toCaisse();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/espace");
  assert.equal(app.server.inspectSessions().length, 0);
  assert.equal(app.server.inspectEspaceSessions().length, 0);
  assert.match(await (await b.request("/espace")).text(), /action="\/espace\/connexion"/);
});

// === The shared token ===

// Intention: logout of the cash register: the listening stops and the cash register session ends, but the area stays connected and
// the Cyclos token stays open, since the area still holds it. The area's own logout then closes it, once.
appTest("connexion unique : déconnexion de la caisse, l'espace reste connecté, le jeton n'est fermé qu'à la fin", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  await b.toCaisse();
  await liveData(app, b);
  assert.equal(app.cyclos.openStreams(), 1);
  const [{ sessionToken }] = app.server.inspectEspaceSessions();

  const out = await b.leaveCaisse();
  assert.equal(out.status, 303);
  await until(() => app.cyclos.openStreams() === 0, "listening stopped");
  assert.equal(app.server.inspectSessions().length, 0);
  assert.deepEqual(closed(app), [], "the area still holds the token: Cyclos is not told to close it");
  assert.ok(app.cyclos.state.tokens.has(sessionToken));
  assert.match(await (await b.request("/espace")).text(), /action="\/espace\/deconnexion"/, "the area is still connected");
  assert.equal((await b.request("/caisse")).status, 303, "the cash register is not");

  // And the area can send the merchant back to the cash register without a password.
  assert.equal((await b.toCaisse()).headers.get("location"), "/caisse");
  assert.equal(logins(app), 1);
  assert.match(JSON.stringify(await liveData(app, b)), /12,00/);
  await b.leaveCaisse();

  await b.leaveEspace();
  assert.deepEqual(closed(app), [sessionToken], "closed once, when nothing holds it");
  assert.equal(app.cyclos.state.tokens.size, 0);
});

// Intention: logout of the area while the cash register is open: the cash register keeps working (its own session), the token stays
// open for it; when the cash register ends, the token is closed, once.
appTest("connexion unique : déconnexion de l'espace, la caisse continue, le jeton se ferme avec elle", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  await b.toCaisse();
  await liveData(app, b);
  const [{ sessionToken }] = app.server.inspectEspaceSessions();

  const out = await b.leaveEspace();
  assert.equal(out.status, 303);
  assert.equal(app.server.inspectEspaceSessions().length, 0);
  assert.deepEqual(closed(app), [], "the cash register still uses the token");
  assert.equal(app.cyclos.openStreams(), 1, "the listening goes on");
  assert.equal((await b.request("/caisse")).status, 200);
  assert.match(JSON.stringify(await liveData(app, b)), /12,00/);

  await b.leaveCaisse();
  assert.deepEqual(closed(app), [sessionToken]);
  await until(() => app.cyclos.openStreams() === 0, "listening stopped");
  assert.equal(app.cyclos.state.tokens.size, 0, "no Cyclos session left open");
});

// Intention: both local sessions expire: the token is closed at Cyclos exactly once (not twice, not never).
appTest("connexion unique : les deux sessions expirent, jeton fermé une seule fois", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  await b.toCaisse();
  await liveData(app, b);
  const [{ sessionToken }] = app.server.inspectEspaceSessions();
  app.server.sweep(Date.now() + 21 * 60_000);
  await until(() => closed(app).length >= 1, "token closed");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(closed(app), [sessionToken]);
  assert.equal(app.server.inspectSessions().length, 0);
  assert.equal(app.server.inspectEspaceSessions().length, 0);
  await until(() => app.cyclos.openStreams() === 0, "stream cut");
});

// Intention: only the cash register session expires (the tablet was left alone) while the area is used: the area is not broken, the
// token stays for it.
appTest("connexion unique : la session de caisse expire seule, l'espace garde son jeton", options({ more: { idleMs: 300, maxMs: 60_000 } }), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  await b.toCaisse();
  await liveData(app, b);
  const [{ sessionToken }] = app.server.inspectEspaceSessions();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await b.request("/espace"); // the area is used: its idle delay restarts
  await new Promise((resolve) => setTimeout(resolve, 200));
  app.server.sweep();
  await until(() => app.server.inspectSessions().length === 0, "cash register session expired");
  assert.equal(app.server.inspectEspaceSessions().length, 1);
  assert.deepEqual(closed(app), []);
  assert.ok(app.cyclos.state.tokens.has(sessionToken));
});

// Intention: the listening stops after the idle delay (nobody visits /caisse). In the multi-merchant mode the listener only borrows
// the token, so it closes nothing: the area is not disconnected, the token stays valid, and the next visit starts the listening again
// with the same token, without any login.
const idleClock = { offset: 0 }; // moves the clock of the listening manager forward, nothing else
appTest("connexion unique : arrêt de l'écoute pour inactivité, l'espace n'est pas cassé", options({ hooks: { now: () => Date.now() + idleClock.offset, sweepIntervalMs: 20 } }), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  await b.toCaisse();
  await liveData(app, b);
  assert.equal(app.cyclos.openStreams(), 1);
  const [{ sessionToken }] = app.server.inspectEspaceSessions();

  idleClock.offset = 60_000; // more than the 45 seconds without a visit
  await until(() => app.cyclos.openStreams() === 0, "listening stopped for inactivity");
  assert.match(everything(app), /écoute arrêtée \(inactivité\)/);
  assert.deepEqual(closed(app), [], "no Cyclos session closed by the end of the listening");
  assert.ok(app.cyclos.state.tokens.has(sessionToken));
  assert.equal(app.server.inspectEspaceSessions().length, 1);
  assert.match(await (await b.request("/espace")).text(), /action="\/espace\/deconnexion"/, "the area still works");

  // The next visit of the cash register starts the listening again, from the same token.
  assert.equal((await b.request("/caisse")).status, 200);
  assert.match(JSON.stringify(await liveData(app, b)), /12,00/);
  assert.equal(logins(app), 1);
  assert.deepEqual(closed(app), []);
});

// === The page of the area ===

// Intention: the button of the page is a POST form with the CSRF token, no script, same classes as the link beside it; no sentence
// about a second login, neither for the cash register nor for the statement (both use the session of the area).
appTest("espace : bouton Notifications de caisse (formulaire POST), aucune phrase de seconde connexion", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  const page = await (await b.request("/espace")).text();
  assert.match(page, /<form class="espace-lien-form" method="post" action="\/espace\/caisse">\s*<input type="hidden" name="csrf" value="[0-9a-f]{64}">\s*<button type="submit" class="espace-lien">Notifications de caisse<\/button>/);
  assert.match(page, /<a class="espace-lien" href="\/espace\/releve">Relevé de transactions<\/a>/);
  assert.doesNotMatch(page, /<script/i);
  assert.doesNotMatch(page, /seconde connexion|connecter une seconde fois|propre connexion|espace-note/);
  assert.doesNotMatch(page, /Bientôt disponible/);
});

// Intention: GET on the new address is not an action (no session is opened by a link or an image).
appTest("connexion unique : GET /espace/caisse n'ouvre rien", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter();
  const res = await b.request("/espace/caisse");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/espace");
  assert.equal(app.server.inspectSessions().length, 0);
});

// Intention: the button towards the cash register looks at the account again: the list is empty here, and when the member no longer has
// a MonComptePro account (accounts changed after the login of the area) the answer is 403 and no session of /caisse is opened; when
// Cyclos fails on the accounts, the answer is the neutral 502.
appTest("connexion unique : bouton vers la caisse, MonComptePro revérifié (liste vide)", options({ caisse: { allowedUsers: { ids: [], emails: [] } } }), async (app) => {
  seed(app);
  const b = browser(app);
  assert.equal((await b.enter()).status, 303);
  app.cyclos.state.accountsBody = [{ type: { internalName: "monCompte" } }, { type: { internalName: "compteurBonus" } }];
  let res = await b.toCaisse();
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Ce compte n'est pas autorisé à ouvrir la caisse/);
  assert.equal(b.jar.get("session") ?? "", "", "no session of /caisse");
  assert.ok(app.logs.some((l) => l.endsWith("compte refusé (pas de compte MonComptePro), numéro interne Cyclos : u-marie")));
  app.cyclos.state.accountsBody = undefined;
  app.cyclos.force("GET /self/accounts", 500);
  res = await b.toCaisse();
  assert.equal(res.status, 502);
  assert.match(await res.text(), /Cyclos ne répond pas/);
  app.cyclos.state.forced.delete("GET /self/accounts");
  assert.equal((await b.toCaisse()).status, 303);
});
