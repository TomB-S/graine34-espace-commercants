// === WHAT THIS FILE CHECKS ===
// The merchants' area (/espace): the entrance page of the merchants. The real server in multi-merchant mode against a fake Cyclos.
// Login with the merchant's own Cyclos account, allowed only if CAISSE_ALLOWED_USERS lists the account; a wrong password, an
// account that is not listed and an empty list all get the very same answer; logout closes both sides; the link to the
// statement is a link to /espace/releve (same session); the brakes of the logins apply; the session of the area is apart from the one of
// /caisse. The password is never kept (session record, log, answer). All names and secrets are fictitious.
import "./support/env-propre.js";
import assert from "node:assert/strict";
import { appTest, until } from "./support/harness.js";
import { CAISSE_OPTIONS } from "./support/options.js";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { envEnfant } from "./support/env-propre.js";
import { startFakeCyclos } from "./support/fake-cyclos.js";

const WHO = {
  marie: { id: "u-marie", login: "marie", password: "mdp-marie-fictif", email: "marie@exemple.test" },
  paul: { id: "u-paul", login: "paul", password: "mdp-paul-fictif", email: "paul@exemple.test" },
  zoe: { id: "u-zoe", login: "zoe", password: "mdp-zoe-fictif", email: "zoe@exemple.test" },
};
const REFUSED = "Identifiants incorrects ou accès non autorisé.";

const options = (allowed = { ids: ["u-marie", "u-paul"], emails: [] }, more = {}, caisse = {}) => ({
  cyclosChannel: "main",
  caisseHooks: CAISSE_OPTIONS.caisseHooks,
  caisse: { enabled: true, multiMerchant: true, allowedUsers: allowed, ...caisse },
  ...more,
});

function seed(app, profiles = {}) {
  for (const w of Object.values(WHO)) app.cyclos.addUser(w.login, w.password, { id: w.id, email: w.email, entries: [], ...(profiles[w.login] ? { profile: profiles[w.login] } : {}) });
  app.cyclos.state.push.lifetimeMs = null;
}

// A small browser with one jar per cookie name, so that the area's cookie and the one of /caisse stay apart.
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
  return {
    request,
    jar,
    enter: (who, password = who.password) => request("/espace/connexion", { method: "POST", form: { login: who.login, password }, headers: { Origin: app.base } }),
    csrf: async () => (await (await request("/espace")).text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1],
    logout: (csrf) => request("/espace/deconnexion", { method: "POST", form: { csrf }, headers: { Origin: app.base } }),
  };
}

const tokensOpened = (app) => app.cyclos.calls("POST", "/auth/session").length;
const everything = (app) => app.logs.join("\n");

// Intention: an allowed merchant logs in, lands on the page with the two entries, the Cyclos call uses the channel "main", and the
// session record holds a token and a CSRF token, never the password.
appTest("espace : connexion réussie d'un compte autorisé, deux liens, canal main, aucun mot de passe gardé", options(), async (app) => {
  seed(app);
  const b = browser(app);
  const res = await b.enter(WHO.marie);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/espace");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^espace_session=[0-9a-f-]+;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/espace/);
  assert.ok(app.cyclos.calls("POST", "/auth/session").every((r) => r.headers.channel === "main"), "Channel: main");
  assert.equal(tokensOpened(app), 1, "one Cyclos token, no listening token");
  assert.equal(app.cyclos.calls("GET", "/push/subscribe").length, 0, "nothing starts listening");

  const page = await (await b.request("/espace")).text();
  assert.match(page, /Notifications de caisse/);
  assert.match(page, /<form class="espace-lien-form" method="post" action="\/espace\/caisse">/);
  assert.match(page, /Relevé de transactions/);
  assert.match(page, /action="\/espace\/deconnexion"/);
  assert.doesNotMatch(page, /name="password"/);

  const records = app.server.inspectEspaceSessions();
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), ["createdAt", "csrfToken", "lastSeenAt", "merchantId", "sessionToken"]);
  assert.ok(!JSON.stringify(records).includes(WHO.marie.password));
  assert.ok(!everything(app).includes(WHO.marie.password));
  assert.ok(!page.includes(WHO.marie.password));
});

// Intention: the whitelist also works by e-mail address, as in the multi-merchant mode.
appTest("espace : liste blanche par adresse e-mail", options({ ids: [], emails: ["marie@exemple.test"] }), async (app) => {
  seed(app);
  const b = browser(app);
  assert.equal((await b.enter(WHO.marie)).status, 303);
  assert.equal((await b.enter(WHO.paul)).status, 401);
});

// Intention: without a session /espace shows the form and nothing else, and the cookie of /espace opens nothing elsewhere.
appTest("espace : sans session, le formulaire de connexion et aucun lien", options(), async (app) => {
  seed(app);
  const b = browser(app);
  const res = await b.request("/espace");
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /action="\/espace\/connexion"/);
  assert.match(page, /name="login"/);
  assert.match(page, /type="password"/);
  assert.doesNotMatch(page, /href="\/caisse"/);
  assert.doesNotMatch(page, /Relevé de transactions/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.match(page, /\/style\.css\?v=/);
  assert.match(page, /Espace commerçants/);
});

// Intention: an account that is valid but not listed, a wrong password, an unknown login and an empty field all get the SAME status
// and the SAME page body, so nobody can learn who is on the list. The token of the refused account is closed.
appTest("espace : compte hors liste, mauvais mot de passe, inconnu : même réponse", options({ ids: ["u-marie"], emails: [] }), async (app) => {
  seed(app);
  const b = browser(app);
  const notListed = await b.enter(WHO.zoe);
  const wrongPassword = await b.enter(WHO.marie, "mauvais");
  const unknown = await b.enter({ login: "inconnu" }, "x");
  const empty = await b.enter(WHO.marie, "");
  const bodies = [];
  for (const res of [notListed, wrongPassword, unknown, empty]) {
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
    bodies.push(await res.text());
  }
  assert.ok(bodies.every((body) => body === bodies[0]), "identical pages");
  assert.ok(bodies[0].includes(REFUSED));
  assert.equal(app.server.inspectEspaceSessions().length, 0);
  await until(() => app.cyclos.state.deleted.length === 1, "token of the refused account closed");
  assert.ok(app.logs.some((l) => l.endsWith("numéro interne Cyclos : u-zoe")), "the administrator can still read the number in the log");
  assert.ok(!bodies[0].includes("u-zoe"));
  assert.ok(!everything(app).includes(WHO.zoe.email));
  assert.ok(!everything(app).includes(WHO.zoe.password));
});

// Intention: an empty list does not restrict: a merchant (MonComptePro) enters, a private member (monCompte + compteurBonus) gets the
// same refusal as a wrong password.
appTest("espace : liste vide, le commerçant entre, le particulier est refusé", options({ ids: [], emails: [] }), async (app) => {
  seed(app, { zoe: "particulier" });
  const b = browser(app);
  assert.equal((await b.enter(WHO.marie)).status, 303);
  const c = browser(app);
  const res = await c.enter(WHO.zoe);
  assert.equal(res.status, 401);
  assert.ok((await res.text()).includes(REFUSED));
  assert.equal(app.server.inspectEspaceSessions().length, 1);
  assert.ok(app.logs.some((l) => l.endsWith("compte refusé (pas de compte MonComptePro), numéro interne Cyclos : u-zoe")));
});

// Intention: list filled = on the list AND MonComptePro; a "Billets" account alone is not enough.
appTest("espace : liste remplie, la liste restreint et ne remplace pas MonComptePro", options({ ids: ["u-marie", "u-zoe"], emails: [] }), async (app) => {
  seed(app, { zoe: "particulier", paul: "commercant-billets" });
  assert.equal((await browser(app).enter(WHO.marie)).status, 303, "on the list, merchant");
  assert.equal((await browser(app).enter(WHO.paul)).status, 401, "merchant (with Billets) off the list");
  assert.ok(app.logs.some((l) => l.endsWith("compte refusé (absent de CAISSE_ALLOWED_USERS), numéro interne Cyclos : u-paul")));
  assert.equal((await browser(app).enter(WHO.zoe)).status, 401, "private member on the list");
});

appTest("espace : un compte Billets seul est refusé", options({ ids: [], emails: [] }), async (app) => {
  seed(app, { marie: "billets-seul" });
  assert.equal((await browser(app).enter(WHO.marie)).status, 401);
  assert.equal((await browser(app).enter(WHO.paul)).status, 303);
});

// Intention: Cyclos failing on /self/accounts: neutral 502 "Cyclos ne répond pas", token closed, no session. A 403 gives the
// usual refusal and is not counted by the brake.
appTest("espace : erreur de Cyclos sur /self/accounts -> 502 neutre ; 403 -> refus uniforme non compté", options({ ids: [], emails: [] }), async (app) => {
  seed(app);
  const b = browser(app);
  app.cyclos.force("GET /self/accounts", 500);
  let res = await b.enter(WHO.marie);
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /Cyclos ne répond pas/);
  assert.ok(!html.includes("MonComptePro"));
  assert.equal(app.server.inspectEspaceSessions().length, 0);
  await until(() => app.cyclos.state.deleted.length === 1, "token closed");
  app.cyclos.force("GET /self/accounts", 403);
  for (let i = 0; i < 6; i += 1) {
    res = await b.enter(WHO.marie);
    assert.equal(res.status, 401, `try ${i + 1}`);
    assert.ok((await res.text()).includes(REFUSED));
  }
  app.cyclos.state.forced.delete("GET /self/accounts");
  assert.equal((await b.enter(WHO.marie)).status, 303);
});

// Intention: logout closes the Cyclos token and the local session; it needs the CSRF token of the area's session.
appTest("espace : déconnexion, jeton Cyclos fermé, session détruite, jeton CSRF exigé", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter(WHO.marie);
  const csrf = await b.csrf();
  assert.ok(csrf);

  assert.equal((await b.logout("faux")).status, 403, "bad CSRF token");
  assert.equal(app.server.inspectEspaceSessions().length, 1, "still open");
  assert.equal((await b.request("/espace/deconnexion")).status, 405, "never by a simple link");

  const out = await b.logout(csrf);
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), "/espace");
  assert.match(out.headers.get("set-cookie"), /^espace_session=;.*Max-Age=0/);
  await until(() => app.cyclos.state.deleted.length === 1, "Cyclos token closed");
  assert.equal(app.server.inspectEspaceSessions().length, 0);
  assert.match(await (await b.request("/espace")).text(), /action="\/espace\/connexion"/, "the form again");
  assert.equal((await b.logout(csrf)).status, 303, "without a session: just back to the page");
});

// Intention: the statement is an entry of the page, a link inside this site (no other address, no "coming soon"), next to the form button of the cash register.
appTest("espace : « Relevé de transactions » est un lien interne vers /espace/releve", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter(WHO.marie);
  const page = await (await b.request("/espace")).text();
  assert.match(page, /<a class="espace-lien" href="\/espace\/releve">Relevé de transactions<\/a>/);
  assert.doesNotMatch(page, /Bientôt disponible|propre connexion/);
  const links = [...page.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]).filter((href) => !href.startsWith("/style.css"));
  // updated: the logo of the header is now a link to the area itself (multi-merchant mode); the other link is still only the statement.
  assert.deepEqual(links, ["/espace", "/espace/releve"], "the only links of the page stay inside the site");
  assert.match(page, /action="\/espace\/caisse"/);
  assert.equal((await b.request("/espace/releve")).status, 200, "the link opens the statement with the same session, no second login");
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 1);
});

// Intention: the same brakes as the other logins: 5 refusals of one identifier turn it away without reaching Cyclos, and the
// answer says so; the brakes are shared with /connexion.
appTest("espace : frein sur les connexions, l'identifiant bloqué n'atteint plus Cyclos", options(), async (app) => {
  seed(app);
  const b = browser(app);
  for (let i = 0; i < 5; i += 1) assert.equal((await b.enter(WHO.marie, "mauvais")).status, 401);
  const before = tokensOpened(app);
  const blocked = await b.enter(WHO.marie);
  assert.equal(blocked.status, 429, "even with the right password");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.match(await blocked.text(), /href="\/espace"/);
  assert.equal(tokensOpened(app), before, "no call to Cyclos");
  assert.equal((await b.enter(WHO.paul)).status, 303, "another account is not affected");
  assert.equal((await b.request("/connexion", { method: "POST", form: { login: "marie", password: WHO.marie.password }, headers: { Origin: app.base } })).status, 429, "same counter on /connexion");
});

// Intention: the brakes by address apply too (10 refusals from one address, whatever the identifiers).
appTest("espace : frein par adresse, des identifiants différents ne contournent pas la limite", options(), async (app) => {
  seed(app);
  const b = browser(app);
  for (let i = 0; i < 10; i += 1) assert.equal((await b.enter({ login: `inconnu${i}` }, "x")).status, 401);
  assert.equal((await b.enter(WHO.marie)).status, 429);
});

// Intention: the address is read with CAISSE_TRUSTED_PROXY_HOPS, like the other logins: behind one relay, two visitors do not share a counter.
appTest("espace : adresse lue derrière un relais de confiance", options(undefined, {}, { trustedProxyHops: 1 }), async (app) => {
  seed(app);
  const b = browser(app);
  const from = (ip) => ({ "X-Forwarded-For": ip, Origin: app.base });
  const attempt = (ip, login) => b.request("/espace/connexion", { method: "POST", form: { login, password: "x" }, headers: from(ip) });
  for (let i = 0; i < 10; i += 1) assert.equal((await attempt("203.0.113.7", `a${i}`)).status, 401);
  assert.equal((await attempt("203.0.113.7", "a-de-plus")).status, 429);
  assert.equal((await attempt("203.0.113.8", "b")).status, 401, "another visitor behind the same relay");
  assert.ok(app.logs.some((l) => l.startsWith("adresse lue 203.0.113.7 (X-Forwarded-For")));
});

// Intention: the POST of the login checks its origin, like the other one.
appTest("espace : connexion refusée sans origine du site", options(), async (app) => {
  seed(app);
  const b = browser(app);
  const res = await b.request("/espace/connexion", { method: "POST", form: { login: "marie", password: WHO.marie.password }, headers: { Origin: "https://autre.test" } });
  assert.equal(res.status, 403);
  assert.equal(tokensOpened(app), 0);
});

// Intention: Cyclos down: a clear 502 on the area's own page, counted by the circuit breaker.
appTest("espace : Cyclos en panne, message clair et disjoncteur", options(), async (app) => {
  seed(app);
  const b = browser(app);
  app.cyclos.force("POST /auth/session", 500);
  for (let i = 0; i < 5; i += 1) {
    const res = await b.enter(WHO.marie);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /href="\/espace"/);
  }
  const calls = tokensOpened(app);
  assert.equal((await b.enter(WHO.marie)).status, 503);
  assert.equal(tokensOpened(app), calls);
});

// Intention: the session of the area is NOT the one of /caisse, in both directions: the merchant logs in again on /caisse.
appTest("espace : session séparée de celle de /caisse", options(), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter(WHO.marie);
  const caisse = await b.request("/caisse");
  assert.equal(caisse.status, 303, "no cash register session: back to its login");
  assert.equal(caisse.headers.get("location"), "/connexion", "the form of /caisse, since / now leads to the area");
  const data = await b.request("/caisse/data");
  assert.equal(data.status, 401);
  // Logging in on /caisse opens its own session and does not touch the one of the area.
  const login = await b.request("/connexion", { method: "POST", form: { login: "marie", password: WHO.marie.password }, headers: { Origin: app.base } });
  assert.equal(login.status, 303);
  assert.notEqual(b.jar.get("session"), b.jar.get("espace_session"));
  assert.equal(app.server.inspectEspaceSessions().length, 1);
  assert.equal(app.server.inspectSessions().length, 1);
  // And the cookie of the cash register does not open the area.
  const other = browser(app);
  other.jar.set("session", b.jar.get("session"));
  assert.match(await (await other.request("/espace")).text(), /action="\/espace\/connexion"/);
});

// Intention: an idle session of the area expires like the others and its Cyclos token is closed.
appTest("espace : session expirée, retour au formulaire, jeton Cyclos fermé", options(undefined, { idleMs: 50, maxMs: 60_000 }), async (app) => {
  seed(app);
  const b = browser(app);
  await b.enter(WHO.marie);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.match(await (await b.request("/espace")).text(), /action="\/espace\/connexion"/);
  await until(() => app.cyclos.state.deleted.length === 1, "token closed");
  assert.equal(app.server.inspectEspaceSessions().length, 0);
});

// === Without the multi-merchant mode ===

// Intention: the area needs the multi-merchant mode (its list, its brakes): without it every /espace address is a 404, nothing is opened.
appTest("espace : sans le mode multi-commerçants, 404 partout", { cyclosChannel: "main", ...CAISSE_OPTIONS }, async (app) => {
  for (const [method, path] of [["GET", "/espace"], ["POST", "/espace/connexion"], ["POST", "/espace/deconnexion"], ["GET", "/espace/autre"]]) {
    const res = await fetch(`${app.base}${path}`, { method, redirect: "manual", headers: { Origin: app.base } });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
});

appTest("espace : caisse désactivée, 404", { cyclosChannel: "main" }, async (app) => {
  assert.equal((await fetch(`${app.base}/espace`)).status, 404);
});

// Intention: for real, `node src/server.js` with the environment variables: the start still says "Canal Cyclos : main", the area works
// end to end, and the old setting ESPACE_RELEVE_URL (removed: the statement is part of the site) is not read any more, even with a bad value.
test("node src/server.js : l'espace fonctionne, ESPACE_RELEVE_URL n'est plus lu, le démarrage affiche toujours « Canal Cyclos : main »", async () => {
  const cyclos = await startFakeCyclos();
  cyclos.addUser("marie", WHO.marie.password, { id: WHO.marie.id, email: WHO.marie.email, entries: [] });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("../", import.meta.url),
    env: envEnfant({
      PORT: String(port),
      CYCLOS_BASE_URL: cyclos.url,
      CYCLOS_CHANNEL: "main",
      CAISSE_ENABLED: "true",
      CAISSE_MULTI_MERCHANT: "true",
      CAISSE_ALLOWED_USERS: WHO.marie.id,
      ESPACE_RELEVE_URL: "javascript:alert(1)",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    for (let i = 0; i < 100 && !output.includes("Caisse : activée"); i += 1) await new Promise((r) => setTimeout(r, 30));
    assert.match(output, /Canal Cyclos : main\n/);
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/espace/connexion`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login: "marie", password: WHO.marie.password }).toString(),
    });
    assert.equal(login.status, 303);
    const page = await (await fetch(`${base}/espace`, { headers: { Cookie: login.headers.get("set-cookie").split(";")[0] } })).text();
    assert.match(page, /href="\/espace\/releve"/);
    assert.ok(!page.includes("javascript:"));
    assert.ok(!output.includes(WHO.marie.password));
  } finally {
    child.kill("SIGTERM");
    await exited;
    await cyclos.close();
  }
});
