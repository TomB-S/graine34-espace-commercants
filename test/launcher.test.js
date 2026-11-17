// Start-up of the single executable (launcher.js): defaults, typing in the window, the one check of the credentials,
// the browser, the free port, and the whole sequence. No real terminal, no real browser, no real Cyclos: the streams
// and helpers are fakes. FICTITIOUS values only; the sentinel password below must appear nowhere in what is shown.
import "../test-support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { networkInterfaces } from "node:os";
import net from "node:net";
import { startServer } from "../server.js";
import { createCyclosPush, PushAuthError, PushForbiddenError, PushUnavailableError } from "../cyclos-push.js";
import { startFakeCyclos, USER } from "../test-support/fake-cyclos.js";
import {
  DEFAULTS,
  MESSAGES,
  LaunchError,
  NotConsoleError,
  CancelledError,
  readLaunchSettings,
  readLine,
  waitForEnter,
  askCredentials,
  checkCredentials,
  browserCommand,
  openBrowser,
  listenOnFreePort,
  launch,
} from "../launcher.js";

const SECRET = "Mot2Passe-Secret-fictif";

// A fake window: `typed(...)` sends keys, `output.text` is everything shown.
function fakeConsole({ tty = true, raw = true } = {}) {
  const input = new EventEmitter();
  input.isTTY = tty;
  if (raw) {
    input.setRawMode = (on) => input.rawHistory.push(on);
  }
  input.rawHistory = [];
  input.setEncoding = () => {};
  input.resume = () => {};
  input.pause = () => {};
  input.typed = (text) => input.emit("data", text);
  const output = { isTTY: tty, text: "", write(chunk) { this.text += chunk; } };
  return { input, output };
}

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

// ---- typing in the window

test("saisie : le mot de passe n'est jamais affiché, le mode brut est rendu", async () => {
  const { input, output } = fakeConsole();
  const pending = readLine({ input, output, prompt: "Mot de passe : ", hidden: true });
  input.typed(`${SECRET}\r`);
  assert.equal(await pending, SECRET);
  assert.ok(!output.text.includes(SECRET));
  assert.equal(output.text, "Mot de passe : \n", "nothing but the prompt and the final line break");
  assert.deepEqual(input.rawHistory, [true, false]);
});

test("saisie : l'identifiant est affiché au fil de la frappe, Retour arrière efface", async () => {
  const { input, output } = fakeConsole();
  const pending = readLine({ input, output, prompt: "Identifiant : " });
  input.typed("abx");
  input.typed("\u007fc\r");
  assert.equal(await pending, "abc");
  assert.ok(output.text.includes("\b \b"));
});

test("saisie : touches fléchées ignorées, accents et lettres hors Latin-1 gardés, retour arrière sur un caractère entier", async () => {
  const { input, output } = fakeConsole();
  const pending = readLine({ input, output, prompt: "> ", hidden: true });
  input.typed("é\u001b[A\u001b[1;5Cè");
  input.typed("😀\u007f");
  input.typed("ß\n");
  assert.equal(await pending, "éèß");
});

test("saisie : un mot de passe collé avec sa fin de ligne, le reste est ignoré", async () => {
  const { input, output } = fakeConsole();
  const pending = readLine({ input, output, prompt: "> ", hidden: true });
  input.typed("abc\r\nreste");
  assert.equal(await pending, "abc");
  assert.equal(input.listenerCount("data"), 0, "listeners removed");
});

test("saisie : Ctrl+C et fin de l'entrée annulent, sans rien renvoyer", async () => {
  for (const stop of ["abc\u0003", "\u0004"]) {
    const { input, output } = fakeConsole();
    const pending = readLine({ input, output, prompt: "> ", hidden: true });
    input.typed(stop);
    await assert.rejects(pending, CancelledError);
    assert.deepEqual(input.rawHistory, [true, false]);
  }
  const { input, output } = fakeConsole();
  const pending = readLine({ input, output, prompt: "> ", hidden: true });
  input.emit("end");
  await assert.rejects(pending, CancelledError);
});

test("saisie : une fenêtre qui n'est pas une vraie console est refusée, rien n'est demandé ni affiché en clair", async () => {
  for (const options of [{ tty: false }, { tty: true, raw: false }]) {
    const { input, output } = fakeConsole(options);
    await assert.rejects(readLine({ input, output, prompt: "Mot de passe : ", hidden: true }), NotConsoleError);
    assert.equal(output.text, "", "the prompt is not even written");
    await assert.rejects(askCredentials({ env: {}, input, output }), NotConsoleError);
  }
  await assert.rejects(readLine({ input: undefined, output: undefined, prompt: "> " }), NotConsoleError);
});

test("saisie : « Appuyez sur Entrée » attend Entrée, et ne bloque jamais sans console", async () => {
  const { input, output } = fakeConsole();
  const pending = waitForEnter({ input, output });
  input.typed("x");
  input.typed("\r");
  await pending;
  assert.ok(output.text.includes("Appuyez sur Entrée pour fermer."));
  const none = fakeConsole({ tty: false });
  await waitForEnter(none);
  assert.equal(none.output.text, "");
});

test("identifiants : donnés par l'environnement, rien n'est demandé (même sans console)", async () => {
  const { input, output } = fakeConsole({ tty: false });
  const result = await askCredentials({ env: { CAISSE_CYCLOS_LOGIN: "commerce", CAISSE_CYCLOS_PASSWORD: SECRET }, input, output });
  assert.deepEqual(result, { login: "commerce", password: SECRET });
  assert.equal(output.text, "");
});

test("identifiants : seul ce qui manque est demandé, une réponse vide est redemandée", async () => {
  const { input, output } = fakeConsole();
  const pending = askCredentials({ env: { CAISSE_CYCLOS_LOGIN: "commerce" }, input, output });
  input.typed("\r");
  await new Promise((resolve) => setImmediate(resolve));
  input.typed(`${SECRET}\r`);
  assert.deepEqual(await pending, { login: "commerce", password: SECRET });
  assert.ok(output.text.includes(MESSAGES.emptyPassword));
  assert.ok(!output.text.includes("Identifiant :"));
  assert.ok(!output.text.includes(SECRET));
});

// ---- the one check of the credentials

const fakePush = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    async createSession(login, password) {
      calls.push(["createSession", login, password]);
      return "jeton-fictif";
    },
    async getUserId() {
      calls.push(["getUserId"]);
      return "user-1";
    },
    async closeSession(token) {
      calls.push(["closeSession", token]);
    },
    ...overrides,
  };
};

test("vérification : identifiants acceptés = une session ouverte, lue, fermée", async () => {
  const push = fakePush();
  assert.equal(await checkCredentials(push, { login: "commerce", password: SECRET }), null);
  assert.deepEqual(push.calls.map((c) => c[0]), ["createSession", "getUserId", "closeSession"]);
});

test("vérification : un échec = un seul appel à Cyclos, un message précis en français sans donnée saisie", async () => {
  const cases = [
    [new PushAuthError("401"), MESSAGES.refused],
    [new PushForbiddenError("403"), MESSAGES.forbidden],
    [new PushUnavailableError("network error (ENOTFOUND)"), MESSAGES.unreachable],
    [new PushUnavailableError("timeout"), MESSAGES.unreachable],
    [new PushUnavailableError("x", { status: 429 }), MESSAGES.busy],
    [new PushUnavailableError("x", { status: 503 }), MESSAGES.unavailable(503)],
    [new PushUnavailableError("unreadable answer on createSession"), MESSAGES.unavailable()],
    [new Error("autre"), MESSAGES.unavailable()],
  ];
  for (const [error, expected] of cases) {
    const push = fakePush({ async createSession(login, password) { push.calls.push(["createSession", login, password]); throw error; } });
    const message = await checkCredentials(push, { login: "commerce", password: SECRET });
    assert.equal(message, expected);
    assert.equal(push.calls.filter((c) => c[0] === "createSession").length, 1, "never repeated");
    assert.ok(!message.includes(SECRET) && !message.includes("commerce"));
  }
  assert.match(MESSAGES.refused, /ne réessaie pas/);
  assert.match(MESSAGES.refused, /une seule fois/);
});

test("vérification : compte sans identifiant lisible = message, et la session est fermée", async () => {
  const push = fakePush({ async getUserId() { return null; } });
  assert.equal(await checkCredentials(push, { login: "commerce", password: SECRET }), MESSAGES.noAccount);
  assert.deepEqual(push.calls.at(-1), ["closeSession", "jeton-fictif"]);
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

test("port : le premier libre est pris, l'écoute est locale, les identifiants passent par les options", async () => {
  const tried = [];
  const start = async (options) => {
    tried.push(options.port);
    if (options.port < 3003) throw Object.assign(new Error("occupé"), { code: "EADDRINUSE" });
    return { port: options.port, options };
  };
  const settings = readLaunchSettings({});
  const handle = await listenOnFreePort(start, settings, { enabled: true, login: "commerce", password: SECRET });
  assert.deepEqual(tried, [3001, 3002, 3003]);
  assert.equal(handle.options.host, "127.0.0.1");
  assert.equal(handle.options.cyclosChannel, "main");
  assert.equal(handle.options.cyclosBaseUrl, DEFAULTS.baseUrl);
  assert.deepEqual(handle.options.caisse, { enabled: true, login: "commerce", password: SECRET });
});

test("port : imposé et occupé, ou tous occupés = message en français ; une autre erreur est transmise", async () => {
  const busy = async () => { throw Object.assign(new Error("occupé"), { code: "EADDRINUSE" }); };
  await assert.rejects(listenOnFreePort(busy, readLaunchSettings({ PORT: "4000" }), {}), /Le port 4000 est déjà utilisé/);
  await assert.rejects(listenOnFreePort(busy, readLaunchSettings({}), {}), /Aucun port libre entre 3001 et 3010/);
  const bug = new Error("CAISSE_POLL_SECONDS invalide");
  await assert.rejects(listenOnFreePort(async () => { throw bug; }, readLaunchSettings({}), {}), (error) => error === bug);
});

// ---- whole sequence

function sequence(overrides = {}) {
  const { input, output } = fakeConsole({ tty: false });
  const events = [];
  const push = fakePush();
  const deps = {
    env: { CAISSE_CYCLOS_LOGIN: "commerce", CAISSE_CYCLOS_PASSWORD: SECRET },
    input,
    output,
    start: async (options) => {
      events.push(["start", options]);
      return { port: options.port };
    },
    createPush: () => push,
    open: async (url) => {
      events.push(["open", url]);
      return true;
    },
    ...overrides,
  };
  return { deps, output, events, push };
}

test("lancement : tout va bien = vérification, serveur local, page ouverte, rien de secret affiché", async () => {
  const { deps, output, events, push } = sequence();
  const result = await launch(deps);
  assert.equal(result.code, 0);
  assert.equal(result.url, "http://127.0.0.1:3001");
  assert.deepEqual(events.map((e) => e[0]), ["start", "open"]);
  assert.equal(push.calls.filter((c) => c[0] === "createSession").length, 1);
  assert.ok(output.text.includes("La caisse est prête : http://127.0.0.1:3001"));
  assert.ok(!output.text.includes(SECRET));
  assert.ok(!output.text.includes("réseau local"), "no warning when the network is not opened");
  assert.equal(events[0][1].host, "127.0.0.1");
});

test("lancement : le mot de passe ne passe jamais par l'environnement du programme", async () => {
  const before = JSON.stringify(process.env);
  const { deps } = sequence();
  await launch(deps);
  assert.equal(JSON.stringify(process.env), before);
  assert.ok(!JSON.stringify(process.env).includes(SECRET));
});

test("lancement : identifiants refusés = un seul appel, ni serveur ni navigateur, code 1", async () => {
  const push = fakePush({ async createSession() { push.calls.push(["createSession"]); throw new PushAuthError("401"); } });
  const { deps, output, events } = sequence({ createPush: () => push });
  const result = await launch(deps);
  assert.equal(result.code, 1);
  assert.deepEqual(events, []);
  assert.equal(push.calls.length, 1);
  assert.ok(output.text.includes(MESSAGES.refused));
  assert.ok(!output.text.includes(SECRET));
});

test("lancement : sans console et sans identifiants = refus, Cyclos n'est pas appelé", async () => {
  const { deps, output, events, push } = sequence({ env: {} });
  const result = await launch(deps);
  assert.equal(result.code, 1);
  assert.deepEqual(events, []);
  assert.equal(push.calls.length, 0);
  assert.ok(output.text.includes(MESSAGES.notConsole));
});

test("lancement : annulation pendant la saisie, variable invalide, port introuvable", async () => {
  const win = fakeConsole();
  const sequenceTyped = sequence({ env: {}, input: win.input, output: win.output });
  const pending = launch(sequenceTyped.deps);
  win.input.typed("commerce\r");
  await new Promise((resolve) => setImmediate(resolve));
  win.input.typed("\u0003");
  const cancelled = await pending;
  assert.equal(cancelled.code, 1);
  assert.equal(cancelled.cancelled, true);
  assert.ok(win.output.text.includes(MESSAGES.cancelled));
  assert.equal(sequenceTyped.push.calls.length, 0);

  const invalid = sequence({ env: { PORT: "abc", CAISSE_CYCLOS_LOGIN: "c", CAISSE_CYCLOS_PASSWORD: SECRET } });
  assert.equal((await launch(invalid.deps)).code, 1);
  assert.ok(invalid.output.text.includes("PORT invalide"));
  assert.equal(invalid.push.calls.length, 0);

  const noPort = sequence({ start: async () => { throw new LaunchError("Aucun port libre entre 3001 et 3010."); } });
  assert.equal((await launch(noPort.deps)).code, 1);
  assert.ok(noPort.output.text.includes("Aucun port libre"));
  assert.ok(!noPort.events.some((e) => e[0] === "open"));
});

test("lancement : navigateur impossible à ouvrir = l'adresse est affichée, le programme continue", async () => {
  const { deps, output } = sequence({ open: async () => false });
  const result = await launch(deps);
  assert.equal(result.code, 0);
  assert.ok(output.text.includes("Ouvrez vous-même cette adresse : http://127.0.0.1:3001"));
});

test("lancement : accès réseau ouvert = écoute sur toutes les interfaces et avertissement", async () => {
  const { deps, output, events } = sequence({ env: { CAISSE_CYCLOS_LOGIN: "c", CAISSE_CYCLOS_PASSWORD: SECRET, CAISSE_OPEN_NETWORK: "true" } });
  await launch(deps);
  assert.equal(events[0][1].host, undefined);
  assert.ok(output.text.includes("ouvert à tout le réseau local"));
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

test("lancement : avec le vrai serveur et un faux Cyclos, la caisse répond sur l'adresse locale seulement", async () => {
  const cyclos = await startFakeCyclos();
  const { input, output } = fakeConsole({ tty: false });
  let opened = null;
  const result = await launch({
    env: { CYCLOS_BASE_URL: cyclos.url, PORT: String(await freePort()), CAISSE_CYCLOS_LOGIN: USER.login, CAISSE_CYCLOS_PASSWORD: USER.password },
    input,
    output,
    start: startServer,
    createPush: ({ baseUrl, channel }) => createCyclosPush({ baseUrl, channel }),
    open: async (url) => {
      opened = url;
      return true;
    },
  });
  try {
    assert.equal(result.code, 0, output.text);
    assert.ok(opened.startsWith(`${result.url}/ouvrir?t=`), "the browser gets the one-time link");
    assert.equal(cyclos.calls("POST", "/auth/session").length, 1, "one login for the check");
    const css = await fetch(`${result.url}/style.css`);
    assert.equal(css.status, 200);
    assert.equal((await fetch(`${result.url}/caisse`, { redirect: "manual" })).status, 303, "the page is behind the login");
    const external = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal);
    if (external) {
      await assert.rejects(fetch(`http://${external.address}:${result.handle.port}/style.css`), "not reachable from the network");
    }
    assert.ok(!output.text.includes(USER.password));
  } finally {
    await result.handle?.close();
    await cyclos.close();
  }
});

test("lancement : avec le vrai serveur, un mauvais mot de passe = un seul essai, serveur jamais démarré", async () => {
  const cyclos = await startFakeCyclos();
  const { input, output } = fakeConsole({ tty: false });
  const result = await launch({
    env: { CYCLOS_BASE_URL: cyclos.url, PORT: String(await freePort()), CAISSE_CYCLOS_LOGIN: USER.login, CAISSE_CYCLOS_PASSWORD: "mauvais-mot-de-passe-fictif" },
    input,
    output,
    start: startServer,
    createPush: ({ baseUrl, channel }) => createCyclosPush({ baseUrl, channel }),
    open: async () => assert.fail("no browser"),
  });
  try {
    assert.equal(result.code, 1);
    assert.equal(cyclos.calls("POST", "/auth/session").length, 1);
    assert.ok(output.text.includes(MESSAGES.refused));
    assert.ok(!output.text.includes("mauvais-mot-de-passe-fictif"));
  } finally {
    await cyclos.close();
  }
});
