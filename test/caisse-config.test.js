// === WHAT THIS FILE CHECKS ===
// The CAISSE_* variables of the cash register page: defaults, validation, and the rule "an invalid value means the
// server refuses to start". Also: with CAISSE_ENABLED off, nothing is required. The password never appears in an
// error message nor in the configuration object. All values are fictitious. Basic notions: test/statique.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
// MUST stay first: cleans the environment variables before server.js is loaded (see env-propre.js).
import { envEnfant } from "./support/env-propre.js";
import { readCaisseConfig, PROTOTYPE_MERCHANT } from "../src/caisse-config.js";
import { startServer } from "../src/server.js";

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
      pollSeconds: 3,
      idleSeconds: 45,
      streamWatchdogSeconds: 60,
      reconnectMaxSeconds: 30,
      reauthMax: 3,
      safetyPollSeconds: 60,
      historyInitial: 10,
      ticketsKept: 50,
      maxListeners: 5,
      hidePayerName: false,
      nameOrder: "nom-prenom",
      hiddenDescriptions: ["Virement Mobile Pro"],
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
    CAISSE_POLL_SECONDS: [0, 60], // 0 = manual mode
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

// Intention: the order of the words of the payer name: two values, "nom-prenom" by default, anything else refused
// without ever repeating the value in the message.
test("caisse : CAISSE_NAME_ORDER, valeurs acceptées et refusées", () => {
  assert.equal(readCaisseConfig(ENABLED).nameOrder, "nom-prenom");
  assert.equal(readCaisseConfig({ ...ENABLED, CAISSE_NAME_ORDER: "" }).nameOrder, "nom-prenom");
  assert.equal(readCaisseConfig({ ...ENABLED, CAISSE_NAME_ORDER: "nom-prenom" }).nameOrder, "nom-prenom");
  assert.equal(readCaisseConfig({ ...ENABLED, CAISSE_NAME_ORDER: "prenom-nom" }).nameOrder, "prenom-nom");
  for (const bad of ["Nom-Prenom", "famille", "ordre inverse", "Dupont-Marie"]) {
    assert.throws(
      () => readCaisseConfig({ ...ENABLED, CAISSE_NAME_ORDER: bad }),
      (error) => /CAISSE_NAME_ORDER invalide/.test(error.message) && !error.message.includes(bad),
      bad,
    );
  }
  // Page disabled: the other CAISSE_* variables are not read.
  assert.doesNotThrow(() => readCaisseConfig({ CAISSE_NAME_ORDER: "n'importe quoi" }));
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
  const child = spawn(process.execPath, ["src/server.js"], {
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

test("node src/server.js : CAISSE_ENABLED=true sans identifiant, message clair, code 1", async () => {
  const { exited, output } = runServer({ CAISSE_ENABLED: "true" });
  assert.equal(await exited, 1);
  assert.match(output(), /^CAISSE_ENABLED=true exige CAISSE_CYCLOS_LOGIN et CAISSE_CYCLOS_PASSWORD/);
  assert.ok(!/\n\s+at /.test(output()), "pas de pile d'appels");
  assert.ok(!output().includes("Serveur démarré"));
});

test("node src/server.js : valeur CAISSE_* invalide, message clair, code 1, sans écho du mot de passe", async () => {
  const { exited, output } = runServer({ ...ENABLED, CAISSE_IDLE_SECONDS: "5" });
  assert.equal(await exited, 1);
  assert.match(output(), /^CAISSE_IDLE_SECONDS invalide/);
  assert.ok(!output().includes(ENABLED.CAISSE_CYCLOS_PASSWORD));
});

test("node src/server.js : caisse désactivée, démarre sans identifiant, même sortie qu'avant", async () => {
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

// Intention: CAISSE_POLL_SECONDS=0 is the manual mode (no automatic reading in the script), and 3 stays the default.
test("caisse : CAISSE_POLL_SECONDS=0 accepté (mode manuel), 3 par défaut", () => {
  assert.equal(readCaisseConfig({ ...ENABLED, CAISSE_POLL_SECONDS: "0" }).pollSeconds, 0);
  assert.equal(readCaisseConfig({ ...ENABLED }).pollSeconds, 3);
});

// Intention: CAISSE_HIDDEN_DESCRIPTIONS: not set = the default, set but empty = nothing hidden, commas separate the values (trimmed).
test("caisse : CAISSE_HIDDEN_DESCRIPTIONS = défaut, vide, ou liste séparée par des virgules", () => {
  assert.deepEqual(readCaisseConfig({ ...ENABLED }).hiddenDescriptions, ["Virement Mobile Pro"]);
  assert.deepEqual(readCaisseConfig({ ...ENABLED, CAISSE_HIDDEN_DESCRIPTIONS: "" }).hiddenDescriptions, []);
  assert.deepEqual(readCaisseConfig({ ...ENABLED, CAISSE_HIDDEN_DESCRIPTIONS: " , ,, " }).hiddenDescriptions, []);
  assert.deepEqual(readCaisseConfig({ ...ENABLED, CAISSE_HIDDEN_DESCRIPTIONS: "Un, Deux ,Virement Mobile Pro," }).hiddenDescriptions, ["Un", "Deux", "Virement Mobile Pro"]);
});

// === Multi-merchant mode: settings only (nothing uses them yet) ===

// Intention: off by default, and then the configuration holds none of the multi-merchant fields.
test("caisse multi : désactivé par défaut, aucun champ du mode multi dans la configuration", () => {
  for (const env of [ENABLED, { ...ENABLED, CAISSE_MULTI_MERCHANT: "false" }, { ...ENABLED, CAISSE_MULTI_MERCHANT: "" }]) {
    const config = readCaisseConfig(env);
    for (const field of ["multiMerchant", "allowedUsers", "trustedProxyHops", "multiMerchantIgnored", "espaceReleveUrl"]) {
      assert.equal(field in config, false, field);
    }
    assert.equal(config.maxListeners, 5);
  }
  // Off: the multi-merchant variables are not even read (a wrong value does not matter).
  const config = readCaisseConfig({ ...ENABLED, CAISSE_ALLOWED_USERS: "a b c", CAISSE_TRUSTED_PROXY_HOPS: "x" });
  assert.equal("allowedUsers" in config, false);
});

// Intention: the flag only accepts "true" or "false".
test("caisse multi : valeur invalide du drapeau refusée", () => {
  for (const bad of ["TRUE", "1", "oui"]) {
    assert.throws(() => readCaisseConfig({ ...ENABLED, CAISSE_MULTI_MERCHANT: bad }), /CAISSE_MULTI_MERCHANT invalide/, bad);
  }
});

// Intention: the defaults of the multi-merchant mode: 30 listeners, no trusted relay, an empty list (which does not restrict: the MonComptePro account decides).
test("caisse multi : valeurs par défaut (30 écouteurs, 0 relais, liste vide, donc pas de restriction par la liste)", () => {
  const config = readCaisseConfig({ ...ENABLED, CAISSE_MULTI_MERCHANT: "true" });
  assert.equal(config.multiMerchant, true);
  assert.equal(config.maxListeners, 30);
  assert.equal(config.trustedProxyHops, 0);
  assert.deepEqual(config.allowedUsers, { ids: [], emails: [] });
});

// Intention: the listener cap has its own range in this mode (up to 200), and is still checked.
test("caisse multi : plafond d'écouteurs de 1 à 200", () => {
  const multi = { ...ENABLED, CAISSE_MULTI_MERCHANT: "true" };
  assert.equal(readCaisseConfig({ ...multi, CAISSE_MAX_LISTENERS: "200" }).maxListeners, 200);
  assert.equal(readCaisseConfig({ ...multi, CAISSE_MAX_LISTENERS: "1" }).maxListeners, 1);
  for (const bad of ["0", "201", "abc"]) {
    assert.throws(() => readCaisseConfig({ ...multi, CAISSE_MAX_LISTENERS: bad }), /CAISSE_MAX_LISTENERS invalide/, bad);
  }
  // Without the mode, the old range still holds.
  assert.throws(() => readCaisseConfig({ ...ENABLED, CAISSE_MAX_LISTENERS: "51" }), /CAISSE_MAX_LISTENERS invalide/);
});

// Intention: the number of trusted relays, 0 to 5.
test("caisse multi : nombre de relais de confiance de 0 à 5", () => {
  const multi = { ...ENABLED, CAISSE_MULTI_MERCHANT: "true" };
  assert.equal(readCaisseConfig({ ...multi, CAISSE_TRUSTED_PROXY_HOPS: "1" }).trustedProxyHops, 1);
  assert.equal(readCaisseConfig({ ...multi, CAISSE_TRUSTED_PROXY_HOPS: "5" }).trustedProxyHops, 5);
  for (const bad of ["6", "-1", "un"]) {
    assert.throws(() => readCaisseConfig({ ...multi, CAISSE_TRUSTED_PROXY_HOPS: bad }), /CAISSE_TRUSTED_PROXY_HOPS invalide/, bad);
  }
});

// Intention: the list takes internal numbers and e-mail addresses, mixed; e-mails are lowercased and trimmed; duplicates dropped.
test("caisse multi : liste autorisée, numéros internes et e-mails mélangés", () => {
  const config = readCaisseConfig({
    ...ENABLED,
    CAISSE_MULTI_MERCHANT: "true",
    CAISSE_ALLOWED_USERS: " 1234567890 , Marie@Exemple.TEST,marie@exemple.test, 9876,, ",
  });
  assert.deepEqual(config.allowedUsers, { ids: ["1234567890", "9876"], emails: ["marie@exemple.test"] });
});

// Intention: a bad entry refuses the start, and the message never quotes the entry.
test("caisse multi : entrée invalide refusée sans être citée", () => {
  for (const bad of ["12 34", "a@b@c", "x/y", "<script>"]) {
    assert.throws(
      () => readCaisseConfig({ ...ENABLED, CAISSE_MULTI_MERCHANT: "true", CAISSE_ALLOWED_USERS: `ok1,${bad}` }),
      (error) => /CAISSE_ALLOWED_USERS invalide/.test(error.message) && !error.message.includes(bad),
      bad,
    );
  }
});

// Intention: the executable stays single-merchant: the flag is ignored, flagged for the start message, and nothing else is read.
test("caisse multi : ignoré dans l'exécutable (connexion qui démarre l'écoute)", () => {
  const config = readCaisseConfig(
    { CAISSE_MULTI_MERCHANT: "true", CAISSE_ALLOWED_USERS: "pas valide !", CAISSE_MAX_LISTENERS: "10" },
    { enabled: true, credentialsFromLogin: true },
  );
  assert.equal(config.multiMerchantIgnored, true);
  for (const field of ["multiMerchant", "allowedUsers", "trustedProxyHops"]) assert.equal(field in config, false, field);
  assert.equal(config.maxListeners, 10); // the old range and setting, untouched
});

// Intention: in the multi-merchant mode there is no listening account: nothing is required, and nothing from the environment is kept
// (no password in the configuration). Without the mode, both are still required.
test("caisse multi : aucun compte d'écoute exigé ni conservé ; en mono, toujours exigé", () => {
  const config = readCaisseConfig({ CAISSE_ENABLED: "true", CAISSE_MULTI_MERCHANT: "true" });
  assert.equal(config.multiMerchant, true);
  assert.equal(config.credentialsFor(PROTOTYPE_MERCHANT), null);
  const withEnv = readCaisseConfig({ ...ENABLED, CAISSE_MULTI_MERCHANT: "true" });
  assert.equal(withEnv.credentialsFor(PROTOTYPE_MERCHANT), null, "the environment's account is ignored");
  assert.equal(JSON.stringify(withEnv).includes("mdp-fictif-pour-test"), false);
  assert.throws(() => readCaisseConfig({ CAISSE_ENABLED: "true" }), /exige CAISSE_CYCLOS_LOGIN/);
});

// Intention: ESPACE_RELEVE_URL is gone (the statement is part of the site, at /espace/releve): the old setting is not read any more, whatever
// its value, in both modes, and does not refuse the start.
test("caisse multi : ESPACE_RELEVE_URL n'est plus lu, même avec une valeur invalide", () => {
  const multi = { ...ENABLED, CAISSE_MULTI_MERCHANT: "true" };
  for (const value of ["", "  ", "https://releve.exemple.test/", "/releve", "javascript:alert(1)", "//autre.test/x"]) {
    for (const env of [multi, ENABLED]) {
      const config = readCaisseConfig({ ...env, ESPACE_RELEVE_URL: value });
      assert.equal("espaceReleveUrl" in config, false, value);
      assert.deepEqual(JSON.parse(JSON.stringify(config)), JSON.parse(JSON.stringify(readCaisseConfig(env))), value); // (functions are not compared)
    }
  }
});
