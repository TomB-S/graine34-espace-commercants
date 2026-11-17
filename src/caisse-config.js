// Configuration of the cash register page (CAISSE_* environment variables).
//
// The server reads no .env file itself: only environment variables (npm start
// loads .env before Node runs the server). Every value is validated here, and
// an invalid value throws an Error whose message names the variable (never its
// value): server.js lets it reject startServer(), so the server refuses to start.
//
// When CAISSE_ENABLED is not "true", nothing else is read: no credential is
// required and a wrong value in another CAISSE_* variable does not matter.

// Single merchant of the prototype. In production, the key will come from the
// registration of each merchant (see credentialsFor below).
export const PROTOTYPE_MERCHANT = "prototype";

// [variable, config field, default, minimum, maximum]. Whole numbers only.
const INTEGER_SETTINGS = [
  // Reload of the page for a browser WITHOUT script (<meta refresh> in <noscript>), and reading rhythm of the script.
  ["CAISSE_REFRESH_SECONDS", "refreshSeconds", 5, 2, 60],
  ["CAISSE_POLL_SECONDS", "pollSeconds", 3, 0, 60], // 0 = manual mode, no automatic reading in the script
  ["CAISSE_IDLE_SECONDS", "idleSeconds", 45, 15, 600],
  ["CAISSE_STREAM_WATCHDOG_SECONDS", "streamWatchdogSeconds", 60, 10, 600],
  ["CAISSE_RECONNECT_MAX_SECONDS", "reconnectMaxSeconds", 30, 1, 600],
  ["CAISSE_REAUTH_MAX", "reauthMax", 3, 1, 10],
  ["CAISSE_SAFETY_POLL_SECONDS", "safetyPollSeconds", 60, 10, 3600],
  ["CAISSE_HISTORY_INITIAL", "historyInitial", 10, 1, 100],
  ["CAISSE_TICKETS_KEPT", "ticketsKept", 50, 1, 500],
  ["CAISSE_MAX_LISTENERS", "maxListeners", 5, 1, 50],
];

// Type of account goes into a URL path: plain names only.
const ACCOUNT_TYPE = /^[A-Za-z0-9_.-]{1,60}$/;

// Descriptions the payment type puts by itself when the payer wrote nothing: not shown on the page.
const DEFAULT_HIDDEN_DESCRIPTIONS = ["Virement Mobile Pro"];

// A list of texts separated by commas. Not set: the default. Set but empty (or only commas and spaces): the empty list.
function readList(env, name, fallback) {
  const value = env[name];
  if (value === undefined) return [...fallback];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function readBoolean(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} invalide : "true" ou "false" attendu`);
}

// Order of the words of the payer name as Cyclos writes it in `display`.
const NAME_ORDERS = ["nom-prenom", "prenom-nom"];

function readNameOrder(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (!NAME_ORDERS.includes(value)) {
    throw new Error(`${name} invalide : "nom-prenom" ou "prenom-nom" attendu`);
  }
  return value;
}

function readInteger(env, [name, , fallback, min, max]) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} invalide : nombre entier de ${min} à ${max} attendu`);
  }
  return Number(value);
}

// Builds the configuration from `env`. `overrides` (tests only) are merged
// over the values read, without range checks, so that a test can use short delays.
// The returned object holds NO password: it is kept in the closure of
// credentialsFor(), so that logging or serialising the configuration cannot leak it.
export function readCaisseConfig(env = process.env, overrides = {}) {
  const enabled = overrides.enabled ?? readBoolean(env, "CAISSE_ENABLED", false);
  const config = { enabled };

  let login = "";
  let password = "";
  if (enabled) {
    for (const setting of INTEGER_SETTINGS) {
      config[setting[1]] = readInteger(env, setting);
    }
    config.hidePayerName = readBoolean(env, "CAISSE_HIDE_PAYER_NAME", false);
    config.nameOrder = readNameOrder(env, "CAISSE_NAME_ORDER", "nom-prenom");
    config.hiddenDescriptions = readList(env, "CAISSE_HIDDEN_DESCRIPTIONS", DEFAULT_HIDDEN_DESCRIPTIONS);

    const accountType = env.CAISSE_ACCOUNT_TYPE ?? "";
    if (accountType !== "" && !ACCOUNT_TYPE.test(accountType)) {
      throw new Error("CAISSE_ACCOUNT_TYPE invalide : lettres, chiffres, point, tiret et soulignement uniquement");
    }
    config.accountType = accountType || null; // null = discovered from GET /self/accounts

    login = env.CAISSE_CYCLOS_LOGIN ?? "";
    password = env.CAISSE_CYCLOS_PASSWORD ?? "";
  }

  // `credentialsFromLogin` (executable only, see startServer): the credentials are not configured at all, they come
  // from the login form of the page. Whatever the environment holds is then ignored, never used.
  const { login: loginOverride, password: passwordOverride, credentialsFromLogin = false, ...rest } = overrides;
  Object.assign(config, rest);
  login = loginOverride ?? login;
  password = passwordOverride ?? password;
  if (credentialsFromLogin) {
    login = "";
    password = "";
  }

  if (config.enabled && !credentialsFromLogin && (login.trim() === "" || password === "")) {
    throw new Error(
      "CAISSE_ENABLED=true exige CAISSE_CYCLOS_LOGIN et CAISSE_CYCLOS_PASSWORD (compte d'écoute Cyclos)",
    );
  }

  // The one place that knows the listener's identity. For the prototype: one
  // merchant, whose credentials come from the environment. In production this
  // is where each merchant's own credentials or access will be looked up.
  config.credentialsFor = (merchantKey) =>
    config.enabled && merchantKey === PROTOTYPE_MERCHANT ? { login, password } : null;

  return Object.freeze(config);
}
