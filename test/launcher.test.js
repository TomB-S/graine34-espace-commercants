// Start-up of the single executable (launcher.js): defaults, the browser, the free port, the whole sequence with the login
// typed on the page. No real terminal, no real browser, no real Cyclos for most tests: the streams and helpers are fakes.
// FICTITIOUS values only; the sentinel password must appear nowhere in what is shown or logged.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { networkInterfaces } from "node:os";
import net from "node:net";
import { startServer } from "../src/server.js";
import { startFakeCyclos, USER } from "./support/fake-cyclos.js";
import { rawRequest } from "./support/harness.js";
import {
  DEFAULTS,
  MESSAGES,
  SESSION_MAX_MS,
  LaunchError,
  readLaunchSettings,
  waitForEnter,
  browserCommand,
  openBrowser,
  listenOnFreePort,
  launch,
} from "../src/launcher.js";

const fakeOutput = () => ({ text: "", write(chunk) { this.text += chunk; } });

// ---- settings

test("lanceur : valeurs par défaut intégrées, écoute locale", () => {
  const settings = readLaunchSettings({});
  assert.equal(settings.baseUrl, DEFAULTS.baseUrl);
  assert.equal(settings.baseUrl, "https://laruchedesmonnaieslocales.org/lagraine34/api");
  assert.equal(settings.channel, "main");
  assert.equal(settings.port, 3001);
  assert.equal(settings.portImposed, false);
  assert.equal(settings.host, "127.0.0.1");
  assert.equal(settings.openNetwork, false);
});

test("lanceur : les variables d'environnement l'emportent sur les valeurs par défaut", () => {
  const settings = readLaunchSettings({ CYCLOS_BASE_URL: "https://exemple.test/api/", CYCLOS_CHANNEL: "autre", PORT: "4000", CAISSE_OPEN_NETWORK: "true" });
  assert.equal(settings.baseUrl, "https://exemple.test/api", "trailing slash removed");
  assert.equal(settings.channel, "autre");
  assert.equal(settings.port, 4000);
  assert.equal(settings.portImposed, true);
  assert.equal(settings.host, undefined, "network opened on purpose: every interface");
  assert.equal(readLaunchSettings({ CYCLOS_CHANNEL: "" }).channel, "", "set but empty: no channel");
  assert.equal(readLaunchSettings({ CYCLOS_BASE_URL: "" }).baseUrl, DEFAULTS.baseUrl, "empty address: never the demo");
  assert.equal(readLaunchSettings({ CAISSE_OPEN_NETWORK: "false" }).host, "127.0.0.1");
});

test("lanceur : variable invalide refusée, message en français sans la valeur", () => {
  const cases = [
    [{ CYCLOS_BASE_URL: "ftp://secret-hote" }, /CYCLOS_BASE_URL invalide/, "secret-hote"],
    [{ CYCLOS_CHANNEL: "a b;c" }, /CYCLOS_CHANNEL invalide/, "a b;c"],
    [{ PORT: "99999" }, /PORT invalide/, "99999"],
    [{ PORT: "abc" }, /PORT invalide/, "abc"],
    [{ CAISSE_OPEN_NETWORK: "oui" }, /CAISSE_OPEN_NETWORK invalide/, "oui"],
  ];
  for (const [env, pattern, value] of cases) {
    assert.throws(
      () => readLaunchSettings(env),
      (error) => error instanceof LaunchError && pattern.test(error.message) && !error.message.includes(value),
    );
  }
});


// ---- keeping the window open

test("fenêtre : « Appuyez sur Entrée » attend une touche sans rien lire ni garder, et ne bloque jamais sans console", async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.resume = () => {};
  input.pause = () => {};
  const output = { isTTY: true, text: "", write(chunk) { this.text += chunk; } };
  let done = false;
  const pending = waitForEnter({ input, output }).then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, "waits");
  assert.equal(output.text, `${MESSAGES.closeAfterError} `);
  input.emit("data", "texte tapé");
  await pending;
  assert.equal(input.listenerCount("data"), 0, "listeners removed");
  assert.ok(!output.text.includes("texte tapé"), "what is typed is never echoed");

  const notConsole = new EventEmitter();
  notConsole.isTTY = false;
  await waitForEnter({ input: notConsole, output: { isTTY: false, write() { assert.fail("nothing written"); } } });
});

// ---- browser

test("navigateur : une commande par système, l'adresse passée en argument", () => {
  const url = "http://127.0.0.1:3001";
  assert.deepEqual(browserCommand("darwin", url), ["open", [url]]);
  assert.deepEqual(browserCommand("win32", url), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  assert.deepEqual(browserCommand("linux", url), ["xdg-open", [url]]);
  assert.deepEqual(browserCommand("freebsd", url), ["xdg-open", [url]]);
});

function fakeSpawn(behavior) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => behavior(child));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test("navigateur : ouverture réussie, sans shell, détachée", async () => {
  const spawn = fakeSpawn((child) => child.emit("exit", 0));
  assert.equal(await openBrowser("http://127.0.0.1:3001", { platform: "darwin", spawn }), true);
  assert.equal(spawn.calls[0].command, "open");
  assert.notEqual(spawn.calls[0].options.shell, true);
  assert.equal(spawn.calls[0].options.detached, true);
});

test("navigateur : commande absente, code non nul ou exception = false, jamais d'erreur", async () => {
  assert.equal(await openBrowser("u", { platform: "linux", spawn: fakeSpawn((c) => c.emit("error", new Error("ENOENT"))) }), false);
  assert.equal(await openBrowser("u", { platform: "linux", spawn: fakeSpawn((c) => c.emit("exit", 3)) }), false);
  assert.equal(await openBrowser("u", { platform: "win32", spawn: () => { throw new Error("boum"); } }), false);
  assert.equal(await openBrowser("u", { platform: "darwin", waitMs: 10, spawn: fakeSpawn(() => {}) }), true, "still running after the delay");
});


// ---- free port

test("port : le premier libre est pris, l'écoute est locale, aucun identifiant ne passe par les options", async () => {
  const tried = [];
  const start = async (options) => {
    tried.push(options.port);
    if (options.port < 3003) throw Object.assign(new Error("occupé"), { code: "EADDRINUSE" });
    return { port: options.port, options };
  };
  const handle = await listenOnFreePort(start, readLaunchSettings({}));
  assert.deepEqual(tried, [3001, 3002, 3003]);
  const { options } = handle;
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.cyclosChannel, "main");
  assert.equal(options.cyclosBaseUrl, DEFAULTS.baseUrl);
  assert.equal(options.listenOnLogin, true, "the login of the page starts the listening");
  assert.equal(options.maxMs, 12 * 3_600_000);
  assert.equal(SESSION_MAX_MS, 12 * 3_600_000);
  assert.equal(options.caisse, undefined, "no credentials");
  assert.equal(options.autoLogin, undefined, "no one-time link");
});

test("port : imposé et occupé, ou tous occupés = message en français ; une autre erreur est transmise", async () => {
  const busy = async () => { throw Object.assign(new Error("occupé"), { code: "EADDRINUSE" }); };
  await assert.rejects(listenOnFreePort(busy, readLaunchSettings({ PORT: "4000" })), /Le port 4000 est déjà utilisé/);
  await assert.rejects(listenOnFreePort(busy, readLaunchSettings({})), /Aucun port libre entre 3001 et 3010/);
  const bug = new Error("CAISSE_POLL_SECONDS invalide");
  await assert.rejects(listenOnFreePort(async () => { throw bug; }, readLaunchSettings({})), (error) => error === bug);
});

// ---- whole sequence

test("lancement : rien n'est demandé, serveur local avec l'option réservée, adresse simple ouverte, identifiants de l'environnement ignorés", async () => {
  const output = fakeOutput();
  const started = [];
  const opened = [];
  const result = await launch({
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
  assert.ok(!JSON.stringify(started[0]).includes("depuis-env"), "the environment credentials are never passed on");
  assert.deepEqual(opened, ["http://127.0.0.1:3001"], "plain address, no code");
  assert.match(output.text, /La caisse est prête : http:\/\/127\.0\.0\.1:3001/);
  assert.match(output.text, /Rien n'est demandé dans cette fenêtre/);
  assert.ok(!output.text.includes("depuis-env"));
});

test("lancement : CAISSE_OPEN_NETWORK est refusé, le serveur n'est pas démarré", async () => {
  const output = fakeOutput();
  let started = false;
  const result = await launch({
    env: { CAISSE_OPEN_NETWORK: "true" },
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
});

test("lancement : réglage invalide = message sans valeur ; port introuvable = message ; navigateur impossible = adresse affichée", async () => {
  const bad = fakeOutput();
  assert.equal((await launch({ env: { PORT: "abc" }, output: bad, start: async () => ({}), open: async () => true })).code, 1);
  assert.match(bad.text, /PORT invalide/);
  assert.ok(!bad.text.includes("abc"));

  const busy = fakeOutput();
  const busyStart = async () => { throw Object.assign(new Error("occupé"), { code: "EADDRINUSE" }); };
  assert.equal((await launch({ env: { PORT: "4000" }, output: busy, start: busyStart, open: async () => true })).code, 1);
  assert.match(busy.text, /Le port 4000 est déjà utilisé/);

  const output = fakeOutput();
  const tried = [];
  const result = await launch({
    env: {},
    output,
    start: async (options) => {
      tried.push(options.port);
      if (options.port === 3001) throw Object.assign(new Error("occupé"), { code: "EADDRINUSE" });
      return { port: options.port, close: async () => {} };
    },
    open: async () => false,
  });
  assert.equal(result.code, 0, "the program goes on");
  assert.deepEqual(tried, [3001, 3002]);
  assert.match(output.text, /Ouvrez vous-même cette adresse : http:\/\/127\.0\.0\.1:3002/);
});

// ---- with the real server and the fake Cyclos

// A port that is free now (the launcher refuses PORT=0).
const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

test("lancement : avec le vrai serveur, la connexion sur la page démarre l'écoute, local seulement, mot de passe nulle part", async () => {
  const cyclos = await startFakeCyclos();
  const port = await freePort();
  const output = fakeOutput();
  const logs = [];
  const original = { log: console.log, error: console.error, info: console.info };
  for (const level of Object.keys(original)) console[level] = (...args) => logs.push(args.join(" "));
  let result;
  try {
    result = await launch({
      env: { CYCLOS_BASE_URL: cyclos.url, CYCLOS_CHANNEL: "", PORT: String(port) },
      output,
      start: startServer,
      open: async () => true,
    });
    assert.equal(result.code, 0, output.text);
    const base = result.url;
    assert.equal(cyclos.calls("POST", "/auth/session").length, 0, "nothing is sent to Cyclos by the start-up");
    const form = await fetch(`${base}/`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /type="password"/, "the login form is the page");
    assert.equal((await fetch(`${base}/caisse`, { redirect: "manual" })).status, 303, "the page is behind the login");
    assert.equal((await fetch(`${base}/ouvrir?t=${"0".repeat(32)}`, { redirect: "manual" })).status, 404, "no one-time link any more");

    const login = await fetch(`${base}/connexion`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login: USER.login, password: USER.password }).toString(),
    });
    assert.equal(login.status, 303);
    assert.match(login.headers.get("set-cookie"), /Max-Age=43200/, "12 hours");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${base}/caisse/data`, { headers: { Cookie: cookie } })).status, 200, "the listening is started by the login");

    assert.equal((await rawRequest(base, { path: "/", headers: { Host: "evil.example" } })).status, 403);
    const external = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal);
    if (external) {
      await assert.rejects(fetch(`http://${external.address}:${result.handle.port}/style.css`), "not reachable from the network");
    }
    assert.ok(!output.text.includes(USER.password));
    assert.ok(!logs.join("\n").includes(USER.password), "the password is in no log");
  } finally {
    await result?.handle?.close();
    await cyclos.close();
    Object.assign(console, original);
  }
});
