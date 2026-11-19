// === WHAT THIS FILE CHECKS ===
// The multi-merchant mode end to end: the real server (CAISSE_MULTI_MERCHANT) against a fake Cyclos where every merchant has his own
// payments. Login with the merchant's OWN Cyclos account (two tokens: one for the page, one for the listening), the whitelist at the
// door (403 for an account that is not listed), the brakes on the logins, the logout and the end of a session closing both tokens,
// the listening stopped when no session of the merchant is left, and above all ISOLATION: the cookie of one merchant never gives the
// data of another. The password is used for the two token requests only: it is never in a log, an answer or a session record.
// All names, secrets and amounts are fictitious.
import "./support/env-propre.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { appTest, until } from "./support/harness.js";
import { isolerEnv } from "./support/env-propre.js";
import { CAISSE_OPTIONS } from "./support/options.js";
import { entry, startFakeCyclos, USER } from "./support/fake-cyclos.js";
import { startServer } from "../src/server.js";

const WHO = {
  marie: { id: "u-marie", login: "marie", password: "mdp-marie-fictif", email: "Marie@Exemple.test", amount: "12.00", client: "Cliente Marie" },
  paul: { id: "u-paul", login: "paul", password: "mdp-paul-fictif", email: "paul@exemple.test", amount: "34.00", client: "Client Paul" },
  zoe: { id: "u-zoe", login: "zoe", password: "mdp-zoe-fictif", email: "zoe@exemple.test", amount: "56.00", client: "Cliente Zoe" },
};
const PASSWORDS = Object.values(WHO).map((w) => w.password);

const multi = (allowed = { ids: ["u-marie", "u-paul"], emails: [] }, more = {}) => ({
  caisseHooks: CAISSE_OPTIONS.caisseHooks,
  caisse: { enabled: true, multiMerchant: true, allowedUsers: allowed, ...more },
});

// The three merchants exist at Cyclos, each with one payment of his own. Returns nothing.
function seed(app, { emailOf = true } = {}) {
  for (const w of Object.values(WHO)) {
    app.cyclos.addUser(w.login, w.password, {
      id: w.id,
      display: w.client,
      ...(emailOf ? { email: w.email } : {}),
      entries: [entry(Number(w.amount), { amount: w.amount, description: `Achat de ${w.login}`, who: w.client })],
    });
  }
  app.cyclos.state.push.lifetimeMs = null;
}

// One browser per merchant: its own cookie. `as(name)` switches the jar of the harness to that merchant's.
function browsers(app) {
  const jars = {};
  return {
    async login(name, password = WHO[name].password) {
      app.cookie = "";
      const res = await app.login({ login: WHO[name].login, password });
      jars[name] = app.cookie;
      return res;
    },
    as(name) {
      app.cookie = jars[name] ?? "";
      return app;
    },
    jar: (name) => jars[name],
  };
}

const dataOf = async (app) => (await app.request("/caisse/data")).json();
const amountsOf = (data) => data.tickets.map((t) => t.amount ?? t.amountText ?? JSON.stringify(t));
const liveData = async (app) => {
  for (let i = 0; i < 100; i += 1) {
    const data = await dataOf(app);
    if (data.status === "live") return data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pas en direct");
};
const sessionLogins = (app) => app.cyclos.calls("POST", "/auth/session");
const everything = (app) => app.logs.join("\n");

// === Login ===

// Intention: the merchant logs in with HIS account: two Cyclos tokens (page and listening), a session, his own payments.
appTest("multi : connexion d'un commerçant, deux jetons Cyclos, ses propres paiements", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  const res = await b.login("marie");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/caisse");
  assert.equal(sessionLogins(app).length, 2, "page token + listening token");
  const data = await liveData(app);
  assert.match(JSON.stringify(data), /12,00/);
  assert.doesNotMatch(JSON.stringify(data), /34,00|56,00/);
  const page = await (await app.request("/caisse")).text();
  assert.match(page, /Cliente Marie/);
  assert.equal(sessionLogins(app).length, 2, "no further login to listen or to read");
  assert.equal(app.cyclos.openStreams(), 1);
});

// Intention: the server does not need any listening account in this mode.
test("multi : aucun compte d'écoute exigé, et le canal reste main au démarrage", async () => {
  const handle = await startServer({ port: 0, host: "127.0.0.1", cyclosBaseUrl: "http://127.0.0.1:1/api", cyclosChannel: "main", caisse: { enabled: true, multiMerchant: true } });
  assert.equal(handle.caisseEnabled, true);
  await handle.close();
});

// Intention: the whitelist by e-mail address works (without case), and the key stays the merchant's own number.
appTest("multi : liste blanche par adresse e-mail, sans tenir compte des majuscules", multi({ ids: [], emails: ["marie@exemple.test"] }), async (app) => {
  seed(app);
  const b = browsers(app);
  assert.equal((await b.login("marie")).status, 303);
  assert.match(JSON.stringify(await liveData(app)), /12,00/);
  assert.equal((await b.login("paul")).status, 403, "Paul's address is not listed");
});

// === The door ===

// Intention: an account that is not on the list gets a clear 403: no session, no cookie, no listening token, no listening, the page
// token closed at once, and the log shows the internal number (not the e-mail address) to help the administrator.
appTest("multi : compte hors liste blanche, refus clair 403, rien d'ouvert", multi({ ids: ["u-marie"], emails: [] }), async (app) => {
  seed(app);
  const b = browsers(app);
  const res = await b.login("zoe");
  assert.equal(res.status, 403);
  const html = await res.text();
  assert.match(html, /Ce compte n'est pas autorisé à ouvrir la caisse/);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(sessionLogins(app).length, 1, "only the page token, never a listening token");
  await until(() => app.cyclos.state.deleted.length === 1, "page token closed");
  assert.equal(app.cyclos.calls("GET", "/push/subscribe").length, 0);
  assert.equal(app.server.inspectSessions().length, 0);
  assert.ok(app.logs.some((l) => l.endsWith("compte refusé (absent de CAISSE_ALLOWED_USERS), numéro interne Cyclos : u-zoe")));
  assert.ok(!everything(app).includes("zoe@exemple.test"));
  assert.ok(!html.includes(WHO.zoe.password));
  assert.equal((await app.request("/caisse")).status, 303, "no session: back to the form");
});

// Intention: an empty list refuses everybody.
appTest("multi : liste vide, personne n'entre", multi({ ids: [], emails: [] }), async (app) => {
  seed(app);
  const b = browsers(app);
  for (const name of ["marie", "paul", "zoe"]) assert.equal((await b.login(name)).status, 403, name);
  assert.equal(app.server.inspectSessions().length, 0);
});

// Intention: a refused account is not an invitation to try again in a loop: nothing retries by itself, and repeated attempts of the
// same account are counted by the brakes (5 per identifier) until it is turned away without reaching Cyclos.
appTest("multi : compte refusé qui insiste, freiné sans atteindre Cyclos", multi({ ids: ["u-marie"], emails: [] }), async (app) => {
  seed(app);
  const b = browsers(app);
  for (let i = 0; i < 5; i += 1) assert.equal((await b.login("zoe")).status, 403);
  const before = sessionLogins(app).length;
  assert.equal((await b.login("zoe")).status, 429);
  assert.equal(sessionLogins(app).length, before, "the sixth does not reach Cyclos");
  assert.equal((await b.login("marie")).status, 303, "another merchant is not affected");
});

// === Brakes on the logins ===

appTest("multi : mot de passe refusé, message simple, 5 refus bloquent l'identifiant sans atteindre Cyclos", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  for (let i = 0; i < 5; i += 1) {
    const res = await b.login("marie", "mauvais");
    assert.equal(res.status, 401);
    assert.match(await res.text(), /Identifiant ou mot de passe incorrect/);
  }
  assert.equal(sessionLogins(app).length, 5);
  const blocked = await b.login("marie");
  assert.equal(blocked.status, 429, "even with the right password");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(sessionLogins(app).length, 5, "no call to Cyclos");
  assert.equal((await b.login("paul")).status, 303, "Paul is not affected");
});

// Intention: when Cyclos itself fails, the breaker cuts the logins for a minute: nobody reaches Cyclos meanwhile.
appTest("multi : pannes de Cyclos, disjoncteur, plus aucun appel à Cyclos", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  app.cyclos.force("POST /auth/session", 500);
  const names = ["marie", "paul", "zoe", "marie", "paul"];
  for (const name of names) assert.equal((await b.login(name)).status, 502, name);
  const calls = sessionLogins(app).length;
  const stopped = await b.login("zoe");
  assert.equal(stopped.status, 503);
  assert.ok(Number(stopped.headers.get("retry-after")) > 0);
  assert.equal(sessionLogins(app).length, calls, "turned away without calling Cyclos");
});

// Intention: a 403 from Cyclos at login (account not allowed on this channel) is shown as such, without opening anything.
appTest("multi : 403 de Cyclos à la connexion, refus clair, rien d'ouvert", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  app.cyclos.force("POST /auth/session", 403);
  const res = await b.login("marie");
  assert.equal(res.status, 403);
  assert.equal(app.server.inspectSessions().length, 0);
  assert.equal(sessionLogins(app).length, 1, "one try, no loop");
});

// === Isolation ===

// Intention: two merchants logged in at once; each cookie gives ONLY the data of its owner, in the page and in the JSON.
appTest("multi : le cookie de Marie ne donne jamais les données de Paul (et inversement)", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  await b.login("marie");
  await b.login("paul");
  b.as("marie");
  const marie = JSON.stringify(await liveData(app));
  const mariePage = await (await app.request("/caisse")).text();
  b.as("paul");
  const paul = JSON.stringify(await liveData(app));
  const paulPage = await (await app.request("/caisse")).text();
  for (const secret of ["34,00", "Client Paul", "T00034", "Achat de paul"]) {
    assert.ok(!marie.includes(secret) && !mariePage.includes(secret), `Marie sees ${secret}`);
  }
  for (const secret of ["12,00", "Cliente Marie", "T00012", "Achat de marie"]) {
    assert.ok(!paul.includes(secret) && !paulPage.includes(secret), `Paul sees ${secret}`);
  }
  assert.match(marie, /12,00/);
  assert.match(paul, /34,00/);
});

// Intention: nothing the visitor sends can choose another merchant: query, headers, extra path, forged or mixed cookies.
appTest("multi : aucun paramètre, en-tête, chemin ou cookie forgé ne donne les données d'un autre", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  await b.login("marie");
  await b.login("paul");
  b.as("marie");
  await liveData(app);
  const attempts = [
    ["/caisse/data?merchant=u-paul&id=u-paul&marchand=u-paul", {}],
    ["/caisse/data", { "X-Merchant": "u-paul", "X-User-Id": "u-paul", "X-Forwarded-User": "u-paul" }],
    ["/caisse/data/u-paul", {}],
    ["/caisse/u-paul", {}],
  ];
  for (const [path, headers] of attempts) {
    const res = await app.request(path, { headers });
    const text = await res.text();
    assert.doesNotMatch(text, /34,00|Client Paul|T00034/, path);
  }
  // A cookie that is not exactly a session of ours, or a mix of two cookies: no session, never another merchant's.
  const marieCookie = b.jar("marie");
  const paulCookie = b.jar("paul");
  for (const forged of [`${marieCookie}x`, `${marieCookie}; ${paulCookie}`.replace("; session=", "; other="), "session=u-paul", "session=", `${paulCookie.slice(0, -1)}${paulCookie.endsWith("0") ? "1" : "0"}`]) {
    app.cookie = forged;
    const res = await app.request("/caisse/data");
    const text = await res.text();
    assert.doesNotMatch(text, /34,00|Client Paul/, forged);
    assert.ok([200, 401].includes(res.status), forged);
  }
});

// Intention: after a merchant logs out, his old cookie opens nothing, and the other merchant is untouched.
appTest("multi : déconnexion de Marie, son ancien cookie ne donne rien, Paul continue", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  await b.login("marie");
  await b.login("paul");
  b.as("marie");
  await liveData(app);
  const csrf = await app.csrf();
  const out = await app.request("/deconnexion", { method: "POST", form: { csrf }, headers: { Origin: app.base } });
  assert.equal(out.status, 303);
  const old = b.jar("marie");
  app.cookie = old;
  assert.equal((await app.request("/caisse/data")).status, 401);
  b.as("paul");
  assert.match(JSON.stringify(await liveData(app)), /34,00/);
  assert.equal(app.cyclos.openStreams(), 1, "only Paul's stream is left");
});

// === Logout, end of session, several tablets ===

// Intention: logout closes BOTH tokens (page and listening) and stops the listening when no session of the merchant is left.
appTest("multi : la déconnexion ferme les deux jetons et arrête l'écoute", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  await b.login("marie");
  await liveData(app);
  const tokens = [...app.cyclos.state.tokens];
  assert.equal(tokens.length, 2);
  const csrf = await app.csrf();
  const out = await app.request("/deconnexion", { method: "POST", form: { csrf }, headers: { Origin: app.base } });
  assert.equal(out.status, 303);
  assert.equal(app.cyclos.state.deleted.length, 2);
  assert.deepEqual([...app.cyclos.state.deleted].sort(), [...tokens].sort());
  assert.equal(app.cyclos.openStreams(), 0);
  assert.equal(app.server.inspectSessions().length, 0);
});

// Intention: two tablets of one merchant share one listener; the logout of one closes ITS tokens only, and the listening goes on for
// the other with the other's token; when the last one leaves, the listening stops.
appTest("multi : deux sessions d'un même commerçant, la déconnexion de l'une ne coupe pas l'autre", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  await b.login("marie");
  const first = b.jar("marie");
  await b.login("marie"); // second tablet, same merchant
  const second = b.jar("marie");
  assert.notEqual(first, second);
  assert.equal(sessionLogins(app).length, 4, "two tokens per login");
  await liveData(app);
  assert.equal(app.cyclos.openStreams(), 1, "one listener for the merchant");

  // The first tablet logs out.
  app.cookie = first;
  const csrf = await app.csrf();
  await app.request("/deconnexion", { method: "POST", form: { csrf }, headers: { Origin: app.base } });
  assert.equal(app.cyclos.state.deleted.length, 2, "its two tokens only");
  assert.equal(app.cyclos.state.tokens.size, 2, "the second tablet's two tokens are alive");

  // The second keeps working: the listening restarts with ITS token.
  app.cookie = second;
  const data = await liveData(app);
  assert.match(JSON.stringify(data), /12,00/);
  assert.equal(app.cyclos.openStreams(), 1);
  assert.equal(sessionLogins(app).length, 4, "no new login");

  // The last one leaves: nothing is left.
  const csrf2 = await app.csrf();
  await app.request("/deconnexion", { method: "POST", form: { csrf: csrf2 }, headers: { Origin: app.base } });
  assert.equal(app.cyclos.state.tokens.size, 0);
  assert.equal(app.cyclos.openStreams(), 0);
});

// Intention: the end of a session by inactivity does the same as a logout: both tokens closed, listening stopped.
appTest("multi : session expirée par inactivité, deux jetons fermés, écoute arrêtée", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  await b.login("marie");
  await liveData(app);
  app.server.sweep(Date.now() + 21 * 60_000);
  await until(() => app.cyclos.state.deleted.length === 2, "both tokens closed");
  assert.equal(app.server.inspectSessions().length, 0);
  await until(() => app.cyclos.openStreams() === 0, "stream cut");
});

// === Fallback when the listening token is refused ===

// Intention: Cyclos refuses the listening token (it expired): the page says "reauth", nothing loops, nothing is retried, and a new
// login of the merchant starts a fresh listening.
appTest("multi : jeton d'écoute refusé, état reconnexion nécessaire, pas de boucle, nouvelle connexion relance", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  await b.login("marie");
  await liveData(app);
  const listenerToken = app.server.inspectSessions()[0].listenerToken;
  app.cyclos.state.tokens.delete(listenerToken);
  app.cyclos.endStreams();
  for (let i = 0; i < 100 && (await dataOf(app)).status !== "reauth"; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await dataOf(app)).status, "reauth");
  const calls = app.cyclos.state.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (let i = 0; i < 5; i += 1) await dataOf(app);
  assert.equal(app.cyclos.state.requests.length, calls, "no call to Cyclos: nothing retried");
  assert.equal(sessionLogins(app).length, 2, "no new login by itself");
  assert.equal(app.server.inspectSessions()[0].listenerToken, null);

  // The merchant logs in again: fresh tokens, fresh listening.
  assert.equal((await b.login("marie")).status, 303);
  assert.equal((await liveData(app)).status, "live");
});

// === The password ===

// Intention: the password serves the two token requests and nothing else: not in a log, an answer, a session record, and no Cyclos
// call but those two carries a Basic header.
appTest("multi : le mot de passe n'est ni conservé, ni journalisé, ni renvoyé", multi({ ids: ["u-marie"], emails: [] }), async (app) => {
  seed(app);
  const b = browsers(app);
  const bodies = [];
  const grab = async (res) => {
    bodies.push(`${[...res.headers].join("\n")}\n${await res.text()}`);
    return res;
  };
  await grab(await b.login("marie", "mauvais-mdp-fictif"));
  await grab(await b.login("zoe")); // refused by the whitelist
  await grab(await b.login("marie"));
  await liveData(app);
  bodies.push(JSON.stringify(await dataOf(app)), await (await app.request("/caisse")).text());
  const csrf = await app.csrf();
  await grab(await app.request("/deconnexion", { method: "POST", form: { csrf }, headers: { Origin: app.base } }));

  const secrets = [...PASSWORDS, "mauvais-mdp-fictif"];
  const text = `${everything(app)}\n${bodies.join("\n")}\n${JSON.stringify(app.server.inspectSessions())}`;
  for (const secret of secrets) assert.ok(!text.includes(secret), `leak: ${secret}`);
  const basic = app.cyclos.state.requests.filter((r) => r.headers.authorization);
  assert.ok(basic.every((r) => r.path === "/auth/session" && r.method === "POST"), "Basic only on the token requests");
  // Session record while open: tokens and key only.
  await b.login("marie");
  const [record] = app.server.inspectSessions();
  assert.deepEqual(Object.keys(record).sort(), ["createdAt", "csrfToken", "cyclosUserId", "lastSeenAt", "listenerToken", "merchantKey", "sessionToken"]);
});

// === Single-merchant mode untouched ===

// Intention: without the flag, nothing changes: the listening account of the environment, one shared listener, the Basic login once.
appTest("mono : sans le drapeau, comportement inchangé (un compte d'écoute, une connexion)", CAISSE_OPTIONS, async (app) => {
  assert.equal((await app.login()).status, 303);
  assert.equal(sessionLogins(app).length, 1);
  assert.deepEqual(Object.keys(app.server.inspectSessions()[0]).sort(), ["createdAt", "csrfToken", "lastSeenAt", "sessionToken"]);
  assert.equal(app.logs.some((l) => l.startsWith("adresse lue")), false);
});

// Intention: the executable stays single-merchant even if CAISSE_MULTI_MERCHANT=true is in the environment: the page login starts the
// listening as before, the start says so, and the sessions hold no multi-merchant field.
test("exécutable : le drapeau multi est ignoré, le mode mono reste celui d'aujourd'hui", async () => {
  const restore = isolerEnv();
  const logs = [];
  mock.method(console, "log", (...args) => logs.push(args.map(String).join(" ")));
  mock.method(console, "error", () => {});
  const cyclos = await startFakeCyclos();
  process.env.CAISSE_MULTI_MERCHANT = "true";
  process.env.CAISSE_ALLOWED_USERS = "u-marie";
  const server = await startServer({ port: 0, host: "127.0.0.1", cyclosBaseUrl: cyclos.url, listenOnLogin: true, caisseHooks: CAISSE_OPTIONS.caisseHooks });
  try {
    assert.ok(logs.includes("Mode multi-commerçants ignoré : l'exécutable reste mono-commerçant"));
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/connexion`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login: USER.login, password: USER.password }).toString(),
    });
    assert.equal(res.status, 303);
    assert.equal(cyclos.calls("POST", "/auth/session").length, 1, "the form login, as before");
    const [record] = server.inspectSessions();
    assert.equal("merchantKey" in record, false);
    assert.equal("listenerToken" in record, false);
    assert.equal(logs.some((l) => l.startsWith("adresse lue")), false);
  } finally {
    await server.close();
    await cyclos.close();
    mock.restoreAll();
    restore();
  }
});

// Intention: the page of a merchant whose listening token expired says "Session expirée, reconnectez-vous", offers the link to the login
// page, and does not reload itself (no <meta refresh>, no "automatic update" line); a plain page load makes no call to Cyclos.
appTest("multi : page « Session expirée, reconnectez-vous », sans rafraîchissement automatique", multi(), async (app) => {
  seed(app);
  const b = browsers(app);
  await b.login("marie");
  await liveData(app);
  const token = app.server.inspectSessions()[0].listenerToken;
  app.cyclos.state.tokens.delete(token);
  app.cyclos.endStreams();
  for (let i = 0; i < 100 && (await dataOf(app)).status !== "reauth"; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const calls = app.cyclos.state.requests.length;
  const html = await (await app.request("/caisse")).text();
  assert.match(html, /Session expirée, reconnectez-vous/);
  assert.match(html, /<a class="caisse-reconnexion" href="\/">Se reconnecter<\/a>/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
  assert.doesNotMatch(html, /Mise à jour automatique/);
  const data = await dataOf(app);
  assert.deepEqual(data.banner, { level: "error", text: "Session expirée, reconnectez-vous", link: { text: "Se reconnecter", href: "/" } });
  assert.equal(app.cyclos.state.requests.length, calls, "reading the page does not call Cyclos");
});

// === 19-digit numbers ===

const BIG_A = "7636759574759746134";
const BIG_B = "7636759574759746135"; // differs from A by the last digit only: equal to A once converted to a number

function seedBig(app) {
  app.cyclos.state.push.lifetimeMs = null;
  app.cyclos.addUser("alice", "mdp-alice-fictif", { id: BIG_A, display: "Alice", entries: [entry(11, { amount: "11.00", description: "Achat d'alice" })] });
  app.cyclos.addUser("bob", "mdp-bob-fictif", { id: BIG_B, display: "Bob", entries: [entry(22, { amount: "22.00", description: "Achat de bob" })] });
}
const loginBig = (app, name) => {
  app.cookie = "";
  return app.login({ login: name, password: `mdp-${name}-fictif` });
};

// Intention: with only A on the list, B (the number next door) is refused: the numbers are compared as text, not as numbers.
appTest("multi : numéros de 19 chiffres, le voisin n'est pas autorisé à la place de l'autre", multi({ ids: [BIG_A], emails: [] }), async (app) => {
  assert.equal(Number(BIG_A) === Number(BIG_B), true, "the test is meaningful");
  seedBig(app);
  assert.equal((await loginBig(app, "alice")).status, 303);
  assert.equal((await loginBig(app, "bob")).status, 403);
  assert.ok(app.logs.some((l) => l.endsWith(`numéro interne Cyclos : ${BIG_B}`)), "the log shows the exact number, unchanged");
});

// Intention: both on the list: two listeners, two sessions, each sees only his own payments, and each session holds his exact number.
appTest("multi : numéros de 19 chiffres voisins, deux écouteurs et deux sessions séparés", multi({ ids: [BIG_A, BIG_B], emails: [] }), async (app) => {
  seedBig(app);
  await loginBig(app, "alice");
  const alice = app.cookie;
  await loginBig(app, "bob");
  const bob = app.cookie;
  app.cookie = alice;
  const a = JSON.stringify(await liveData(app));
  app.cookie = bob;
  const b = JSON.stringify(await liveData(app));
  assert.match(a, /11,00/);
  assert.doesNotMatch(a, /22,00|Achat de bob/);
  assert.match(b, /22,00/);
  assert.doesNotMatch(b, /11,00|Achat d'alice/);
  assert.equal(app.cyclos.openStreams(), 2, "two listeners");
  assert.deepEqual(app.server.inspectSessions().map((s) => s.merchantKey).sort(), [BIG_A, BIG_B]);
  assert.deepEqual(app.server.inspectSessions().map((s) => s.cyclosUserId).sort(), [BIG_A, BIG_B]);
});
