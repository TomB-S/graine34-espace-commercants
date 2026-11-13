// === WHAT THIS FILE CHECKS ===
// Everything that touches the merchant's identity: login, blocking after too many failures, session duration,
// logout, CSRF protection and Cyclos refusals (403) or outages. A password that leaks or a session that never
// closes would be serious. Uses the harness (test-support/harness.js: real server + fake Cyclos, never the real Cyclos).
// /caisse is the only page behind the login, so it is the page used to tell "logged in" (200) from "not logged in" (303):
// that is why these tests start the server with CAISSE_OPTIONS (see test-support/options.js).
// `mock` (from node:test) FAKES THE CLOCK: we advance time by 20 minutes in one millisecond to test session expiry.
import { mock } from "node:test";
import assert from "node:assert/strict";
import { appTest, until, USER } from "../test-support/harness.js";
import { CAISSE_OPTIONS } from "../test-support/options.js";

// One minute in milliseconds (JavaScript durations are in ms).
const MINUTE = 60_000;
const status = async (app, path = "/caisse") => (await app.request(path)).status;

// ------------------------------------------------------------ login

// Intention: after a successful login we are redirected (303) to /caisse with a session cookie (HttpOnly, SameSite=Lax, 8 hours),
// the password goes to Cyclos only ONCE, and the Cyclos token is never in the cookie nor in the page.
appTest("connexion réussie : 303 vers /caisse, cookie de session, jeton Cyclos jamais exposé", CAISSE_OPTIONS, async (app) => {
  const res = await app.login();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/caisse");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^session=[0-9a-f-]{36}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800$/);

  const calls = app.cyclos.calls("POST", "/auth/session");
  assert.equal(calls.length, 1);
  assert.equal(
    Buffer.from(calls[0].headers.authorization.replace("Basic ", ""), "base64").toString(),
    `${USER.login}:${USER.password}`,
  );

  const page = await app.request("/caisse");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(!/jeton-\d/.test(html), "le jeton Cyclos ne doit pas être dans la page");
  assert.ok(!/jeton-\d/.test(cookie));
  // Calls made with the visitor's own token never carry the password again.
  for (const call of app.cyclos.state.requests.filter((r) => r.path !== "/auth/session" || r.method !== "POST")) {
    assert.equal(call.headers.authorization, undefined);
  }
});

// Intention: a wrong password gives 401, no cookie, and the typed text is not sent back in the page.
appTest("connexion refusée : 401, pas de cookie, page « Connexion échouée »", CAISSE_OPTIONS, async (app) => {
  const res = await app.login({ password: "mauvais" });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
  const html = await res.text();
  assert.match(html, /Connexion échouée/);
  assert.match(html, /Identifiant ou mot de passe incorrect/);
  assert.ok(!html.includes("mauvais"));
  assert.equal(await status(app), 303); // still no session
});

appTest("connexion : champs vides -> 401 sans appeler Cyclos", async (app) => {
  for (const form of [{}, { login: "a" }, { password: "b" }, { login: "", password: "" }]) {
    const res = await app.request("/connexion", { method: "POST", form, headers: { Origin: app.base } });
    assert.equal(res.status, 401);
  }
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
});

// Intention: a login or password with accents, ":" or Japanese characters is sent to Cyclos in UTF-8.
appTest("connexion : identifiants avec accents et caractères non latins transmis en UTF-8", async (app) => {
  const res = await app.login({ login: "Élodie", password: "pässwörd:日本" });
  assert.equal(res.status, 401); // unknown to the fake Cyclos, but the request was indeed made
  const [call] = app.cyclos.calls("POST", "/auth/session");
  assert.equal(
    Buffer.from(call.headers.authorization.replace("Basic ", ""), "base64").toString("utf-8"),
    "Élodie:pässwörd:日本",
  );
});

// Intention: after 5 failures from the same address, further attempts get 429, even with the right password, and no longer reach Cyclos.
appTest("429 après 5 échecs depuis la même adresse, même avec le bon mot de passe", async (app) => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await app.login({ password: "faux" })).status, 401, `essai ${i + 1}`);
  }
  const blocked = await app.login();
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 15 * 60, `Retry-After = ${retryAfter}`);
  assert.match(await blocked.text(), /Trop d'échecs de connexion.*Réessayez dans 15 minutes/);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 5, "le 6e essai n'atteint pas Cyclos");
  assert.equal(blocked.headers.get("set-cookie"), null);
});

// Intention: the block lifts after 15 minutes: `sweep` (the periodic cleanup) is called with a future date.
appTest("429 : le blocage se lève après 15 minutes (nettoyage périodique)", async (app) => {
  for (let i = 0; i < 5; i += 1) await app.login({ password: "faux" });
  assert.equal((await app.login()).status, 429);
  app.server.sweep(Date.now() + 14 * MINUTE);
  assert.equal((await app.login()).status, 429, "pas encore 15 minutes");
  app.server.sweep(Date.now() + 15 * MINUTE + 1000);
  assert.equal((await app.login()).status, 303);
});

// Intention: only genuinely wrong passwords count; a rights refusal (403) or an outage (500) never blocks an honest merchant.
appTest("429 : seuls les identifiants refusés comptent (403 et pannes de Cyclos non)", async (app) => {
  app.cyclos.force("POST /auth/session", 403);
  for (let i = 0; i < 7; i += 1) assert.equal((await app.login()).status, 403);
  app.cyclos.force("POST /auth/session", 500);
  for (let i = 0; i < 7; i += 1) assert.equal((await app.login()).status, 502);
  app.cyclos.state.forced.clear();
  assert.equal((await app.login()).status, 303);
});

// Intention (security): the login form is only accepted if it comes from a page of OUR site (Origin, or Referer), before any call to Cyclos.
appTest("Origin étranger, absent ou « null » : connexion refusée avant tout appel à Cyclos", async (app) => {
  const attempt = (headers) => app.request("/connexion", { method: "POST", form: { login: USER.login, password: USER.password }, headers });
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, {}, { Referer: "https://evil.example/page" }, { Origin: "http://127.0.0.1:1" }]) {
    const res = await attempt(headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.match(await res.text(), /Origine de la requête non autorisée/);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
  assert.equal((await attempt({ Origin: app.base })).status, 303);
  app.cookie = "";
  assert.equal((await attempt({ Referer: `${app.base}/` })).status, 303);
});

// Intention (security): in varied situations the password appears NEITHER in the responses NOR in the server log.
appTest("le mot de passe n'apparaît ni dans les réponses ni dans les logs", CAISSE_OPTIONS, async (app) => {
  const secret = "S3cret-à-ne-jamais-voir";
  const seen = [];
  const note = async (res) => {
    seen.push(JSON.stringify([...res.headers]), await res.text());
  };

  await note(await app.login({ password: secret })); // refused
  await note(await app.request("/connexion", { method: "POST", form: { login: USER.login, password: secret } })); // missing Origin
  app.cyclos.force("POST /auth/session", 500);
  await note(await app.login({ password: secret })); // Cyclos down -> error logged
  app.cyclos.force("POST /auth/session", "drop");
  await note(await app.login({ password: secret })); // connection cut -> error logged
  app.cyclos.state.forced.clear();
  app.cyclos.force("POST /auth/session", 403);
  await note(await app.login({ password: secret }));
  app.cyclos.state.forced.clear();
  for (let i = 0; i < 5; i += 1) await app.login({ password: secret });
  await note(await app.login({ password: secret })); // 429

  await note(await app.login());
  await note(await app.request("/caisse"));

  assert.ok(app.logs.length > 0, "les erreurs de Cyclos doivent être journalisées");
  for (const text of [...seen, ...app.logs]) {
    assert.ok(!text.includes(secret), "mot de passe en clair");
    assert.ok(!text.includes(USER.password), "mot de passe en clair");
    const basic = Buffer.from(`${USER.login}:${USER.password}`).toString("base64");
    assert.ok(!text.includes(basic), "identifiants en Basic");
  }
});

appTest("Cyclos en panne à la connexion : 502, pas de session", CAISSE_OPTIONS, async (app) => {
  app.cyclos.force("POST /auth/session", 500);
  const res = await app.login();
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "Impossible de joindre Cyclos");
  assert.equal(await status(app), 303);
});

// ------------------------------------------------------------ sessions

function mockClock() {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
}

// Intention: a session ends after 20 minutes WITHOUT ACTIVITY (each page viewed extends it), and the token is also closed at Cyclos.
appTest("session : expiration après 20 minutes d'inactivité, jeton Cyclos fermé", CAISSE_OPTIONS, async (app) => {
  mockClock();
  await app.loggedIn();
  mock.timers.tick(19 * MINUTE);
  assert.equal(await status(app), 200); // activity extends the session
  mock.timers.tick(19 * MINUTE);
  assert.equal(await status(app), 200);
  mock.timers.tick(20 * MINUTE + 1);
  const res = await app.request("/caisse");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "DELETE /auth/session");
  assert.equal(await status(app), 303);
});

// Intention: even without ever stopping, a session lasts no more than 8 hours.
appTest("session : durée absolue de 8 heures même avec une activité continue", CAISSE_OPTIONS, async (app) => {
  mockClock();
  await app.loggedIn();
  for (let elapsed = 10; elapsed <= 470; elapsed += 10) {
    mock.timers.tick(10 * MINUTE);
    assert.equal(await status(app), 200, `après ${elapsed} min`);
  }
  mock.timers.tick(15 * MINUTE); // 8 h 05 in total, 15 min since the last activity
  const res = await app.request("/caisse");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "DELETE /auth/session");
});

appTest("session : durées configurables (idleMs, maxMs)", { ...CAISSE_OPTIONS, idleMs: 1000, maxMs: 5000 }, async (app) => {
  mockClock();
  await app.loggedIn();
  mock.timers.tick(900);
  assert.equal(await status(app), 200);
  mock.timers.tick(1001);
  assert.equal(await status(app), 303);
});

appTest("nettoyage périodique : sessions expirées retirées et jeton fermé sans nouvelle requête", CAISSE_OPTIONS, async (app) => {
  mockClock();
  await app.loggedIn();
  app.server.sweep(); // nothing expired: the session stays
  assert.ok(!app.cyclos.state.deleted.includes("jeton-1"));
  mock.timers.tick(21 * MINUTE);
  app.server.sweep();
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "DELETE /auth/session par le nettoyage");
});

appTest("nettoyage périodique : lancé tout seul à l'intervalle configuré", { ...CAISSE_OPTIONS, sweepIntervalMs: 30 }, async (app) => {
  await app.loggedIn();
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 30 * MINUTE });
  await until(() => app.cyclos.state.deleted.includes("jeton-1"), "nettoyage automatique");
});

// Intention: logging out deletes the local session, closes the token at Cyclos and clears the cookie; the old cookie then gives nothing.
appTest("déconnexion : session supprimée, DELETE envoyé à Cyclos, cookie effacé", CAISSE_OPTIONS, async (app) => {
  const csrf = await app.loggedIn();
  const oldCookie = app.cookie;
  const res = await app.request("/deconnexion", { method: "POST", form: { csrf } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.match(res.headers.get("set-cookie"), /^session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/);
  assert.ok(app.cyclos.state.deleted.includes("jeton-1"));
  assert.ok(app.cyclos.calls("DELETE", "/auth/session").some((c) => c.headers["session-token"] === "jeton-1"));
  app.cookie = oldCookie;
  assert.equal(await status(app), 303);
});

appTest("déconnexion : réussit localement même si Cyclos refuse ou ne répond pas", CAISSE_OPTIONS, async (app) => {
  for (const code of [401, 500, "drop"]) {
    const csrf = await app.loggedIn();
    app.cyclos.force("DELETE /auth/session", code);
    const res = await app.request("/deconnexion", { method: "POST", form: { csrf } });
    assert.equal(res.status, 303, String(code));
    assert.equal(await status(app), 303, String(code));
    app.cyclos.state.forced.clear();
  }
});

appTest("déconnexion sans session : redirection vers / et cookie effacé", async (app) => {
  const res = await app.request("/deconnexion", { method: "POST", form: {} });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});

// Intention: if Cyclos refuses the visitor's token (401), the local session is closed and the browser goes back to the login page.
appTest("jeton Cyclos expiré (401 loggedOut) : session locale supprimée et retour à /", CAISSE_OPTIONS, async (app) => {
  assert.equal((await app.login()).status, 303); // no visit yet: the visitor's Cyclos user id is not read yet
  app.cyclos.expireTokens();
  const res = await app.request("/caisse");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(await status(app), 303, "session locale supprimée");
});

// ------------------------------------------------------------ CSRF

// Intention: a POST /deconnexion without the session's CSRF token (missing, empty, wrong, truncated, lengthened) is refused (403),
// the session stays open and Cyclos is not asked to close anything.
appTest("CSRF /deconnexion : refusé sans jeton, avec faux jeton, avec jeton vide ou tronqué ; session conservée", CAISSE_OPTIONS, async (app) => {
  const csrf = await app.loggedIn();
  const fake = "0".repeat(csrf.length);
  const deletes = app.cyclos.calls("DELETE", "/auth/session").length;
  for (const form of [{}, { csrf: "" }, { csrf: fake }, { csrf: csrf.slice(1) }, { csrf: `${csrf}0` }]) {
    const res = await app.request("/deconnexion", { method: "POST", form });
    assert.equal(res.status, 403, JSON.stringify(form.csrf));
    const html = await res.text();
    assert.match(html, /Requête refusée/);
    assert.match(html, /Jeton de sécurité absent ou invalide/);
    assert.ok(!html.includes(fake));
  }
  assert.equal(app.cyclos.calls("DELETE", "/auth/session").length, deletes, "aucune fermeture Cyclos");
  assert.equal(await status(app), 200, "la session reste ouverte");
});

appTest("CSRF : le jeton d'une autre session n'est pas accepté", CAISSE_OPTIONS, async (app) => {
  const csrfA = await app.loggedIn();
  app.cookie = "";
  const csrfB = await app.loggedIn();
  assert.notEqual(csrfA, csrfB);
  assert.equal((await app.request("/deconnexion", { method: "POST", form: { csrf: csrfA } })).status, 403);
  assert.equal((await app.request("/deconnexion", { method: "POST", form: { csrf: csrfB } })).status, 303);
});

appTest("CSRF : jeton passé en paramètre d'URL ou en en-tête ignoré", CAISSE_OPTIONS, async (app) => {
  const csrf = await app.loggedIn();
  const res = await app.request(`/deconnexion?csrf=${csrf}`, { method: "POST", form: {}, headers: { "X-CSRF-Token": csrf } });
  assert.equal(res.status, 403);
});

// Intention: without a session, /caisse sends back to the login (303) and Cyclos is never queried.
appTest("sans session : /caisse redirige vers / (aucun appel à Cyclos)", CAISSE_OPTIONS, async (app) => {
  const res = await app.request("/caisse");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  assert.equal(app.cyclos.state.requests.length, 0);
});

appTest("cookie de session inconnu ou falsifié : traité comme absent", CAISSE_OPTIONS, async (app) => {
  for (const cookie of ["session=abc", "session=", "session=00000000-0000-0000-0000-000000000000", "autre=1", "session"]) {
    app.cookie = cookie;
    assert.equal(await status(app), 303, cookie);
  }
});

// Intention: logout is only possible by POST: with GET, 405 and the session stays open.
appTest("GET /deconnexion : 405 avec Allow: POST, session conservée", CAISSE_OPTIONS, async (app) => {
  await app.loggedIn();
  const deletes = app.cyclos.calls("DELETE", "/auth/session").length;
  const res = await app.request("/deconnexion");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assert.equal(await status(app), 200);
  assert.equal(app.cyclos.calls("DELETE", "/auth/session").length, deletes);
});

// ------------------------------------------------------------ Cyclos 403

// Intention: a 403 right at login shows "Accès refusé" with no session or cookie (nothing to log out of).
appTest("403 de Cyclos à la connexion : « Accès refusé » sans session ni cookie", async (app) => {
  app.cyclos.force("POST /auth/session", 403);
  const res = await app.login();
  assert.equal(res.status, 403);
  const html = await res.text();
  assert.match(html, /Accès refusé/);
  assert.match(html, /<a href="\/">Retour<\/a>/);
  assert.ok(!html.includes('action="/deconnexion"'));
  assert.equal(res.headers.get("set-cookie"), null);
});
