// === WHAT THIS FILE CHECKS ===
// The CAISSE_* variables of the cash register page: defaults, validation, and the rule "an invalid value means the
// server refuses to start". Also: with CAISSE_ENABLED off, nothing is required. The password never appears in an
// error message nor in the configuration object. All values are fictitious. Basic notions: test/statique.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
// MUST stay first: cleans the environment variables before server.js is loaded (see env-propre.js).
import { envEnfant } from "../test-support/env-propre.js";
import { readCaisseConfig, PROTOTYPE_MERCHANT } from "../caisse-config.js";
import { startServer } from "../server.js";

const ENABLED = {
  CAISSE_ENABLED: "true",
  CAISSE_CYCLOS_LOGIN: "ecouteur-test",
  CAISSE_CYCLOS_PASSWORD: "mdp-fictif-pour-test",
};

// Intention: with nothing set, the page is off and no credential is asked for.
test("caisse : sans variable, désactivée et aucun identifiant exigé", () => {
  const config = readCaisseConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.credentialsFor(PROTOTYPE_MERCHANT), null);
});

// Intention: when off, even a wrong value elsewhere cannot stop the server (the feature is inert),
// but CAISSE_ENABLED itself is always checked.
test("caisse : désactivée, les autres variables sont ignorées ; CAISSE_ENABLED invalide refusé", () => {
  assert.equal(readCaisseConfig({ CAISSE_ENABLED: "false", CAISSE_IDLE_SECONDS: "abc" }).enabled, false);
  assert.equal(readCaisseConfig({ CAISSE_ENABLED: "", CAISSE_REFRESH_SECONDS: "0" }).enabled, false);
  for (const bad of ["TRUE", "1", "yes", "oui", " true"]) {
    assert.throws(() => readCaisseConfig({ CAISSE_ENABLED: bad }), /CAISSE_ENABLED invalide/, bad);
  }
});

// Intention: the documented defaults.
test("caisse : activée, valeurs par défaut de la section configuration", () => {
  const config = readCaisseConfig(ENABLED);
  assert.deepEqual(
    { ...config, credentialsFor: undefined },
    {
      enabled: true,
      refreshSeconds: 5,
      idleSeconds: 45,
      streamWatchdogSeconds: 60,
      reconnectMaxSeconds: 30,
      reauthMax: 3,
      safetyPollSeconds: 60,
      historyInitial: 10,
      ticketsKept: 50,
      maxListeners: 5,
      hidePayerName: false,
      accountType: null,
      credentialsFor: undefined,
    },
  );
});

// Intention: explicit values are read, at the limits of their range.
test("caisse : valeurs explicites lues, bornes incluses", () => {
  const config = readCaisseConfig({
    ...ENABLED,
    CAISSE_REFRESH_SECONDS: "2",
    CAISSE_IDLE_SECONDS: "600",
    CAISSE_STREAM_WATCHDOG_SECONDS: "10",
    CAISSE_RECONNECT_MAX_SECONDS: "1",
    CAISSE_REAUTH_MAX: "10",
    CAISSE_SAFETY_POLL_SECONDS: "3600",
    CAISSE_HISTORY_INITIAL: "100",
    CAISSE_TICKETS_KEPT: "500",
    CAISSE_MAX_LISTENERS: "50",
    CAISSE_HIDE_PAYER_NAME: "true",
    CAISSE_ACCOUNT_TYPE: "TypeDeCompteTest",
  });
  assert.equal(config.refreshSeconds, 2);
  assert.equal(config.idleSeconds, 600);
  assert.equal(config.streamWatchdogSeconds, 10);
  assert.equal(config.reconnectMaxSeconds, 1);
  assert.equal(config.reauthMax, 10);
  assert.equal(config.safetyPollSeconds, 3600);
  assert.equal(config.historyInitial, 100);
  assert.equal(config.ticketsKept, 500);
  assert.equal(config.maxListeners, 50);
  assert.equal(config.hidePayerName, true);
  assert.equal(config.accountType, "TypeDeCompteTest");
});

// Intention: each numeric variable refuses text, decimals, negatives, and values out of range,
// with a message that names the variable (and nothing else of what was typed).
test("caisse : valeur numérique invalide refusée, la variable est nommée", () => {
  const limits = {
    CAISSE_REFRESH_SECONDS: [2, 60],
    CAISSE_IDLE_SECONDS: [15, 600],
    CAISSE_STREAM_WATCHDOG_SECONDS: [10, 600],
    CAISSE_RECONNECT_MAX_SECONDS: [1, 600],
    CAISSE_REAUTH_MAX: [1, 10],
    CAISSE_SAFETY_POLL_SECONDS: [10, 3600],
    CAISSE_HISTORY_INITIAL: [1, 100],
    CAISSE_TICKETS_KEPT: [1, 500],
    CAISSE_MAX_LISTENERS: [1, 50],
  };
  for (const [name, [min, max]] of Object.entries(limits)) {
    for (const bad of ["abc", "1.5", "-1", " 5", "5 ", "0x10", String(min - 1), String(max + 1)]) {
      assert.throws(
        () => readCaisseConfig({ ...ENABLED, [name]: bad }),
        (error) => error.message.startsWith(`${name} invalide`) && !error.message.includes(`"${bad}"`),
        `${name}=${JSON.stringify(bad)}`,
      );
    }
  }
});

// Intention: the boolean and the account type are strict as well (the type goes into a URL path).
test("caisse : CAISSE_HIDE_PAYER_NAME et CAISSE_ACCOUNT_TYPE invalides refusés", () => {
  for (const bad of ["TRUE", "1", "oui"]) {
    assert.throws(() => readCaisseConfig({ ...ENABLED, CAISSE_HIDE_PAYER_NAME: bad }), /CAISSE_HIDE_PAYER_NAME invalide/);
  }
  for (const bad of ["a/b", "a b", "../x", "a?b=1", "x".repeat(61), "é"]) {
    assert.throws(() => readCaisseConfig({ ...ENABLED, CAISSE_ACCOUNT_TYPE: bad }), /CAISSE_ACCOUNT_TYPE invalide/, bad);
  }
});

// Intention: enabled without credentials is refused, and the message does not repeat any value.
test("caisse : activée sans identifiant ou sans mot de passe, refusée", () => {
  const withoutLogin = { ...ENABLED, CAISSE_CYCLOS_LOGIN: "" };
  const withoutPassword = { ...ENABLED, CAISSE_CYCLOS_PASSWORD: undefined };
  const blankLogin = { ...ENABLED, CAISSE_CYCLOS_LOGIN: "   " };
  for (const env of [withoutLogin, withoutPassword, blankLogin]) {
    assert.throws(
      () => readCaisseConfig(env),
      (error) => /CAISSE_CYCLOS_LOGIN et CAISSE_CYCLOS_PASSWORD/.test(error.message) && !error.message.includes(ENABLED.CAISSE_CYCLOS_PASSWORD),
    );
  }
});

// Intention: the configuration object holds no password (logging or serialising it cannot leak it);
// only credentialsFor() gives it, and only for the prototype merchant.
test("caisse : le mot de passe n'est pas dans l'objet de configuration, credentialsFor le donne au seul commerçant du prototype", () => {
  const config = readCaisseConfig(ENABLED);
  const dump = JSON.stringify(config) + Object.keys(config).join(",") + String(Object.values(config));
  assert.ok(!dump.includes(ENABLED.CAISSE_CYCLOS_PASSWORD));
  assert.ok(!dump.includes(ENABLED.CAISSE_CYCLOS_LOGIN));
  assert.deepEqual(config.credentialsFor(PROTOTYPE_MERCHANT), {
    login: ENABLED.CAISSE_CYCLOS_LOGIN,
    password: ENABLED.CAISSE_CYCLOS_PASSWORD,
  });
  assert.equal(config.credentialsFor("autre"), null);
  assert.equal(Object.isFrozen(config), true);
});

// Intention: tests can shorten the delays through overrides (no range check), credentials included.
test("caisse : surcharges de test (délais courts, identifiants)", () => {
  const config = readCaisseConfig({}, { enabled: true, login: "l", password: "p", idleSeconds: 0.2 });
  assert.equal(config.idleSeconds, 0.2);
  assert.deepEqual(config.credentialsFor(PROTOTYPE_MERCHANT), { login: "l", password: "p" });
});

// Intention: startServer is the place where the refusal happens.
test("caisse : startServer refuse de démarrer sur une configuration invalide", async () => {
  await assert.rejects(
    startServer({ port: 0, host: "127.0.0.1", caisse: { enabled: true } }),
    /CAISSE_ENABLED=true exige/,
  );
});

// Intention: launched for real, an invalid or incomplete configuration gives one clear line, no stack, exit code 1.
// Disabled, the server starts with no credential and prints exactly what it printed before.
function runServer(env) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: envEnfant({ PORT: String(20000 + Math.floor(Math.random() * 20000)), CYCLOS_CHANNEL: "", ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { child, exited, output: () => output };
}

test("node server.js : CAISSE_ENABLED=true sans identifiant, message clair, code 1", async () => {
  const { exited, output } = runServer({ CAISSE_ENABLED: "true" });
  assert.equal(await exited, 1);
  assert.match(output(), /^CAISSE_ENABLED=true exige CAISSE_CYCLOS_LOGIN et CAISSE_CYCLOS_PASSWORD/);
  assert.ok(!/\n\s+at /.test(output()), "pas de pile d'appels");
  assert.ok(!output().includes("Serveur démarré"));
});

test("node server.js : valeur CAISSE_* invalide, message clair, code 1, sans écho du mot de passe", async () => {
  const { exited, output } = runServer({ ...ENABLED, CAISSE_IDLE_SECONDS: "5" });
  assert.equal(await exited, 1);
  assert.match(output(), /^CAISSE_IDLE_SECONDS invalide/);
  assert.ok(!output().includes(ENABLED.CAISSE_CYCLOS_PASSWORD));
});

test("node server.js : caisse désactivée, démarre sans identifiant, même sortie qu'avant", async () => {
  const { child, exited, output } = runServer({});
  try {
    for (let i = 0; i < 100 && !output().includes("Canal Cyclos"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.match(output(), /^Serveur démarré sur http:\/\/localhost:\d+\nCanal Cyclos : \(par defaut\)\n$/);
  } finally {
    child.kill();
    await exited;
  }
});
