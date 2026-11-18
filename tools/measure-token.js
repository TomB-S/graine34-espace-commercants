// Measures how a Cyclos session token behaves, to decide whether the cash register can work without keeping any password.
// Run by hand, with ONE test account. Nothing is written to disk. The password is read from the environment of the terminal
// (MEASURE_PASSWORD), never from a file, never printed, never sent anywhere but to Cyclos.
//
// What it prints: HTTP statuses, delays, numbers of calls, the NAMES of the fields of the login answer, the numeric value of the
// fields that look like a timeout, and the group and role of the account. It never prints the token, the password, a payer, an
// amount or any other body.
//
// Questions answered:
//   1. Silence: how long can a token stay unused before Cyclos refuses it? (one fresh token per silence length)
//   2. Activity: does a call every 60 seconds (like the safety reading of the page) keep a token alive, for how long?
//   3. Stream: does the push stream alone, reopened like the page does, keep a token alive, for how long?
//   4. Several sessions: does a new login of the same account cut the sessions opened before it?
//   5. Logout: does DELETE /auth/session really end the token?
//   6. What the login answer says about the account (group, role), to tell professional accounts from the others.
//
// Cost: 7 logins of the same account. The FIRST one is made alone and checked (reason printed, run stopped when refused); the
// others follow one at a time, 2 seconds apart. Never retried: the run stops at the first refusal of any login, so at most ONE
// failed attempt can reach Cyclos. Then a few calls per minute. Default duration: about 35 minutes.
//
// Usage (see the README of the task for the exact commands):
//   MEASURE_PASSWORD=... MEASURE_LOGIN=... CYCLOS_BASE_URL=... CYCLOS_CHANNEL=main node tools/measure-token.js
// Advanced (optional): MEASURE_MAX_MINUTES (default 35, up to 240), MEASURE_IDLE_MINUTES ("2,5,10,20,30"), MEASURE_POLL_SECONDS (60).
import { randomUUID } from "node:crypto";

const login = process.env.MEASURE_LOGIN ?? "";
const password = process.env.MEASURE_PASSWORD ?? "";
const channel = process.env.CYCLOS_CHANNEL || "main";
const rawBase = process.env.CYCLOS_BASE_URL ?? "";

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!login || !password) fail("Il faut MEASURE_LOGIN et MEASURE_PASSWORD (variables du terminal, jamais dans un fichier).");
let base;
try {
  const url = new URL(rawBase);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
  base = url.href.replace(/\/+$/, "");
} catch {
  fail("CYCLOS_BASE_URL manquante ou invalide (par exemple https://.../api).");
}

const number = (name, fallback, min, max) => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) fail(`${name} invalide : un nombre de ${min} à ${max} attendu.`);
  return parsed;
};
const MAX_MINUTES = number("MEASURE_MAX_MINUTES", 35, 0.1, 240);
const POLL_SECONDS = number("MEASURE_POLL_SECONDS", 60, 1, 600);
const IDLE_MINUTES = (process.env.MEASURE_IDLE_MINUTES ?? "2,5,10,20,30")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((value) => Number.isFinite(value) && value > 0 && value <= MAX_MINUTES);

const started = Date.now();
const stamp = () => {
  const seconds = Math.round((Date.now() - started) / 1000);
  return `[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}]`;
};
const log = (message) => console.log(`${stamp()} ${message}`);
const minutesSince = (since) => ((Date.now() - since) / 60_000).toFixed(1);

// ---- stop (Ctrl+C or first fatal problem): everything pauses, the tokens are closed, the results so far are printed ----
const stop = new AbortController();
let stopping = false;
let stopReason = ""; // always printed in the summary when the run did not end normally
process.once("SIGINT", () => {
  stopping = true;
  stopReason ||= "arrêt demandé (Ctrl+C)";
  stop.abort();
  console.log("\nArrêt demandé : fermeture des sessions et résultats partiels.");
});

// The first fatal problem ends the whole run at once, with its reason printed (once).
function giveUp(reason) {
  if (stopping) return;
  stopping = true;
  stopReason = reason;
  console.log(`${stamp()} ARRÊT : ${reason}`);
  stop.abort();
}

// Whatever happens, a reason is printed: nothing may end the run in silence.
const errorLabel = (error) => {
  const code = error?.cause?.code ?? error?.cause?.errors?.[0]?.code ?? error?.code;
  return `${error?.name ?? "erreur"}${typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ""}`;
};
process.on("uncaughtException", (error) => {
  giveUp(`erreur inattendue du script : ${errorLabel(error)}`);
});
process.on("unhandledRejection", (error) => {
  giveUp(`erreur inattendue du script : ${errorLabel(error)}`);
});

function sleep(ms) {
  return new Promise((resolve) => {
    if (stop.signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    stop.signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      stop.signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

// ---- calls to Cyclos ----
const authHeaders = (token) => ({ "Session-Token": token, Channel: channel });

// The `code` of an error answer when it has a plain shape (the same rule as the server), otherwise "".
async function errorCode(response) {
  return (await errorDetails(response)).code;
}

// What an error answer may say without any risk: its `code` and the other fields whose value is a short plain word
// (userStatus, passwordStatus... are words such as "blocked"). Free texts (message...) and anything that could hold a secret are never read.
const PLAIN_WORD = /^[A-Za-z0-9_.-]{1,60}$/;
const NEVER = /^(message|description|password|token|sessionToken|secret)$/i;
async function errorDetails(response) {
  const details = { code: "", extra: [] };
  try {
    const body = await response.json();
    if (typeof body?.code === "string" && PLAIN_WORD.test(body.code)) details.code = body.code;
    for (const [key, value] of Object.entries(body ?? {})) {
      if (key === "code" || NEVER.test(key) || !PLAIN_WORD.test(key)) continue;
      if ((typeof value === "string" && PLAIN_WORD.test(value)) || typeof value === "boolean" || typeof value === "number") details.extra.push(`${key}=${value}`);
      if (details.extra.length >= 8) break;
    }
  } catch {
    // no JSON body: the status alone is reported
  }
  return details;
}

const PHRASES = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };
const HINTS = {
  401: "identifiants refusés, ou compte bloqué ou inactif chez Cyclos",
  403: "compte connu mais non autorisé à ouvrir une session sur ce canal",
  404: "adresse de l'API incorrecte (vérifier CYCLOS_BASE_URL)",
  429: "Cyclos demande de ralentir",
};
const statusText = (response) => `${response.status} ${response.statusText || PHRASES[response.status] || ""}`.trim();

async function call(path, { method = "GET", headers = {}, timeoutMs = 20_000 } = {}) {
  return fetch(`${base}${path}`, { method, headers, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stop.signal]) });
}

// Logins go one at a time, 2 seconds apart, and none starts once the run is stopping: after a refusal, no other attempt reaches Cyclos.
let loginQueue = Promise.resolve();
let lastLoginAt = 0;
function openSession(label) {
  const attempt = loginQueue.then(async () => {
    if (stopping) throw new Stopped();
    const wait = lastLoginAt + 2000 - Date.now();
    if (wait > 0) await sleep(wait);
    if (stopping) throw new Stopped();
    lastLoginAt = Date.now();
    return login1(label);
  });
  loginQueue = attempt.catch(() => {});
  return attempt;
}

// One login. Never repeated: any refusal stops the whole run (no risk of locking the account or the address).
async function login1(label) {
  const basic = Buffer.from(`${login}:${password}`, "utf-8").toString("base64");
  log(`connexion (${label}) : POST /auth/session, canal ${channel}`);
  let response;
  try {
    response = await call("/auth/session", { method: "POST", headers: { Authorization: `Basic ${basic}`, Channel: channel } });
  } catch (error) {
    if (stopping) throw new Stopped();
    throw new Fatal(`connexion impossible, Cyclos n'a pas répondu : ${errorLabel(error)} (adresse, réseau ou délai)`);
  }
  log(`connexion (${label}) : réponse HTTP ${statusText(response)}`);
  if (!response.ok) {
    const { code, extra } = await errorDetails(response);
    const hint = HINTS[response.status] ?? (response.status >= 500 ? "erreur côté Cyclos" : "refus inattendu");
    throw new Fatal(
      `connexion refusée par Cyclos : HTTP ${statusText(response)}${code ? `, code ${code}` : ""}${extra.length ? `, ${extra.join(", ")}` : ""}. ${hint}. Essai ${label}, aucun nouvel essai.`,
    );
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // answer without a readable body: no token either
  }
  if (typeof body?.sessionToken !== "string" || body.sessionToken === "") {
    throw new Fatal(`connexion acceptée (HTTP ${response.status}) mais la réponse ne contient pas de jeton lisible (champs : ${Object.keys(body ?? {}).sort().join(", ") || "aucun"})`);
  }
  const token = body.sessionToken;
  tokens.add(token);
  return { token, body, headers: response.headers };
}

class Fatal extends Error {}
class Stopped extends Error {}

// A cheap call that needs a valid session. Returns { status, code }.
async function probe(token) {
  const response = await call("/self/accounts", { headers: authHeaders(token) });
  const status = response.status;
  const code = response.ok ? "" : await errorCode(response);
  await response.body?.cancel().catch(() => {});
  return { status, code };
}

const verdict = (result) => (result.status === 200 ? "jeton valide" : `jeton refusé (HTTP ${result.status}${result.code ? ` code=${result.code}` : ""})`);

const tokens = new Set(); // every token opened, closed at the end
const results = []; // [question, answer]
const record = (question, answer) => {
  results.push([question, answer]);
  log(`RÉSULTAT ${question} : ${answer}`);
};

// ---- 6. what the login says about the account ----
const TIMEOUT_KEY = /timeout|expir|valid|duration|idle/i;

function describeLogin({ body, headers }) {
  const keys = Object.keys(body ?? {}).sort();
  log(`réponse de connexion : champs ${keys.join(", ") || "(aucun)"}`);
  for (const [key, value] of Object.entries(body ?? {})) {
    if (TIMEOUT_KEY.test(key) && (typeof value === "number" || typeof value === "string") && String(value).length <= 40) {
      log(`  ${key} = ${value}`);
    }
  }
  const plain = (value) => (typeof value === "string" && value.length <= 80 ? JSON.stringify(value) : null);
  const group = body?.group;
  const groupText = group && typeof group === "object" ? [plain(group.internalName), plain(group.name)].filter(Boolean).join(" / ") : plain(group);
  log(`  groupe : ${groupText || "(absent de la réponse de connexion)"}`);
  log(`  rôle : ${plain(body?.role) ?? (body?.role && typeof body.role === "object" ? [plain(body.role.internalName), plain(body.role.name)].filter(Boolean).join(" / ") : "(absent)")}`);
  const interesting = [...headers.keys()].filter((name) => /version|cyclos/i.test(name));
  for (const name of interesting) log(`  en-tête ${name} = ${String(headers.get(name)).slice(0, 40)}`);
}

async function describeProfile(token) {
  try {
    const response = await call("/users/self?fields=group.internalName,group.name,role", { headers: authHeaders(token) });
    if (!response.ok) {
      log(`profil : HTTP ${response.status} (champs group et role non lisibles par ce chemin)`);
      await response.body?.cancel().catch(() => {});
      return;
    }
    const body = await response.json();
    const plain = (value) => (typeof value === "string" && value.length <= 80 ? JSON.stringify(value) : "(absent)");
    log(`profil /users/self : groupe ${plain(body?.group?.internalName)} / ${plain(body?.group?.name)}, rôle ${typeof body?.role === "string" ? plain(body.role) : "(absent)"}`);
  } catch (error) {
    if (!stopping) log(`profil : lecture impossible (${error?.name ?? "erreur"})`);
  }
}

// ---- 1. silence ----
async function silenceTest(minutes, delayMs) {
  await sleep(delayMs);
  if (stopping) return;
  const { token } = await openSession(`silence ${minutes} min`);
  log(`silence ${minutes} min : jeton ouvert, aucun appel jusqu'à la fin`);
  await sleep(minutes * 60_000);
  if (stopping) return;
  record(`après ${minutes} min sans aucun appel`, verdict(await probe(token)));
}

// ---- 2. activity ----
async function activityTest(first, maxMs) {
  const opened = Date.now();
  let calls = 0;
  while (!stopping && Date.now() - opened < maxMs) {
    await sleep(POLL_SECONDS * 1000);
    if (stopping) break;
    const result = await probe(first.token);
    calls += 1;
    if (calls === 1) {
      record("connexions suivantes du même compte : le premier jeton reste-t-il valide ?", `${verdict(result)} (après ${tokens.size - 1} autre(s) connexion(s))`);
    }
    if (result.status !== 200) {
      record(`un appel toutes les ${POLL_SECONDS} s`, `${verdict(result)} après ${minutesSince(opened)} min et ${calls} appel(s)`);
      return;
    }
  }
  if (!stopping) record(`un appel toutes les ${POLL_SECONDS} s`, `jeton toujours valide après ${minutesSince(opened)} min (${calls} appels)`);
}

// ---- 3. stream only ----
async function streamTest(delayMs, maxMs) {
  await sleep(delayMs);
  if (stopping) return;
  const { token } = await openSession("flux");
  const clientId = randomUUID();
  const opened = Date.now();
  let opens = 0;
  let totalMs = 0;
  let errors = 0;
  while (!stopping && Date.now() - opened < maxMs) {
    const began = Date.now();
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), 75_000);
    try {
      const response = await fetch(`${base}/push/subscribe?clientId=${clientId}&kinds=accountStatus&kinds=newNotification`, {
        headers: { Accept: "text/event-stream", ...authHeaders(token) },
        signal: AbortSignal.any([limit.signal, stop.signal]),
      });
      if (!response.ok) {
        const code = await errorCode(response);
        record("flux de notifications seul, rouvert comme la page le fait", `jeton refusé (HTTP ${response.status}${code ? ` code=${code}` : ""}) après ${minutesSince(opened)} min et ${opens} ouverture(s)`);
        return;
      }
      opens += 1;
      errors = 0;
      for await (const chunk of response.body) {
        void chunk; // the content is not read: only the fact that the stream lives
        if (stopping) break;
      }
      totalMs += Date.now() - began;
    } catch (error) {
      if (stopping) break;
      if (limit.signal.aborted) {
        totalMs += Date.now() - began;
      } else {
        errors += 1;
        log(`flux : erreur réseau (${error?.name ?? "erreur"})`);
        if (errors >= 3) {
          record("flux de notifications seul", `arrêté : 3 erreurs réseau de suite après ${minutesSince(opened)} min`);
          return;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    await sleep(500);
  }
  if (!stopping) {
    const average = opens > 0 ? Math.round(totalMs / opens / 1000) : 0;
    record("flux de notifications seul, rouvert comme la page le fait", `jeton toujours accepté après ${minutesSince(opened)} min (${opens} ouvertures, durée moyenne d'un flux ${average} s)`);
  }
}

// ---- 5. logout ----
async function logoutCheck() {
  const [token] = tokens;
  if (!token) return;
  try {
    const response = await call("/auth/session", { method: "DELETE", headers: authHeaders(token) });
    await response.body?.cancel().catch(() => {});
    const after = await probe(token);
    tokens.delete(token);
    record("après la déconnexion (DELETE /auth/session)", after.status === 200 ? "le jeton fonctionne encore (inattendu)" : `jeton refusé (HTTP ${after.status}), la déconnexion l'invalide bien`);
  } catch (error) {
    log(`contrôle de déconnexion impossible (${error?.name ?? "erreur"})`);
  }
}

async function closeAll() {
  for (const token of tokens) {
    try {
      const response = await fetch(`${base}/auth/session`, { method: "DELETE", headers: authHeaders(token), signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel().catch(() => {});
    } catch {
      // ignored on purpose: the session also ends by itself
    }
  }
  tokens.clear();
}

// ---- run ----
async function main() {
  const maxMs = MAX_MINUTES * 60_000;
  console.log(`Mesure du jeton Cyclos : canal ${channel}, durée maximale ${MAX_MINUTES} min, silences ${IDLE_MINUTES.join(", ") || "(aucun)"} min.`);
  console.log("Ctrl+C pour arrêter à tout moment (les sessions sont fermées et les résultats partiels affichés).\n");

  // Step 1, alone: the first login. If Cyclos refuses it, the run ends here with the reason, and nothing else is tried.
  let first;
  try {
    first = await openSession("premier essai");
  } catch (error) {
    giveUp(error instanceof Fatal ? error.message : `erreur inattendue à la connexion : ${errorLabel(error)}`);
    return;
  }
  describeLogin(first);
  await describeProfile(first.token);

  // Step 2: the measures, with the other sessions opened one at a time.
  const jobs = [activityTest(first, maxMs), streamTest(0, maxMs), ...IDLE_MINUTES.map((minutes) => silenceTest(minutes, 0))];
  const settled = await Promise.allSettled(jobs.map((job) => job.catch((error) => {
    if (!(error instanceof Stopped)) giveUp(error instanceof Fatal ? error.message : `erreur inattendue : ${errorLabel(error)}`);
  })));
  void settled;
}

try {
  await main();
  if (tokens.size > 0 && !stopping) await logoutCheck();
} finally {
  await closeAll();
  console.log("\n=== Résumé ===");
  for (const [question, answer] of results) console.log(`- ${question} : ${answer}`);
  if (results.length === 0) console.log("(aucun résultat)");
  if (stopReason) {
    console.log(`Arrêt : ${stopReason}`);
    process.exitCode = 2;
  }
  console.log("Sessions fermées. Rien n'a été écrit sur le disque.");
}
