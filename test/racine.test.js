// === WHAT THIS FILE CHECKS ===
// The root address "/". In the multi-merchant mode it leads to the merchants' area (/espace) with a temporary redirect, for GET and
// HEAD; the login form of /caisse stays reachable at /connexion and every link, redirect and script address that used to point to "/"
// now points there. Without the multi-merchant mode (single account, executable) "/" is exactly what it always was: the login form.
// All names and secrets are fictitious.
import "./support/env-propre.js";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { appTest } from "./support/harness.js";
import { isolerEnv } from "./support/env-propre.js";
import { startFakeCyclos } from "./support/fake-cyclos.js";
import { startServer } from "../src/server.js";
import { CAISSE_OPTIONS } from "./support/options.js";

const MARIE = { login: "marie", password: "mdp-marie-fictif", id: "u-marie" };
const multi = { cyclosChannel: "main", caisseHooks: CAISSE_OPTIONS.caisseHooks, caisse: { enabled: true, multiMerchant: true, allowedUsers: { ids: ["u-marie"], emails: [] } } };
const get = (app, path, init = {}) => fetch(`${app.base}${path}`, { redirect: "manual", ...init });

// Intention: in the multi mode GET / and HEAD / lead to /espace, with a temporary redirect that nothing keeps.
appTest("racine multi : GET / et HEAD / redirigent vers /espace, redirection temporaire, sans cache", multi, async (app) => {
  for (const method of ["GET", "HEAD"]) {
    const res = await get(app, "/", { method });
    assert.equal(res.status, 307, method);
    assert.equal(res.headers.get("location"), "/espace");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  }
});

// Intention: somebody already logged in to /caisse who opens "/" arrives at /espace too (wanted).
appTest("racine multi : même une personne connectée à /caisse arrive sur /espace", multi, async (app) => {
  app.cyclos.addUser(MARIE.login, MARIE.password, { id: MARIE.id, entries: [] });
  assert.equal((await app.login(MARIE)).status, 303);
  const res = await app.request("/");
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), "/espace");
});

// Intention: the form of /caisse is still reachable (at /connexion) and still logs in; the other methods on "/" are not redirected.
appTest("racine multi : le formulaire de /caisse reste accessible sur /connexion et fonctionne", multi, async (app) => {
  app.cyclos.addUser(MARIE.login, MARIE.password, { id: MARIE.id, entries: [] });
  const res = await get(app, "/connexion");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  const page = await res.text();
  assert.match(page, /action="\/connexion"/);
  assert.match(page, /name="password"/);
  const login = await app.login(MARIE);
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/caisse");
  assert.equal((await get(app, "/", { method: "POST" })).status, 404, "only GET and HEAD are redirected");
});

// Intention: the existing links and redirects of /caisse do not lead to the area by accident: without a session, after a logout, on the
// error pages and in the script address, they all point to the form (/connexion).
appTest("racine multi : redirections, liens « Retour » et adresse du script visent /connexion", multi, async (app) => {
  app.cyclos.addUser(MARIE.login, MARIE.password, { id: MARIE.id, entries: [] });
  app.cyclos.state.push.lifetimeMs = null;
  assert.equal((await get(app, "/caisse")).headers.get("location"), "/connexion", "no session");
  assert.equal((await get(app, "/deconnexion", { method: "POST", headers: {} })).headers.get("location"), "/connexion", "logout without a session");

  // Too many attempts: the page offers a way back to the form.
  for (let i = 0; i < 5; i += 1) await app.login({ login: MARIE.login, password: "mauvais" });
  const blocked = await (await app.login(MARIE)).text();
  assert.match(blocked, /href="\/connexion"/);
  assert.doesNotMatch(blocked, /href="\/"/);
});

appTest("racine multi : la page /caisse donne /connexion au script, et la déconnexion y revient", multi, async (app) => {
  app.cyclos.addUser(MARIE.login, MARIE.password, { id: MARIE.id, entries: [] });
  app.cyclos.state.push.lifetimeMs = null;
  await app.login(MARIE);
  const html = await (await app.request("/caisse")).text();
  assert.match(html, /data-login-url="\/connexion"/);
  const csrf = html.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  const out = await app.request("/deconnexion", { method: "POST", form: { csrf }, headers: { Origin: app.base } });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), "/connexion");
});

// Intention: a direct GET of /caisse (no session of the cash register) still leads to the login form of /caisse. The button of /espace
// is a POST (/espace/caisse), tested in connexion-unique.test.js.
appTest("racine multi : /caisse sans session de caisse, même après /espace, mène au formulaire de /caisse", multi, async (app) => {
  app.cyclos.addUser(MARIE.login, MARIE.password, { id: MARIE.id, entries: [] });
  const jar = [];
  const enter = await get(app, "/espace/connexion", { method: "POST", headers: { Origin: app.base, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ login: MARIE.login, password: MARIE.password }).toString() });
  assert.equal(enter.status, 303);
  jar.push(enter.headers.get("set-cookie").split(";")[0]);
  const home = await (await get(app, "/espace", { headers: { Cookie: jar.join("; ") } })).text();
  assert.match(home, /action="\/espace\/caisse"/);
  const caisse = await get(app, "/caisse", { headers: { Cookie: jar.join("; ") } });
  assert.equal(caisse.headers.get("location"), "/connexion");
  assert.equal((await get(app, "/connexion")).status, 200);
});

// === Without the multi-merchant mode: "/" does not change at all ===

appTest("racine hors mode multi : « / » reste le formulaire de connexion, /connexion en GET n'existe pas", { cyclosChannel: "main", ...CAISSE_OPTIONS }, async (app) => {
  const res = await get(app, "/");
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /action="\/connexion"/);
  assert.equal(res.headers.get("location"), null);
  assert.equal((await get(app, "/", { method: "HEAD" })).status, 404, "HEAD / was never answered, and still is not");
  assert.equal((await get(app, "/connexion")).status, 404);
  // Links and redirects are the ones of before.
  assert.equal((await get(app, "/caisse")).headers.get("location"), "/");
  await app.login({ login: "x", password: "y" });
  const csrf = await app.loggedIn();
  const html = await (await app.request("/caisse")).text();
  assert.match(html, /data-login-url="\/"/);
  const out = await app.request("/deconnexion", { method: "POST", form: { csrf }, headers: { Origin: app.base } });
  assert.equal(out.headers.get("location"), "/");
});

appTest("racine, caisse désactivée : « / » reste le formulaire de connexion", { cyclosChannel: "main" }, async (app) => {
  const res = await get(app, "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /action="\/connexion"/);
});

// Intention: in the executable the multi-merchant flag is ignored, so "/" is still the login form and nothing redirects.
test("racine, exécutable : le drapeau multi est ignoré, « / » reste le formulaire", async () => {
  const restore = isolerEnv();
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
  const cyclos = await startFakeCyclos();
  process.env.CAISSE_MULTI_MERCHANT = "true";
  process.env.CAISSE_ALLOWED_USERS = "u-marie";
  const server = await startServer({ port: 0, host: "127.0.0.1", cyclosBaseUrl: cyclos.url, listenOnLogin: true, caisseHooks: CAISSE_OPTIONS.caisseHooks });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /action="\/connexion"/);
    assert.equal((await fetch(`${base}/connexion`, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(`${base}/espace`, { redirect: "manual" })).status, 404);
  } finally {
    await server.close();
    await cyclos.close();
    mock.restoreAll();
    restore();
  }
});
