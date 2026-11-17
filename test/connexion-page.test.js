// Login typed on the page of the browser, which starts the listening (single executable: startServer({ listenOnLogin: true })).
// Covered here: the listening started by the login, the credentials living only as long as the page session, the rule
// of one attempt (one form = one call to Cyclos, pauses after a refusal), the Host check, the first account being the
// merchant, and the hosted mode (no option) staying as it was. Real server, fake Cyclos, FICTITIOUS values only: the
// password never appears in a log, in a page or in a message.
import "../test-support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appTest, until, rawRequest } from "../test-support/harness.js";
import { CAISSE_OPTIONS } from "../test-support/options.js";
import { USER } from "../test-support/fake-cyclos.js";
import { startServer } from "../server.js";
import { readCaisseConfig } from "../caisse-config.js";
import { createListenerManager } from "../listener-manager.js";

const WRONG = "faux-mot-de-passe-fictif";
const SHORT = 150;
const LONG = 600;
const OPTIONS = { caisseHooks: CAISSE_OPTIONS.caisseHooks, listenOnLogin: true, loginPauseMs: SHORT, loginLongPauseMs: LONG };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logins = (app) => app.cyclos.calls("POST", "/auth/session").length;
const everything = (app) => app.logs.join("\n");

appTest("page : une connexion réussie démarre l'écoute, avec deux connexions Cyclos seulement", OPTIONS, async (app) => {
  const res = await app.login();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/caisse");
  assert.equal(logins(app), 1, "the form login");
  const data = await app.request("/caisse/data");
  assert.equal(data.status, 200);
  assert.equal(logins(app), 2, "the form login and the listener's own login, no separate identity check");
  assert.equal((await app.request("/caisse")).status, 200);
  assert.ok(!everything(app).includes(USER.password), "the password is in no log");
});

appTest("page : la limite de session est celle donnée par l'option (cookie)", { ...OPTIONS, maxMs: 12 * 3_600_000 }, async (app) => {
  const res = await app.login();
  assert.match(res.headers.get("set-cookie"), /Max-Age=43200/);
});

appTest("page : la caisse n'écoute pas tant que personne ne s'est connecté", OPTIONS, async (app) => {
  assert.equal((await app.request("/caisse")).headers.get("location"), "/", "no session: the form");
  assert.equal(logins(app), 0, "nothing is sent to Cyclos before a login");
});

// ---- the rule of one attempt

appTest("page : un refus = une seule demande à Cyclos, puis pause (le mot de passe n'est nulle part)", OPTIONS, async (app) => {
  const first = await app.login({ password: WRONG });
  assert.equal(first.status, 401);
  const page = await first.text();
  assert.match(page, /nouvelle tentative sera possible/);
  assert.ok(!page.includes(WRONG));
  assert.equal(logins(app), 1);

  const tooSoon = await app.login({ password: WRONG });
  assert.equal(tooSoon.status, 429);
  assert.ok(Number(tooSoon.headers.get("retry-after")) >= 1);
  assert.equal(logins(app), 1, "no second call to Cyclos during the pause");
  assert.ok(!everything(app).includes(WRONG));
});

appTest("page : après la pause courte une tentative est permise, le deuxième refus de suite donne la pause longue", OPTIONS, async (app) => {
  assert.equal((await app.login({ password: WRONG })).status, 401);
  await pause(SHORT + 60);
  assert.equal((await app.login({ password: WRONG })).status, 401, "allowed after the short pause");
  assert.equal(logins(app), 2);
  await pause(SHORT + 60);
  assert.equal((await app.login({ password: WRONG })).status, 429, "the short pause is over but the long one runs");
  assert.equal(logins(app), 2);
  await pause(LONG);
  const good = await app.login();
  assert.equal(good.status, 303, "the right password works after the long pause");
  assert.equal(logins(app), 3);
});

appTest("page : un succès remet le compteur à zéro", OPTIONS, async (app) => {
  assert.equal((await app.login({ password: WRONG })).status, 401);
  await pause(SHORT + 60);
  assert.equal((await app.login()).status, 303);
  app.cookie = "";
  assert.equal((await app.login({ password: WRONG })).status, 401, "a first refusal again, not a second one in a row");
  await pause(SHORT + 60);
  assert.equal((await app.login()).status, 303, "only the short pause ran, not the long one");
});

appTest("page : une demande de connexion pendant qu'une autre est vérifiée est refusée", OPTIONS, async (app) => {
  app.cyclos.force("POST /auth/session", "hang");
  const controller = new AbortController();
  const pending = fetch(`${app.base}/connexion`, {
    method: "POST",
    headers: { Origin: app.base, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: USER.login, password: USER.password }).toString(),
    signal: controller.signal,
  }).catch(() => null);
  await until(() => logins(app) === 1, "the first login reaches Cyclos");
  const second = await app.login();
  assert.equal(second.status, 429);
  assert.equal(logins(app), 1, "the second form never reaches Cyclos");
  controller.abort();
  await pending;
  // The pending call to Cyclos ends when the fake Cyclos stops; wait for the server to be done with it, so that it
  // cannot touch the next test (the login state is shared by the whole process).
  await app.cyclos.close();
  await until(() => everything(app).includes("Cyclos injoignable"), "the pending login ends");
});

appTest("page : Cyclos demande de patienter (429) : pause longue aussitôt", OPTIONS, async (app) => {
  app.cyclos.force("POST /auth/session", 429);
  assert.equal((await app.login()).status, 503);
  app.cyclos.force("POST /auth/session", 200);
  await pause(SHORT + 60);
  assert.equal((await app.login()).status, 429, "still paused after the short delay");
  assert.equal(logins(app), 1);
});

appTest("page : Cyclos en erreur : un message, pas de nouvel essai du serveur, pause courte", OPTIONS, async (app) => {
  app.cyclos.force("POST /auth/session", 500);
  const res = await app.login();
  assert.equal(res.status, 502);
  assert.match(await res.text(), /Impossible de joindre Cyclos/);
  assert.equal(logins(app), 1, "one form = one call");
  assert.equal((await app.login()).status, 429);
  app.cyclos.force("POST /auth/session", 200);
  await pause(SHORT + 60);
  assert.equal((await app.login()).status, 303);
});

appTest("page : champs vides : refus sans appel à Cyclos", OPTIONS, async (app) => {
  assert.equal((await app.login({ login: "", password: "" })).status, 401);
  assert.equal(logins(app), 0);
});

// ---- the credentials live with the page session

appTest("page : la déconnexion efface le mot de passe, l'écoute ne se reconnecte plus", OPTIONS, async (app) => {
  const csrf = await app.loggedIn();
  assert.equal((await app.request("/caisse/data")).status, 200);
  assert.equal(logins(app), 2);
  await app.request("/deconnexion", { method: "POST", form: { csrf }, headers: { Origin: app.base } });
  app.cyclos.expireTokens();
  app.cyclos.endStreams();
  await until(() => everything(app).includes("aucun identifiant d'écoute configuré"), "the listener finds no credentials");
  assert.equal(logins(app), 2, "no new login to Cyclos once the session is closed");
});

appTest("page : l'expiration de la session efface le mot de passe", OPTIONS, async (app) => {
  await app.loggedIn();
  assert.equal((await app.request("/caisse/data")).status, 200);
  app.server.sweep(Date.now() + 13 * 3_600_000);
  app.cyclos.expireTokens();
  app.cyclos.endStreams();
  await until(() => everything(app).includes("aucun identifiant d'écoute configuré"), "the listener finds no credentials");
  assert.equal(logins(app), 2);
  assert.equal((await app.request("/caisse")).headers.get("location"), "/", "the visitor gets the form again");
});

appTest("page : si Cyclos refuse les identifiants à la reconnexion, un seul essai, retour au formulaire", OPTIONS, async (app) => {
  await app.loggedIn();
  assert.equal((await app.request("/caisse/data")).status, 200);
  assert.equal(logins(app), 2);
  app.cyclos.force("POST /auth/session", 401);
  app.cyclos.expireTokens();
  app.cyclos.endStreams();
  await until(() => logins(app) === 3, "the listener tries once");
  await until(() => everything(app).includes("aucun identifiant d'écoute configuré"), "the listener gives up: nothing left to try");
  await pause(300);
  assert.equal(logins(app), 3, "never a second try");
  assert.equal((await app.request("/caisse")).headers.get("location"), "/", "the session is gone: the form");
  assert.ok(!everything(app).includes(USER.password));
});

// ---- the merchant is the first account that logged in

appTest("page : le premier compte connecté est le commerçant, un autre compte est refusé", OPTIONS, async (app) => {
  app.cyclos.addUser("autre", "mot-de-passe-autre-fictif", { id: "user-2" });
  assert.equal((await app.login()).status, 303);
  assert.equal((await app.request("/caisse")).status, 200);
  app.cookie = "";
  assert.equal((await app.login({ login: "autre", password: "mot-de-passe-autre-fictif" })).status, 303);
  assert.equal((await app.request("/caisse")).status, 403, "another account is not the registered merchant");
  assert.equal((await app.request("/caisse/data")).status, 403);
});

// ---- Host check

appTest("page : seuls les noms de cette machine sont servis (Host)", OPTIONS, async (app) => {
  const { port } = new URL(app.base);
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
    const res = await rawRequest(app.base, { path: "/", headers: { Host: host } });
    assert.equal(res.status, 200, host);
  }
  for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `127.0.0.1:${Number(port) + 1}`]) {
    const res = await rawRequest(app.base, { path: "/", headers: { Host: host } });
    assert.equal(res.status, 403, JSON.stringify(host));
    assert.equal(res.body.toString(), "Adresse non autorisée");
  }
  const post = await rawRequest(app.base, {
    method: "POST",
    path: "/connexion",
    headers: { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}`, "Content-Type": "application/x-www-form-urlencoded" },
    chunks: [`login=${USER.login}&password=${WRONG}`],
  });
  assert.equal(post.status, 403);
  assert.equal(logins(app), 0, "a refused host never reaches Cyclos");
});

// ---- the hosted mode (npm start) is as it was

appTest("hébergé : sans l'option, pas de pause après un refus, pas de contrôle de Host", { ...CAISSE_OPTIONS }, async (app) => {
  assert.equal((await app.login({ password: WRONG })).status, 401);
  assert.equal((await app.login({ password: WRONG })).status, 401, "no pause: the throttle is the one per address (5 failures)");
  assert.equal(logins(app), 2);
  const res = await rawRequest(app.base, { path: "/", headers: { Host: "ma-caisse.example" } });
  assert.equal(res.status, 200);
});

appTest("hébergé : les identifiants viennent toujours de la configuration, la connexion ne les garde pas", { ...CAISSE_OPTIONS }, async (app) => {
  await app.loggedIn();
  assert.equal((await app.request("/caisse/data")).status, 200);
  const csrf = await app.csrf();
  await app.request("/deconnexion", { method: "POST", form: { csrf }, headers: { Origin: app.base } });
  app.cyclos.expireTokens();
  app.cyclos.endStreams();
  await until(() => logins(app) >= 3, "the listener logs in again with the configured credentials");
});

// ---- start-up options and configuration

test("démarrage : la connexion qui démarre l'écoute exige l'adresse locale", async () => {
  await assert.rejects(startServer({ port: 0, host: "0.0.0.0", listenOnLogin: true }), /écoute locale/);
  await assert.rejects(startServer({ port: 0, listenOnLogin: true }), /écoute locale/);
});

test("configuration : avec credentialsFromLogin, rien n'est exigé ni lu (même si l'environnement ou une valeur en donne)", () => {
  const env = { CAISSE_ENABLED: "true", CAISSE_CYCLOS_LOGIN: "depuis-env", CAISSE_CYCLOS_PASSWORD: "depuis-env-fictif" };
  const config = readCaisseConfig(env, { credentialsFromLogin: true, login: "x", password: "y" });
  assert.equal(config.credentialsFor("prototype").login, "", "nothing taken from the environment or the overrides");
  assert.equal(config.credentialsFor("prototype").password, "");
  assert.doesNotThrow(() => readCaisseConfig({ CAISSE_ENABLED: "true" }, { credentialsFromLogin: true }));
  assert.throws(() => readCaisseConfig({ CAISSE_ENABLED: "true" }, {}), /CAISSE_CYCLOS_LOGIN/, "hosted mode still demands them");
});

test("gestionnaire : l'identité donnée par la connexion suffit, aucune connexion Cyclos pour la lire", async () => {
  const push = { createSession: async () => assert.fail("no login expected"), closeSession: async () => {}, getUserId: async () => assert.fail("no read expected") };
  const config = { idleSeconds: 45, maxListeners: 5, reauthMax: 3, ticketsKept: 10, credentialsFor: () => null };
  const manager = createListenerManager({ config, push, log: { info() {}, error() {} } });
  try {
    assert.equal(manager.listenerId, null);
    manager.bindIdentity("");
    manager.bindIdentity(undefined);
    assert.equal(manager.listenerId, null, "an unreadable id binds nothing");
    manager.bindIdentity("user-1");
    manager.bindIdentity("user-2");
    assert.equal(manager.listenerId, "user-1", "the first one stays");
    assert.deepEqual(await manager.authorize("user-1"), { ok: true, merchantKey: "prototype" });
    assert.deepEqual(await manager.authorize("user-2"), { ok: false, status: 403 });
  } finally {
    await manager.stopAll();
  }
});
