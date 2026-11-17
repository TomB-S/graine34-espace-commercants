// Start-up of the executable with the login typed on the page (launchWithPageLogin in launcher.js): nothing is asked in the
// window, the server starts on the local address with the option reserved to this entry point, the page opens at the
// plain address, CAISSE_OPEN_NETWORK is refused. No real terminal, browser or Cyclos. FICTITIOUS values only.
import "../test-support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startServer } from "../server.js";
import { startFakeCyclos, USER } from "../test-support/fake-cyclos.js";
import { rawRequest } from "../test-support/harness.js";
import { launchWithPageLogin, SESSION_MAX_MS, MESSAGES } from "../launcher.js";

const fakeOutput = () => ({ text: "", write(chunk) { this.text += chunk; } });

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("lanceur (page) : démarre sur l'adresse locale avec l'option réservée, sans rien demander, et ouvre l'adresse simple", async () => {
  const output = fakeOutput();
  const started = [];
  const opened = [];
  const result = await launchWithPageLogin({
    env: { CAISSE_CYCLOS_LOGIN: "depuis-env", CAISSE_CYCLOS_PASSWORD: "depuis-env-fictif" },
    output,
    start: async (options) => {
      started.push(options);
      return { port: options.port, close: async () => {} };
    },
    open: async (url) => {
      opened.push(url);
      return true;
    },
  });
  assert.equal(result.code, 0);
  assert.equal(started.length, 1);
  const [options] = started;
  assert.equal(options.listenOnLogin, true);
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.maxMs, 12 * 3_600_000);
  assert.equal(SESSION_MAX_MS, 12 * 3_600_000);
  assert.equal(options.port, 3001);
  assert.equal(options.autoLogin, undefined, "no one-time link");
  assert.equal(options.caisse, undefined, "no credentials go to the server by the start-up");
  assert.ok(!JSON.stringify(options).includes("depuis-env"), "the environment credentials are never passed on");
  assert.deepEqual(opened, ["http://127.0.0.1:3001"], "plain address, no code");
  assert.match(output.text, /La caisse est prête : http:\/\/127\.0\.0\.1:3001/);
  assert.match(output.text, /Rien n'est demandé dans cette fenêtre/);
  assert.ok(!output.text.includes("depuis-env"));
});

test("lanceur (page) : CAISSE_OPEN_NETWORK est refusé, le serveur n'est pas démarré", async () => {
  for (const value of ["true", "false"].slice(0, 1)) {
    const output = fakeOutput();
    let started = false;
    const result = await launchWithPageLogin({
      env: { CAISSE_OPEN_NETWORK: value },
      output,
      start: async () => {
        started = true;
        return { port: 1 };
      },
      open: async () => true,
    });
    assert.equal(result.code, 1);
    assert.equal(started, false);
    assert.ok(output.text.includes(MESSAGES.networkRefused));
    assert.match(output.text, /CAISSE_OPEN_NETWORK n'est pas accepté/);
  }
});

test("lanceur (page) : réglage invalide, message sans valeur ; port occupé, essai du suivant ; navigateur absent, adresse affichée", async () => {
  const bad = fakeOutput();
  assert.equal((await launchWithPageLogin({ env: { PORT: "abc" }, output: bad, start: async () => ({}), open: async () => true })).code, 1);
  assert.match(bad.text, /PORT invalide/);
  assert.ok(!bad.text.includes("abc"));

  const output = fakeOutput();
  const tried = [];
  const result = await launchWithPageLogin({
    env: {},
    output,
    start: async (options) => {
      tried.push(options.port);
      if (options.port === 3001) throw Object.assign(new Error("busy"), { code: "EADDRINUSE" });
      return { port: options.port, close: async () => {} };
    },
    open: async () => false,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(tried, [3001, 3002]);
  assert.match(output.text, /Ouvrez vous-même cette adresse : http:\/\/127\.0\.0\.1:3002/);
});

test("lanceur (page) : de bout en bout avec le vrai serveur, la connexion sur la page démarre l'écoute et le mot de passe n'est nulle part", async () => {
  const cyclos = await startFakeCyclos();
  const port = await freePort();
  const output = fakeOutput();
  const logs = [];
  const original = { log: console.log, error: console.error, info: console.info };
  for (const level of Object.keys(original)) console[level] = (...args) => logs.push(args.join(" "));
  let result;
  try {
    result = await launchWithPageLogin({
      env: { CYCLOS_BASE_URL: cyclos.url, CYCLOS_CHANNEL: "", PORT: String(port) },
      output,
      start: startServer,
      open: async () => true,
    });
    assert.equal(result.code, 0);
    const base = `http://127.0.0.1:${port}`;
    const form = await fetch(`${base}/`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /type="password"/, "the login form is the page");
    const login = await fetch(`${base}/connexion`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login: USER.login, password: USER.password }).toString(),
    });
    assert.equal(login.status, 303);
    assert.match(login.headers.get("set-cookie"), /Max-Age=43200/, "12 hours");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const data = await fetch(`${base}/caisse/data`, { headers: { Cookie: cookie } });
    assert.equal(data.status, 200, "the listening is started by the login");
    const foreign = await rawRequest(base, { path: "/", headers: { Host: "evil.example" } });
    assert.equal(foreign.status, 403);
    assert.ok(!output.text.includes(USER.password));
    assert.ok(!logs.join("\n").includes(USER.password));
  } finally {
    await result?.handle?.close();
    await cyclos.close();
    Object.assign(console, original);
  }
});
