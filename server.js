import http from "node:http";
import { realpathSync } from "node:fs";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { readCaisseConfig, PROTOTYPE_MERCHANT } from "./caisse-config.js";
import { createCyclosPush, PushAuthError } from "./cyclos-push.js";
import { describeError } from "./cyclos-listener.js";
import { createListenerManager } from "./listener-manager.js";
import { renderCaissePage, renderCaisseRefused } from "./caisse-page.js";
import { renderCaisseData } from "./caisse-data.js";
import { inExecutable, readAsset } from "./assets.js";


// Cyclos API address. CYCLOS_BASE_URL overrides the public demo (default),
// startServer() can override it again (tests).
const DEFAULT_BASE = "https://demo.cyclos.org/api";
let BASE = baseUrl(process.env.CYCLOS_BASE_URL);
// Optional Cyclos channel, sent as the `Channel` header on every Cyclos call.
// Empty = header not sent (Cyclos' default channel for the API).
// Read and validated by startServer().
let CHANNEL = "";
// Cash register page configuration (CAISSE_* variables), read and validated
// by startServer(). Disabled unless CAISSE_ENABLED=true.
let CAISSE = readCaisseConfig({});
// Cash register runtime ({ push, manager }), created by startServer() when the page is enabled, otherwise null.
let CAISSE_RUNTIME = null;
const PORT = envNumber("PORT", 3001);
const COOKIE = "session";

// Cyclos base URL without trailing slash; empty or missing -> the demo.
function baseUrl(value) {
  return (value || DEFAULT_BASE).replace(/\/+$/, "");
}

// Validated channel name: letters, digits, hyphen, underscore, 32 characters
// at most. Empty or missing -> "" (no header). Anything else throws, so that
// the server refuses to start rather than send an odd header to Cyclos.
function channelName(value) {
  if (value === undefined || value === "") return "";
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
    throw new Error(
      "CYCLOS_CHANNEL invalide : lettres, chiffres, tiret et soulignement uniquement, 32 caractères au maximum",
    );
  }
  return value;
}

// Reads a positive number from the environment, falls back to the default
// when the variable is missing or invalid.
function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Session limits: inactivity delay and absolute maximum hour.
let IDLE_MS = envNumber("SESSION_IDLE_MINUTES", 20) * 60_000;
let MAX_MS = envNumber("SESSION_MAX_HOURS", 8) * 3_600_000;
// Secure cookies only make sense over HTTPS, so this is opt-in (localhost is HTTP).
let COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
let SWEEP_INTERVAL_MS = 60_000;
// Largest accepted POST body.
const MAX_BODY_BYTES = 10_000;
// Login throttling: after LOGIN_MAX_FAILURES failures within LOGIN_WINDOW_MS
// from the same IP address, further attempts get a 429 until the window ends.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

// Login typed on the page that STARTS the listening (single executable only: startServer({ listenOnLogin: true })).
// Rule of one attempt, so that Cyclos never blocks the address or the account:
// - one submitted form = exactly one call to Cyclos, never repeated by the server (not even after a network error);
// - a second form arriving while one is being checked is refused (double click, Enter pressed twice);
// - after a refusal (401): a short pause; after a second refusal in a row: a long one. A success starts over;
// - Cyclos asking to slow down (429): the long pause at once. Any other failure: the short pause.
// The counter is global (every request comes from the same machine). Nothing here holds a login or a password.
const LOGIN_SHORT_PAUSE_MS = 30_000;
const LOGIN_LONG_PAUSE_MS = 15 * 60_000;
let LISTEN_ON_LOGIN = false;
let SHORT_PAUSE_MS = LOGIN_SHORT_PAUSE_MS;
let LONG_PAUSE_MS = LOGIN_LONG_PAUSE_MS;
const pageLogin = { inFlight: false, refusals: 0, lockedUntil: 0 };
// Host header accepted when the login is typed on the page (null = not checked): only this machine's own names.
let ALLOWED_HOSTS = null;

// Local session store: our session id (the cookie value) ->
// { sessionToken, csrfToken, createdAt, lastSeenAt }.
// The Cyclos login and password are never stored: they are used once, in
// POST /connexion, to obtain a Cyclos session token, then dropped.
// A session ends on logout, after IDLE_MS without use, or after MAX_MS in total.
const sessions = new Map();

// Cyclos answered 401: bad credentials, or the session token is no longer valid.
class LoginError extends Error {}

// Cyclos answered 403: the account is known but not allowed to do this.
// This is not a login failure, the local session must be kept.
class AccessDeniedError extends Error {
  // `accountsDenied`: the 403 comes from GET /self/accounts, which is what
  // Cyclos answers to a user who has no money account (not a merchant).
  constructor(message, { accountsDenied = false } = {}) {
    super(message);
    this.accountsDenied = accountsDenied;
  }
}

// Cyclos could not be reached (network error) or answered something this
// server cannot use (5xx...). Shown as 502. Any other exception is a bug in
// this server and is shown as 500.
class CyclosUnavailableError extends Error {}

// A POST body is larger than MAX_BODY_BYTES.
class BodyTooLargeError extends Error {}

// Failed logins per IP address, in memory: ip -> { count, windowStart }.
// NOTE: the address is the one of the TCP peer. Behind a reverse proxy it will
// be the proxy's address, so every user would share one counter (not handled yet).
const loginFailures = new Map();

function loginBlockedUntil(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) return 0;
  return entry.count >= LOGIN_MAX_FAILURES
    ? entry.windowStart + LOGIN_WINDOW_MS
    : 0;
}

function recordLoginFailure(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

// fetch towards Cyclos: a network failure becomes a CyclosUnavailableError
// (message and error code only, the URL and headers are not repeated).
async function cyclosFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    const code = error?.cause?.code ? ` (${error.cause.code})` : "";
    throw new CyclosUnavailableError(`network error${code}`, { cause: error });
  }
}

// One terminal line for a non-2xx Cyclos answer, so that a refusal can be
// diagnosed: method, path (query string dropped: it only holds dates), HTTP
// status and the `code` field of Cyclos' error when it has a plain shape.
// Never the credentials, the token, amounts or the body itself.
async function logCyclosFailure(method, path, response) {
  let code = "";
  try {
    const body = await response.json();
    if (typeof body?.code === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(body.code)) {
      code = ` code=${body.code}`;
    }
  } catch {
    // No JSON body: the status alone is logged.
  }
  console.error(`Cyclos ${method} ${path.split("?")[0]} -> ${response.status}${code}`);
}

// `Channel` header for every Cyclos call, or nothing when no channel is set.
function channelHeader() {
  return CHANNEL ? { Channel: CHANNEL } : {};
}

// Authenticated Cyclos call: the Cyclos session token replaces the password.
async function api(path, sessionToken, options = {}) {
  const response = await cyclosFetch(`${BASE}${path}`, {
    ...options,
    headers: { "Session-Token": sessionToken, ...channelHeader() },
  });

  if (!response.ok) {
    await logCyclosFailure(options.method ?? "GET", path, response);
  }
  if (response.status === 401) {
    throw new LoginError(`401 on ${path}`);
  }
  if (response.status === 403) {
    throw new AccessDeniedError(`403 on ${path}`, {
      accountsDenied: path === "/self/accounts" && !options.method,
    });
  }
  if (!response.ok) {
    throw new CyclosUnavailableError(`${response.status} on ${path}`);
  }

  return response;
}

// Exchanges login + password for a Cyclos session token. Only the token is
// returned: the rest of the response (profile, permissions...) is discarded.
async function createCyclosSession(login, password) {
  // Buffer rather than btoa: btoa throws on accents and other non-Latin1 characters.
  const basic = Buffer.from(`${login}:${password}`, "utf-8").toString("base64");
  const response = await cyclosFetch(`${BASE}/auth/session`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, ...channelHeader() },
  });

  if (!response.ok) await logCyclosFailure("POST", "/auth/session", response);
  if (response.status === 401) {
    throw new LoginError("401 on /auth/session");
  }
  if (response.status === 403) {
    throw new AccessDeniedError("403 on /auth/session");
  }
  if (!response.ok) {
    const error = new CyclosUnavailableError(`${response.status} on /auth/session`);
    error.status = response.status;
    throw error;
  }

  const { sessionToken } = await response.json();
  return sessionToken;
}

// Closes the token on the Cyclos side. Failures are ignored on purpose: the
// local session is already gone, whatever Cyclos answers (network error,
// 401 because the token already expired...).
async function closeCyclosSession(sessionToken) {
  try {
    await api("/auth/session", sessionToken, { method: "DELETE" });
  } catch {
    // ignored on purpose
  }
}
// Static files, read once at startup and served on fixed routes (the CSP
// forbids inline styles, so every page links to /style.css; the logo and the
// fonts are served by us too, no external domain). Public and cacheable,
// unlike the pages (no-store by default), with ETag revalidation (304).
// `cacheControl`: one hour by default; the scripts of the cash register page use "no-cache" (the browser asks again each
// time and gets a 304 when nothing changed), so that a changed script is never hidden by the cache.
function staticAsset(file, contentType, cacheControl = "public, max-age=3600") {
  const body = readAsset(file);
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
  return { body, contentType, etag, cacheControl };
}

// Script of the cash register page and the pure modules it imports (each one is also tested by Node). The only
// scripts the CSP lets run are these, served from our own address.
const BROWSER_MODULES = ["caisse", "caisse-view", "caisse-texts", "new-payments", "date-line", "age", "sound", "sound-logic", "notification", "notification-logic", "controls-logic", "refresh-logic"];

const STATIC_ASSETS = new Map([
  ["GET /style.css", staticAsset("./style.css", "text/css; charset=utf-8")],
  ["GET /logo.png", staticAsset("./logo-lagraine34.png", "image/png")],
  // Square icon: the favicon of the pages and the icon of the notifications (the logo is a wide rectangle).
  ["GET /icon.png", staticAsset("./icon-lagraine34.png", "image/png")],
  ...BROWSER_MODULES.map((name) => [`GET /${name}.js`, staticAsset(`./${name}.js`, "text/javascript; charset=utf-8", "no-cache")]),
  ...[
    "roboto-latin-400-normal",
    "roboto-latin-700-normal",
    "voltaire-latin-400-normal",
  ].map((name) => [
    `GET /fonts/${name}.woff2`,
    staticAsset(`./fonts/${name}.woff2`, "font/woff2"),
  ]),
]);

// Address of the stylesheet in the pages: the hash of its content is part of it, so a changed style.css is
// never hidden by the one-hour cache of the browser (a new content = a new address).
const STYLE_HREF = `/style.css?v=${STATIC_ASSETS.get("GET /style.css").etag.slice(1, -1)}`;

function serveStatic(req, res, asset) {
  const headers = {
    "Cache-Control": asset.cacheControl,
    ETag: asset.etag,
  };
  if (req.headers["if-none-match"] === asset.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": asset.contentType, ...headers });
  res.end(asset.body);
}

// Values come from a remote API (or the user): escape them before putting them in HTML.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// An error message: never conveyed by colour alone (icon + "Erreur :" label).
function errorMessage(text) {
  return `<p class="erreur" role="alert"><span class="icone" aria-hidden="true">⚠</span> <strong>Erreur :</strong> ${text}</p>`;
}

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="/icon.png">
  <link rel="stylesheet" href="${STYLE_HREF}">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <header class="entete">
    <span class="logo"><img src="/logo.png" width="104" height="40" alt="La Graine 34, monnaie locale"></span>
    <span class="nom-outil">Notification de paiement</span>
  </header>
  <div class="page">
  ${body}
  </div>
</body>
</html>`;
}

function renderLoginForm() {
  return htmlPage(
    "Connexion",
    `<h1>Connexion</h1>
  <form method="post" action="/connexion">
    <p><label>Identifiant : <input type="text" name="login" required autofocus></label></p>
    <p><label>Mot de passe : <input type="password" name="password" required></label></p>
    <p><button type="submit">Se connecter</button></p>
  </form>`,
  );
}

function renderLoginFailed() {
  return htmlPage(
    "Connexion échouée",
    `<h1>Connexion échouée</h1>
  ${errorMessage("Identifiant ou mot de passe incorrect.")}
  <p><a href="/">Réessayer</a></p>`,
  );
}

function renderTooManyAttempts(retryAfterSeconds) {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return htmlPage(
    "Trop de tentatives",
    `<h1>Trop de tentatives</h1>
  ${errorMessage(`Trop d'échecs de connexion depuis votre adresse. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.`)}`,
  );
}

function renderForbidden(message, csrfToken) {
  const back = csrfToken
    ? `<p><a href="/caisse">Retour à la caisse</a></p>`
    : `<p><a href="/">Retour</a></p>`;
  return htmlPage(
    "Requête refusée",
    `<h1>Requête refusée</h1>
  ${errorMessage(escapeHtml(message))}
  ${back}`,
  );
}

// Logout is a POST (a link must not be able to log someone out), so it is a
// small form carrying the session's CSRF token.
function logoutForm(csrfToken) {
  return `<form method="post" action="/deconnexion">
    <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
    <button type="submit">Se déconnecter</button>
  </form>`;
}

function renderAccessDenied(csrfToken) {
  const links = csrfToken
    ? `<p><a href="/caisse">Retour</a></p>\n  ${logoutForm(csrfToken)}`
    : `<p><a href="/">Retour</a></p>`;
  return htmlPage(
    "Accès refusé",
    `<h1>Accès refusé</h1>
  ${errorMessage("Votre compte n'a pas l'autorisation d'utiliser cet outil.")}
  ${links}`,
  );
}

// Cyclos refuses (403) or gives nothing (empty list) on GET /self/accounts:
// either no money account, or no banking right for the API session. The
// `signed` adds "+" to positive amounts; negative ones always keep their "-".
function formatAmount(value, digits = 2, { signed = false } = {}) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return String(value);
  const [, minus, integer, decimals = ""] = match;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  const number =
    digits > 0 ? `${grouped},${decimals.padEnd(digits, "0")}` : grouped;
  const isZero = /^[0,\u202f]*$/.test(number);
  if (minus && !isZero) return `-${number}`;
  return signed && !isZero ? `+${number}` : number;
}

function send(res, status, contentType, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": `${contentType}; charset=utf-8`,
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

// Opens the local session for a Cyclos session token (form login) and sends the visitor to /caisse.
// `credentials` ({ login, password }, only when the login starts the listening) live in the session record and nowhere
// else: they disappear with it (logout, 20 minutes without use, maximum duration, refusal by Cyclos).
function openSession(res, sessionToken, credentials = null) {
  const id = randomUUID();
  const now = Date.now();
  sessions.set(id, {
    sessionToken,
    csrfToken: randomBytes(32).toString("hex"),
    createdAt: now,
    lastSeenAt: now,
    ...(credentials ? { credentials } : {}),
  });
  redirect(res, "/caisse", {
    "Set-Cookie": cookieHeader(id, Math.floor(MAX_MS / 1000)),
  });
}

// Credentials for the listener, taken from the freshest live page session of the registered merchant (same Cyclos
// account as the first login). Looked up at each use and never kept elsewhere. null when none is known.
function pageCredentials(merchantKey) {
  const listenerId = CAISSE_RUNTIME?.manager.listenerId;
  if (merchantKey !== PROTOTYPE_MERCHANT || !listenerId) return null;
  const now = Date.now();
  let best = null;
  for (const session of sessions.values()) {
    if (!session.credentials || session.cyclosUserId !== listenerId || isExpired(session, now)) continue;
    if (!best || session.lastSeenAt > best.lastSeenAt) best = session;
  }
  return best ? { login: best.credentials.login, password: best.credentials.password } : null;
}

// Cyclos refused the credentials the listener tried: forget them (their sessions end, the visitors get the form again).
function dropPageCredentials() {
  const listenerId = CAISSE_RUNTIME?.manager.listenerId;
  for (const [id, session] of sessions) {
    if (!session.credentials || session.cyclosUserId !== listenerId) continue;
    sessions.delete(id);
    closeCyclosSession(session.sessionToken);
  }
}

// "30 secondes", "15 minutes": a wait in words, rounded up.
function waitInWords(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds <= 90) return `${seconds} seconde${seconds > 1 ? "s" : ""}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes > 1 ? "s" : ""}`;
}

function renderLoginProblem(title, text, { retry = true } = {}) {
  return htmlPage(
    title,
    `<h1>${escapeHtml(title)}</h1>
  ${errorMessage(escapeHtml(text))}
  ${retry ? `<p><a href="/">Retour au formulaire</a></p>` : ""}`,
  );
}

// POST /connexion when the login starts the listening: the gate of the rule of one attempt (see above), then ONE
// call to Cyclos. The login and the password stay in this function and in the session record, nowhere else (no log, no message).
async function handlePageLogin(res, login, password) {
  const now = Date.now();
  if (pageLogin.inFlight) {
    send(res, 429, "text/html", renderLoginProblem("Connexion en cours", "Une connexion est déjà en cours de vérification. Patientez quelques secondes, sans renvoyer le formulaire."), { "Retry-After": "5" });
    return;
  }
  if (pageLogin.lockedUntil > now) {
    const wait = pageLogin.lockedUntil - now;
    send(res, 429, "text/html", renderLoginProblem("Patientez avant de réessayer", `Pour ne pas bloquer votre compte chez Cyclos, une nouvelle tentative sera possible dans ${waitInWords(wait)}.`), { "Retry-After": String(Math.ceil(wait / 1000)) });
    return;
  }
  if (!login || !password) {
    send(res, 401, "text/html", renderLoginFailed());
    return;
  }

  const pauseFor = (ms) => {
    pageLogin.lockedUntil = Date.now() + ms;
  };
  pageLogin.inFlight = true;
  let sessionToken;
  try {
    sessionToken = await createCyclosSession(login, password);
  } catch (error) {
    if (error instanceof LoginError) {
      pageLogin.refusals += 1;
      const ms = pageLogin.refusals >= 2 ? LONG_PAUSE_MS : SHORT_PAUSE_MS;
      pauseFor(ms);
      send(res, 401, "text/html", renderLoginProblem(
        "Connexion échouée",
        `Identifiant ou mot de passe incorrect. Pour ne pas bloquer votre compte chez Cyclos, une nouvelle tentative sera possible dans ${waitInWords(ms)}. ` +
          (pageLogin.refusals >= 2 ? "Si le refus continue, contactez La Graine 34." : "Vérifiez votre saisie : après un deuxième refus de suite, l'attente sera de 15 minutes."),
      ));
      return;
    }
    if (error instanceof AccessDeniedError) {
      pauseFor(SHORT_PAUSE_MS);
      send(res, 403, "text/html", renderAccessDenied());
      return;
    }
    if (error instanceof CyclosUnavailableError) {
      console.error(`Cyclos injoignable ou en erreur : ${error.message}`);
      const busy = error.status === 429;
      pauseFor(busy ? LONG_PAUSE_MS : SHORT_PAUSE_MS);
      send(res, busy ? 503 : 502, "text/html", renderLoginProblem(
        busy ? "Cyclos demande de patienter" : "Cyclos ne répond pas",
        busy
          ? `Cyclos reçoit trop de demandes. N'insistez pas : réessayez dans ${waitInWords(LONG_PAUSE_MS)}.`
          : `Impossible de joindre Cyclos pour le moment. Vérifiez la connexion internet, puis réessayez dans ${waitInWords(SHORT_PAUSE_MS)}.`,
      ));
      return;
    }
    throw error;
  } finally {
    pageLogin.inFlight = false;
  }

  pageLogin.refusals = 0;
  pageLogin.lockedUntil = 0;
  openSession(res, sessionToken, { login, password });
}

// Reads a POST body as text, refusing anything above `limit` bytes.
// Rejects with BodyTooLargeError, from the declared Content-Length when there
// is one, or while streaming (chunked bodies). Nothing above the limit is kept.
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > limit) {
      req.resume(); // discard what the client sends, keep nothing
      reject(new BodyTooLargeError());
      return;
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return; // keep draining, store nothing
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// POST /connexion has no session yet, hence no CSRF token: check instead that
// the request comes from a page of this server (Origin, or Referer if absent).
function isSameOrigin(req) {
  const source = req.headers.origin ?? req.headers.referer;
  if (!source) return false;
  try {
    return new URL(source).host === req.headers.host;
  } catch {
    return false; // includes the literal "null" origin
  }
}

// Constant-time comparison of the submitted CSRF token with the session's one.
function isValidCsrf(session, submitted) {
  const expected = Buffer.from(session.csrfToken);
  const given = Buffer.from(submitted ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function getSessionId(req) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return null;
}

function isExpired(session, now = Date.now()) {
  return now - session.lastSeenAt > IDLE_MS || now - session.createdAt > MAX_MS;
}

// Removes an expired session and tries to close its Cyclos token (fire and forget).
function expireSession(id, session) {
  sessions.delete(id);
  closeCyclosSession(session.sessionToken);
}

// Returns { id, session } for a valid session cookie, otherwise null.
// An expired session is deleted and treated as absent.
function getSession(req) {
  const id = getSessionId(req);
  const session = id ? sessions.get(id) : undefined;
  if (!session) return null;

  const now = Date.now();
  if (isExpired(session, now)) {
    expireSession(id, session);
    return null;
  }

  session.lastSeenAt = now;
  return { id, session };
}

// Cleanup of expired sessions and of old login-failure counters, run
// periodically by startServer() (and callable directly, tests do).
function sweep(now = Date.now()) {
  for (const [id, session] of sessions) {
    if (isExpired(session, now)) expireSession(id, session);
  }
  for (const [ip, entry] of loginFailures) {
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) loginFailures.delete(ip);
  }
}

function cookieHeader(value, maxAgeSeconds) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${COOKIE_SECURE ? "; Secure" : ""}`;
}

let clearCookie = cookieHeader("", 0);

// What the cash register page needs from this file, given to caisse-page.js.
const CAISSE_HELPERS = { escapeHtml, formatAmount, htmlPage, errorMessage, logoutForm, stylesheetHref: STYLE_HREF };

// What /caisse and /caisse/data share: the session, the identity of the visitor, the registration check and the
// visit (touch) that keeps the listener alive. `fail(kind, session)` answers a refusal in the format of the caller
// (an HTML page, or JSON for the script). The merchant is always deduced from the session, never from the URL.
// Returns { session, view } or null when the answer has been sent.
async function caisseVisit(req, res, fail, { wait = false } = {}) {
  const found = getSession(req);
  if (!found) {
    fail("login");
    return null;
  }
  const { id, session } = found;
  const { push, manager } = CAISSE_RUNTIME;

  // Cyclos user id of the visitor, read once per session (null = could not be read reliably).
  if (session.cyclosUserId === undefined) {
    try {
      session.cyclosUserId = await push.getUserId(session.sessionToken);
    } catch (error) {
      if (error instanceof PushAuthError) {
        // Cyclos no longer accepts the token: drop the local session, like the statement does.
        sessions.delete(id);
        fail("login", session, { "Set-Cookie": clearCookie });
        return null;
      }
      console.error(`Caisse : identité du visiteur illisible : ${describeError(error)}`);
      fail("unavailable", session);
      return null;
    }
    if (session.cyclosUserId === null) console.error("Caisse : identifiant utilisateur du visiteur illisible, accès refusé");
  }

  // The login starts the listening: the first account that logged in is the registered merchant.
  if (LISTEN_ON_LOGIN && session.credentials) manager.bindIdentity(session.cyclosUserId);

  const decision = await manager.authorize(session.cyclosUserId);
  if (!decision.ok) {
    fail(decision.status === 403 ? "denied" : "unavailable", session);
    return null;
  }
  const visit = wait ? await manager.touchAndWait(decision.merchantKey) : manager.touch(decision.merchantKey);
  if (!visit.ok) {
    fail("busy", session);
    return null;
  }
  return { session, view: visit.view };
}

const REFUSAL_STATUS = { denied: 403, unavailable: 503, busy: 503 };

// GET /caisse: the page of payments received (see caisse-page.js and listener-manager.js). Complete without
// script; the reload without script is the <meta refresh> of the page, there is no Refresh header.
async function handleCaisse(req, res) {
  if (!CAISSE_RUNTIME) {
    send(res, 404, "text/plain", "Page introuvable");
    return;
  }
  if (req.method !== "GET") {
    send(res, 405, "text/plain", "Méthode non autorisée", { Allow: "GET" });
    return;
  }
  const visit = await caisseVisit(req, res, (kind, session, headers = {}) => {
    if (kind === "login") {
      redirect(res, "/", headers);
      return;
    }
    send(res, REFUSAL_STATUS[kind], "text/html", renderCaisseRefused(kind, session.csrfToken, CAISSE_HELPERS), kind === "busy" ? { "Retry-After": "30" } : {});
  });
  if (!visit) return;
  send(
    res,
    200,
    "text/html",
    renderCaissePage(
      visit.view,
      {
        refreshSeconds: CAISSE.refreshSeconds,
        pollSeconds: CAISSE.pollSeconds,
        hidePayerName: CAISSE.hidePayerName,
        nameOrder: CAISSE.nameOrder,
        hiddenDescriptions: CAISSE.hiddenDescriptions,
        now: Date.now(),
        csrfToken: visit.session.csrfToken,
      },
      CAISSE_HELPERS,
    ),
  );
}

// GET /caisse/data: the same payments as JSON, for the script of the page (and, later, an app). Same session, same
// registration check, same visit as the page. Errors are JSON with a status the script understands:
// 401 (no session: back to the login page), 403 (not registered), 503 (unavailable or too many listeners).
async function handleCaisseData(req, res) {
  const json = (status, body, headers = {}) => send(res, status, "application/json", JSON.stringify(body), headers);
  if (!CAISSE_RUNTIME) {
    json(404, { error: "Page introuvable" });
    return;
  }
  if (req.method !== "GET") {
    json(405, { error: "Méthode non autorisée" }, { Allow: "GET" });
    return;
  }
  const visit = await caisseVisit(req, res, (kind, session, headers = {}) => {
    if (kind === "login") json(401, { error: "Session expirée" }, headers);
    else json(REFUSAL_STATUS[kind], { error: kind }, kind === "busy" ? { "Retry-After": "30" } : {});
  }, { wait: true });
  if (!visit) return;
  json(200, renderCaisseData(visit.view, { hidePayerName: CAISSE.hidePayerName, nameOrder: CAISSE.nameOrder, hiddenDescriptions: CAISSE.hiddenDescriptions, now: Date.now() }, CAISSE_HELPERS));
}

const server = http.createServer(async (req, res) => {
  // Login typed on the page: only this machine's own names are served. A web page that makes the browser reach this port
  // under another name (DNS rebinding) is refused, before anything is read or any URL is built from the header.
  if (ALLOWED_HOSTS && !ALLOWED_HOSTS.has(String(req.headers.host ?? "").toLowerCase())) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    res.end("Adresse non autorisée");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const route = `${req.method} ${pathname}`;

  // Security headers, on every response. writeHead() later merges its own
  // headers with these.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  // The login page posts to /connexion, whose Origin check needs a usable
  // Origin header: browsers send "Origin: null" on form POSTs under
  // no-referrer, so this one page uses same-origin (still no referrer leaves the site).
  res.setHeader(
    "Referrer-Policy",
    route === "GET /" ? "same-origin" : "no-referrer",
  );
  // Statements must not stay in any cache nor in the back button.
  res.setHeader("Cache-Control", "no-store");
  if (COOKIE_SECURE) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }

  try {
    const asset = STATIC_ASSETS.get(route);
    if (asset) {
      serveStatic(req, res, asset);
      return;
    }

    // The cash register page answers on one path whatever the method (405, or 404 when disabled).
    if (pathname === "/caisse") {
      await handleCaisse(req, res);
      return;
    }
    if (pathname === "/caisse/data") {
      await handleCaisseData(req, res);
      return;
    }

    switch (route) {
      case "GET /":
        send(res, 200, "text/html", renderLoginForm());
        return;

      case "POST /connexion": {
        if (!isSameOrigin(req)) {
          send(
            res,
            403,
            "text/html",
            renderForbidden("Origine de la requête non autorisée."),
          );
          return;
        }

        if (LISTEN_ON_LOGIN) {
          const typed = new URLSearchParams(await readBody(req));
          await handlePageLogin(res, typed.get("login") ?? "", typed.get("password") ?? "");
          return;
        }

        const ip = req.socket.remoteAddress ?? "unknown";
        const blockedUntil = loginBlockedUntil(ip);
        if (blockedUntil) {
          const retryAfter = Math.ceil((blockedUntil - Date.now()) / 1000);
          send(res, 429, "text/html", renderTooManyAttempts(retryAfter), {
            "Retry-After": String(retryAfter),
          });
          return;
        }

        const form = new URLSearchParams(await readBody(req));
        const login = form.get("login") ?? "";
        const password = form.get("password") ?? "";

        if (!login || !password) {
          send(res, 401, "text/html", renderLoginFailed());
          return;
        }

        let sessionToken;
        try {
          // Checks the credentials and returns a Cyclos session token.
          sessionToken = await createCyclosSession(login, password);
        } catch (error) {
          if (error instanceof LoginError) {
            recordLoginFailure(ip);
            send(res, 401, "text/html", renderLoginFailed());
            return;
          }
          if (error instanceof AccessDeniedError) {
            send(res, 403, "text/html", renderAccessDenied());
            return;
          }
          throw error;
        }

        openSession(res, sessionToken);
        return;
      }

      case "POST /deconnexion": {
        const session = getSession(req);
        if (!session) {
          // Nothing to close locally; just make sure the cookie is gone.
          redirect(res, "/", { "Set-Cookie": clearCookie });
          return;
        }

        const form = new URLSearchParams(await readBody(req));
        if (!isValidCsrf(session.session, form.get("csrf"))) {
          send(
            res,
            403,
            "text/html",
            renderForbidden(
              "Jeton de sécurité absent ou invalide. La session n'a pas été fermée.",
              session.session.csrfToken,
            ),
          );
          return;
        }

        sessions.delete(session.id);
        // Close the token on the Cyclos side too, then log out locally either way.
        await closeCyclosSession(session.session.sessionToken);
        redirect(res, "/", { "Set-Cookie": clearCookie });
        return;
      }

      case "GET /deconnexion":
        // Logging out must not be triggerable by a simple link or image.
        send(
          res,
          405,
          "text/plain",
          "Méthode non autorisée : la déconnexion se fait par POST",
          {
            Allow: "POST",
          },
        );
        return;

      default:
        send(res, 404, "text/plain", "Page introuvable");
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      send(res, 413, "text/plain", "Requête trop volumineuse", {
        Connection: "close",
      });
      return;
    }
    if (error instanceof CyclosUnavailableError) {
      console.error(`Cyclos injoignable ou en erreur : ${error.message}`);
      send(res, 502, "text/plain", "Impossible de joindre Cyclos");
      return;
    }
    // An exception of this server's own code (not a Cyclos or network problem).
    console.error("Erreur interne du serveur :", error?.stack ?? error);
    send(
      res,
      500,
      "text/plain",
      "Erreur interne du serveur. Consultez le journal du serveur pour le détail.",
    );
  }
});

// Starts the server and resolves with { port, close, sweep }. Nothing starts
// on import. State (sessions, login failures) is per process: one server at a
// time, and it starts empty. `options` (all optional) are meant for tests:
// port (0 = any free port), host, cyclosBaseUrl, cookieSecure, idleMs, maxMs,
// sweepIntervalMs, cyclosChannel, caisse (overrides of the CAISSE_* settings), caisseHooks (options of the
// listeners and processors). Defaults are the environment variables.
export function startServer(options = {}) {
  if (server.listening) {
    return Promise.reject(new Error("Le serveur est déjà démarré"));
  }
  if (options.listenOnLogin && !["127.0.0.1", "::1", "localhost"].includes(options.host)) {
    // Local address only: the password typed on the page must not cross a network.
    return Promise.reject(new Error("La connexion qui démarre l'écoute exige l'écoute locale"));
  }
  try {
    CHANNEL = channelName(options.cyclosChannel ?? process.env.CYCLOS_CHANNEL);
    CAISSE = options.listenOnLogin
      ? readCaisseConfig(process.env, { ...options.caisse, enabled: true, credentialsFromLogin: true })
      : readCaisseConfig(process.env, options.caisse);
  } catch (error) {
    return Promise.reject(error);
  }
  LISTEN_ON_LOGIN = Boolean(options.listenOnLogin);
  if (LISTEN_ON_LOGIN) {
    // The only difference with the hosted mode: where the listener's credentials come from.
    CAISSE = Object.freeze({ ...CAISSE, credentialsFor: pageCredentials, credentialsRefused: dropPageCredentials });
    SHORT_PAUSE_MS = options.loginPauseMs ?? LOGIN_SHORT_PAUSE_MS;
    LONG_PAUSE_MS = options.loginLongPauseMs ?? LOGIN_LONG_PAUSE_MS;
    Object.assign(pageLogin, { inFlight: false, refusals: 0, lockedUntil: 0 });
  }
  ALLOWED_HOSTS = null;
  BASE = baseUrl(options.cyclosBaseUrl ?? process.env.CYCLOS_BASE_URL);
  COOKIE_SECURE = options.cookieSecure ?? process.env.COOKIE_SECURE === "true";
  IDLE_MS = options.idleMs ?? envNumber("SESSION_IDLE_MINUTES", 20) * 60_000;
  MAX_MS = options.maxMs ?? envNumber("SESSION_MAX_HOURS", 8) * 3_600_000;
  SWEEP_INTERVAL_MS = options.sweepIntervalMs ?? 60_000;
  clearCookie = cookieHeader("", 0);
  sessions.clear();
  loginFailures.clear();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? PORT, options.host, () => {
      server.off("error", reject);
      if (LISTEN_ON_LOGIN) {
        const { port } = server.address();
        ALLOWED_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      }
      const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
      timer.unref();
      if (CAISSE.enabled) {
        const push = createCyclosPush({ baseUrl: BASE, channel: CHANNEL });
        CAISSE_RUNTIME = { push, manager: createListenerManager({ config: CAISSE, push, ...options.caisseHooks }) };
      }
      resolve({
        port: server.address().port,
        sweep,
        caisseEnabled: CAISSE.enabled,
        async close() {
          clearInterval(timer);
          ALLOWED_HOSTS = null;
          LISTEN_ON_LOGIN = false;
          // Listeners first: streams cut, Cyclos sessions closed, tickets forgotten.
          const runtime = CAISSE_RUNTIME;
          CAISSE_RUNTIME = null;
          await runtime?.manager.stopAll();
          return new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

// Pure functions exported for the unit tests.
export { escapeHtml, formatAmount };

// Starts the server from the command line: a clear line on a configuration error, then a clean stop on a signal.
export async function runFromCommandLine() {
  let port;
  let handle;
  try {
    handle = await startServer();
    ({ port } = handle);
  } catch (error) {
    // Configuration error (CYCLOS_CHANNEL...): a clear line, no stack trace.
    console.error(error.message);
    process.exit(1);
  }
  console.log(`Serveur démarré sur http://localhost:${port}`);
  // The value was validated by startServer(); nothing else is printed.
  console.log(`Canal Cyclos : ${process.env.CYCLOS_CHANNEL || "(par defaut)"}`);
  if (handle.caisseEnabled) {
    console.log("Caisse : activée, page /caisse");
    // Stop cleanly: listening streams cut and Cyclos sessions closed, then exit.
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, async () => {
        await handle.close();
        process.exit(0);
      });
    }
  }
}

// "node server.js" starts the server as before; importing the file does not (the executable starts it from main.js).
if (
  !inExecutable &&
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  runFromCommandLine();
}
