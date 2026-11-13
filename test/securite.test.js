// === WHAT THIS FILE CHECKS ===
// The "background" protections of the server: the security HTTP headers sent on EVERY response (the CSP exactly as in mission 2A),
// caching, the absence of style or script in the HTML, and the size limit of requests (10 kB). Uses the harness
// (test-support/harness.js) and the fake Cyclos. Basic notions (assert, async, HTTP statuses): see test/statique.test.js.
import assert from "node:assert/strict";
import { appTest, rawRequest, EXPECTED_CSP } from "../test-support/harness.js";
import { CAISSE_OPTIONS } from "../test-support/options.js";
import { entry, transfer, paymentNotification } from "../test-support/fake-cyclos.js";

// Triggers ONE example of each kind of server response (pages, redirections, errors 403/404/405/413/503, static files...) and
// returns them all together as [{ label, res, body }]. The tests below go through this list so that NO kind of response escapes a rule.
async function everyResponse(app) {
  const out = [];
  const take = async (label, promise) => {
    const res = await promise;
    out.push({ label, res, body: Buffer.from(await res.arrayBuffer()) });
    return res;
  };
  app.cyclos.state.push.lifetimeMs = null;
  app.cyclos.state.entries = [entry(2, { amount: "2.00" }), entry(1)];
  app.cyclos.state.transfers.set("tr-1", transfer(1));
  app.cyclos.addUser("autre", "mdp-autre-de-test", { id: "user-2" });

  await take("GET / (connexion)", app.request("/"));
  await take("POST /connexion refusé (Origin)", app.request("/connexion", { method: "POST", form: { login: "a", password: "b" } }));
  await take("POST /connexion 401", app.login({ password: "faux" }));
  await take("GET /caisse sans session 303", app.request("/caisse"));
  await take("POST /connexion 303", app.login());
  const csrf = await app.csrf();
  await take("GET /caisse 200", app.request("/caisse"));
  app.cyclos.push("newNotification", paymentNotification(1));
  await take("POST /caisse 405", app.request("/caisse", { method: "POST", form: { csrf } }));
  await take("GET /deconnexion 405", app.request("/deconnexion"));
  await take("GET /page-inconnue 404", app.request("/page-inconnue"));
  await take("GET /releve 404 (pas de relevé ici)", app.request("/releve"));
  await take("POST /deconnexion 403 (CSRF)", app.request("/deconnexion", { method: "POST", form: {} }));
  await take("POST /deconnexion 413", app.request("/deconnexion", { method: "POST", body: "x".repeat(10_001), headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
  for (const path of ["/style.css", "/logo.png", "/fonts/roboto-latin-400-normal.woff2", "/fonts/roboto-latin-700-normal.woff2", "/fonts/voltaire-latin-400-normal.woff2"]) {
    await take(`GET ${path}`, app.request(path));
  }
  const etag = out.find((r) => r.label === "GET /style.css").res.headers.get("etag");
  await take("GET /style.css 304", app.request("/style.css", { headers: { "If-None-Match": etag } }));
  await take("GET /fonts/inconnue.woff2 404", app.request("/fonts/inconnue.woff2"));
  await take("POST /deconnexion 303", app.request("/deconnexion", { method: "POST", form: { csrf } }));
  await take("POST /deconnexion sans session 303", app.request("/deconnexion", { method: "POST", form: {} }));
  // A user who is not the registered merchant: 403 page.
  await take("POST /connexion autre utilisateur", app.login({ login: "autre", password: "mdp-autre-de-test" }));
  await take("GET /caisse 403 (non inscrit)", app.request("/caisse"));
  return out;
}

// Intention: every response carries the security headers, with the CSP written out in full. If one were missing, a browser protection
// would be switched off.
appTest("en-têtes de sécurité sur chaque type de réponse, CSP exacte", CAISSE_OPTIONS, async (app) => {
  const responses = await everyResponse(app);
  assert.ok(responses.length >= 20, `${responses.length} réponses`);
  assert.ok(responses.some(({ label, res }) => label === "GET /caisse 200" && res.status === 200));
  assert.ok(responses.some(({ label, res }) => label === "GET /caisse 403 (non inscrit)" && res.status === 403));
  for (const { label, res } of responses) {
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, label);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", label);
    assert.equal(res.headers.get("x-frame-options"), "DENY", label);
    assert.equal(res.headers.get("referrer-policy"), label === "GET / (connexion)" ? "same-origin" : "no-referrer", label);
    assert.equal(res.headers.get("strict-transport-security"), null, `${label} : pas de HSTS sans COOKIE_SECURE`);
  }
  assert.ok(!/unsafe-|https?:|script-src/.test(EXPECTED_CSP));
});

// Intention: pages must be kept neither in cache nor by the back button: `no-store`. Only static files are cached for 1 hour.
appTest("Cache-Control : no-store partout sauf fichiers statiques (public, 1 h)", CAISSE_OPTIONS, async (app) => {
  for (const { label, res } of await everyResponse(app)) {
    const expected = /^GET \/(style\.css|logo\.png|fonts\/\S+\.woff2)( 304)?$/.test(label) && !label.includes("inconnue")
      ? "public, max-age=3600"
      : "no-store";
    assert.equal(res.headers.get("cache-control"), expected, label);
  }
});

// Intention: with COOKIE_SECURE, HSTS everywhere and the `Secure` attribute on the session cookie, including when it is cleared.
appTest("COOKIE_SECURE actif : HSTS sur chaque réponse, Secure sur le cookie posé et sur le cookie effacé", { ...CAISSE_OPTIONS, cookieSecure: true }, async (app) => {
  const responses = await everyResponse(app);
  for (const { label, res } of responses) {
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000", label);
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, label);
  }
  const cookies = responses.map((r) => r.res.headers.get("set-cookie")).filter(Boolean);
  assert.ok(cookies.length >= 2);
  for (const cookie of cookies) {
    assert.match(cookie, /^session=[^;]*; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Secure$/);
  }
  assert.ok(cookies.some((c) => /Max-Age=28800/.test(c)), "cookie de connexion");
  assert.ok(cookies.some((c) => /session=; .*Max-Age=0/.test(c)), "cookie effacé");
});

appTest("COOKIE_SECURE inactif : cookie sans Secure", async (app) => {
  const res = await app.login();
  assert.ok(!/Secure/i.test(res.headers.get("set-cookie")));
});

// Intention: no page has inline style or script, event attributes, or an external resource: this is what allows the strict CSP.
appTest("aucune réponse HTML ne contient style=, <style ni <script", CAISSE_OPTIONS, async (app) => {
  const htmlResponses = (await everyResponse(app)).filter(({ res }) => /^text\/html/.test(res.headers.get("content-type") ?? ""));
  assert.ok(htmlResponses.length >= 5, `${htmlResponses.length} pages HTML`);
  for (const { label, body } of htmlResponses) {
    const html = body.toString("utf-8");
    assert.ok(!/\sstyle\s*=/i.test(html), `${label} : style=`);
    assert.ok(!/<style/i.test(html), `${label} : <style`);
    assert.ok(!/<script/i.test(html), `${label} : <script`);
    assert.ok(!/<meta[^>]+refresh/i.test(html), `${label} : <meta refresh>`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${label} : gestionnaire d'événement`);
    assert.ok(!/(src|href|action)="https?:/i.test(html), `${label} : ressource externe`);
  }
});

// Intention: every response announces its type, and text is declared as UTF-8.
appTest("pas de page sans type de contenu précis (texte et HTML en UTF-8)", CAISSE_OPTIONS, async (app) => {
  for (const { label, res } of await everyResponse(app)) {
    const type = res.headers.get("content-type");
    if (res.status === 303 || res.status === 304) continue;
    assert.ok(type, label);
    if (/^text\//.test(type)) assert.match(type, /charset=utf-8$/, label);
  }
});

// ------------------------------------------------------------ body size

// Intention: a body above 10 kB is refused (413) on every POST route and nothing is passed on to Cyclos.
appTest("corps de plus de 10 ko : 413 sur chaque route qui lit un corps, rien n'est envoyé à Cyclos", async (app) => {
  const csrf = await app.loggedIn();
  const calls = app.cyclos.state.requests.length;
  const res = await app.request("/deconnexion", { method: "POST", body: `csrf=${csrf}&p=${"x".repeat(10_001)}`, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(res.status, 413);
  assert.equal(await res.text(), "Requête trop volumineuse");
  assert.equal(res.headers.get("connection"), "close");
  const login = await app.request("/connexion", {
    method: "POST",
    body: `login=a&password=${"x".repeat(10_001)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: app.base },
  });
  assert.equal(login.status, 413);
  assert.equal(app.cyclos.state.requests.length, calls, "aucun appel à Cyclos");
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 1, "seule la connexion initiale");
});

// Edge case: 10,000 bytes are accepted (refused for another reason), 10,001 are refused (413).
appTest("corps de 10 000 octets exactement accepté (refusé pour une autre raison que la taille)", CAISSE_OPTIONS, async (app) => {
  const csrf = await app.loggedIn();
  const padding = "x".repeat(10_000 - `csrf=${csrf}&p=`.length);
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const res = await app.request("/deconnexion", { method: "POST", body: `csrf=wrong&p=${padding}`.slice(0, 10_000), headers });
  assert.equal(res.status, 403); // read in full, then refused because of the token
  const over = await app.request("/deconnexion", { method: "POST", body: `csrf=${csrf}&p=${padding}x`, headers });
  assert.equal(over.status, 413);
});

// Intention: a body sent "in chunks" with no announced size is also limited, counting as it goes.
appTest("corps en morceaux (chunked) sans Content-Length qui dépasse 10 ko : 413", CAISSE_OPTIONS, async (app) => {
  const csrf = await app.loggedIn();
  const headers = { Cookie: app.cookie, "Content-Type": "application/x-www-form-urlencoded", "Transfer-Encoding": "chunked" };
  const res = await rawRequest(app.base, {
    method: "POST",
    path: "/deconnexion",
    headers,
    chunks: [`csrf=${csrf}&a=`, "x".repeat(6000), "y".repeat(6000)],
  });
  assert.equal(res.status, 413);
  assert.equal(res.body.toString(), "Requête trop volumineuse");
  assert.equal(res.headers.connection, "close");
  // A chunked body under the limit is read normally (and logs out: the token is valid).
  const small = await rawRequest(app.base, { method: "POST", path: "/deconnexion", headers, chunks: [`csrf=${csrf}`, "&a=1"] });
  assert.equal(small.status, 303);
});

appTest("corps chunked sur /connexion au-delà de la limite : 413", async (app) => {
  const res = await rawRequest(app.base, {
    method: "POST",
    path: "/connexion",
    headers: { Origin: app.base, "Content-Type": "application/x-www-form-urlencoded", "Transfer-Encoding": "chunked" },
    chunks: ["login=a&password=", "z".repeat(5000), "z".repeat(5000), "z".repeat(5000)],
  });
  assert.equal(res.status, 413);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
});

appTest("le serveur reste utilisable après des 413", async (app) => {
  for (let i = 0; i < 3; i += 1) {
    await rawRequest(app.base, {
      method: "POST",
      path: "/connexion",
      headers: { Origin: app.base, "Transfer-Encoding": "chunked" },
      chunks: ["x".repeat(6000), "x".repeat(6000)],
    });
  }
  assert.equal((await app.login()).status, 303);
});
