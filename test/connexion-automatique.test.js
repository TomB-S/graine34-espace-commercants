// One-time login link (GET /ouvrir?t=code), used by the single executable on a local address: valid 15 seconds,
// usable once, never in a log, off when the network is opened. Real server, fake Cyclos, fictitious values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appTest, setup } from "../test-support/harness.js";
import { CAISSE_OPTIONS } from "../test-support/options.js";
import { startServer } from "../server.js";
import { launch } from "../launcher.js";
import { createCyclosPush } from "../cyclos-push.js";
import { startFakeCyclos, USER } from "../test-support/fake-cyclos.js";

const OPTIONS = { ...CAISSE_OPTIONS, autoLogin: true };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const open = (app, code, headers = {}) => app.request(`/ouvrir?t=${code}`, { headers });

appTest("lien : un code valide ouvre la session et mène à /caisse, une seule connexion Cyclos", OPTIONS, async (app) => {
  const code = app.server.issueLoginCode();
  assert.match(code, /^[0-9a-f]{32}$/);
  const res = await open(app, code);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/caisse");
  assert.match(res.headers.get("set-cookie"), /^session=/);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 1);
  const page = await app.request("/caisse");
  assert.equal(page.status, 200, "the session works");
  assert.ok((await page.text()).includes("Caisse : paiements reçus"));
});

appTest("lien : un code déjà utilisé renvoie au formulaire, sans session", OPTIONS, async (app) => {
  const code = app.server.issueLoginCode();
  assert.equal((await open(app, code)).headers.get("location"), "/caisse");
  const second = await (async () => {
    app.cookie = ""; // another browser
    return open(app, code);
  })();
  assert.equal(second.status, 303);
  assert.equal(second.headers.get("location"), "/");
  assert.equal(second.headers.get("set-cookie"), null);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 1, "no new Cyclos login for a used code");
  assert.equal((await app.request("/caisse")).headers.get("location"), "/");
});

appTest("lien : un code expiré (15 secondes par défaut, ici 80 ms) renvoie au formulaire", { ...OPTIONS, loginCodeTtlMs: 80 }, async (app) => {
  const code = app.server.issueLoginCode();
  await pause(150);
  const res = await open(app, code);
  assert.equal(res.headers.get("location"), "/");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
});

appTest("lien : le délai par défaut est de 15 secondes", OPTIONS, async (app) => {
  const code = app.server.issueLoginCode();
  await pause(200);
  assert.equal((await open(app, code)).headers.get("location"), "/caisse", "still valid after a short delay");
});

appTest("lien : mauvais code, code absent ou mal formé renvoient au formulaire, un bon code n'est pas brûlé par un mauvais", OPTIONS, async (app) => {
  const code = app.server.issueLoginCode();
  for (const bad of ["", "abc", "0".repeat(32), "x".repeat(32), `${code}0`, code.toUpperCase(), "%00", "a".repeat(5000)]) {
    const res = await open(app, bad);
    assert.equal(res.status, 303, bad.slice(0, 10));
    assert.equal(res.headers.get("location"), "/");
    assert.equal(res.headers.get("set-cookie"), null);
  }
  const noParam = await app.request("/ouvrir");
  assert.equal(noParam.headers.get("location"), "/");
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 0);
  assert.equal((await open(app, code)).headers.get("location"), "/caisse", "the good code still works");
});

appTest("lien : si Cyclos refuse, retour au formulaire sans session, le code n'est pas rejouable", OPTIONS, async (app) => {
  app.cyclos.force("POST /auth/session", 500);
  const code = app.server.issueLoginCode();
  const res = await open(app, code);
  assert.equal(res.headers.get("location"), "/");
  assert.equal(res.headers.get("set-cookie"), null);
  app.cyclos.force("POST /auth/session", 200);
  assert.equal((await open(app, code)).headers.get("location"), "/");
});

appTest("lien : le code n'apparaît dans aucun journal, ni dans la réponse", OPTIONS, async (app) => {
  const used = app.server.issueLoginCode();
  const expired = app.server.issueLoginCode();
  const res = await open(app, used);
  await open(app, used);
  await open(app, "f".repeat(32));
  app.cyclos.force("POST /auth/session", 500);
  await open(app, expired);
  const everything = JSON.stringify([app.logs, Object.fromEntries(res.headers), await res.text()]);
  for (const code of [used, expired]) assert.ok(!everything.includes(code), "code never written");
});

appTest("lien : sans autoLogin, /ouvrir n'existe pas (404) et aucun code ne peut être émis", CAISSE_OPTIONS, async (app) => {
  assert.equal(app.server.issueLoginCode, undefined);
  const res = await open(app, "0".repeat(32));
  assert.equal(res.status, 404);
});

test("lien : refusé au démarrage hors écoute locale ou caisse désactivée (réseau ouvert)", async () => {
  const cyclos = await startFakeCyclos();
  try {
    for (const host of [undefined, "0.0.0.0", "192.168.1.10"]) {
      await assert.rejects(
        startServer({ port: 0, host, cyclosBaseUrl: cyclos.url, autoLogin: true, ...CAISSE_OPTIONS }),
        /connexion automatique exige/,
        String(host),
      );
    }
    await assert.rejects(
      startServer({ port: 0, host: "127.0.0.1", cyclosBaseUrl: cyclos.url, autoLogin: true }),
      /connexion automatique exige/,
      "caisse disabled",
    );
  } finally {
    await cyclos.close();
  }
});

appTest("lien : à l'expiration de la session, retour au formulaire normal", { ...OPTIONS, idleMs: 60, sweepIntervalMs: 20 }, async (app) => {
  const res = await open(app, app.server.issueLoginCode());
  assert.equal(res.headers.get("location"), "/caisse");
  await pause(150);
  const after = await app.request("/caisse");
  assert.equal(after.status, 303);
  assert.equal(after.headers.get("location"), "/", "form again");
  const form = await app.request("/");
  assert.ok((await form.text()).includes('action="/connexion"'));
});

// ---- the launcher: link given to the browser, never printed

function fakeLaunch(env, { openNetwork } = {}) {
  const events = [];
  const output = { text: "", write(chunk) { this.text += chunk; } };
  const deps = {
    env: { CAISSE_CYCLOS_LOGIN: "commerce", CAISSE_CYCLOS_PASSWORD: "Mot2Passe-fictif", ...env },
    input: { isTTY: false },
    output,
    start: async (options) => {
      events.push(["start", options]);
      return { port: options.port, issueLoginCode: options.autoLogin ? () => "c0de".repeat(8) : undefined };
    },
    createPush: () => ({
      async createSession() { return "t"; },
      async getUserId() { return "u"; },
      async closeSession() {},
    }),
    open: async (url) => {
      events.push(["open", url]);
      return false; // the browser fails: the plain address is shown
    },
  };
  return { deps, output, events };
}

test("lanceur : le navigateur reçoit le lien à usage unique, l'écran n'affiche jamais le code", async () => {
  const { deps, output, events } = fakeLaunch({});
  const result = await launch(deps);
  assert.equal(result.code, 0);
  assert.equal(events[0][1].autoLogin, true);
  assert.equal(events[0][1].host, "127.0.0.1");
  const link = events.find((e) => e[0] === "open")[1];
  assert.equal(link, `http://127.0.0.1:3001/ouvrir?t=${"c0de".repeat(8)}`);
  assert.ok(!output.text.includes("c0de"), "the code is not shown, even when the browser fails");
  assert.ok(output.text.includes("Ouvrez vous-même cette adresse : http://127.0.0.1:3001"));
});

test("lanceur : réseau ouvert = connexion automatique désactivée, le navigateur reçoit l'adresse simple", async () => {
  const { deps, events } = fakeLaunch({ CAISSE_OPEN_NETWORK: "true" });
  await launch(deps);
  assert.equal(events[0][1].autoLogin, false);
  assert.equal(events[0][1].host, undefined);
  assert.equal(events.find((e) => e[0] === "open")[1], "http://127.0.0.1:3001");
});

test("lanceur : de bout en bout avec le vrai serveur, le lien ouvre /caisse sans formulaire, puis il est périmé", async () => {
  const cyclos = await startFakeCyclos();
  const output = { text: "", write(chunk) { this.text += chunk; } };
  let link = null;
  const net = await import("node:net");
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: p } = probe.address();
      probe.close(() => resolve(p));
    });
  });
  const result = await launch({
    env: { CYCLOS_BASE_URL: cyclos.url, PORT: String(port), CAISSE_CYCLOS_LOGIN: USER.login, CAISSE_CYCLOS_PASSWORD: USER.password },
    input: { isTTY: false },
    output,
    start: startServer,
    createPush: ({ baseUrl, channel }) => createCyclosPush({ baseUrl, channel }),
    open: async (url) => {
      link = url;
      return true;
    },
  });
  try {
    assert.equal(result.code, 0, output.text);
    assert.match(link, /\/ouvrir\?t=[0-9a-f]{32}$/);
    const first = await fetch(link, { redirect: "manual" });
    assert.equal(first.headers.get("location"), "/caisse");
    const cookie = first.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${result.url}/caisse`, { headers: { Cookie: cookie }, redirect: "manual" })).status, 200);
    assert.equal((await fetch(link, { redirect: "manual" })).headers.get("location"), "/", "already used");
    assert.ok(!output.text.includes(link.split("t=")[1]));
  } finally {
    await result.handle?.close();
    await cyclos.close();
  }
});
