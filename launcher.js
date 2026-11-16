// Start-up of the single executable, for a merchant who is not a technician (see "Exécutable" in README.md).
// What it does, in order: built-in default settings (all can be changed by environment variables), the login
// and the password asked in the window when the environment does not give them (the password is typed hidden
// and kept in memory only: never written to a file, to the log, or to the environment), ONE check of the
// credentials with Cyclos, the server on the local address only, then the page opened in the default browser.
//
// Nothing here is used by "npm start" or "node server.js". The functions take their streams and helpers as
// parameters, so that the tests need no terminal, no network and no browser.

import { spawn as nodeSpawn } from "node:child_process";
import { PushAuthError, PushForbiddenError, PushUnavailableError } from "./cyclos-push.js";

// Address of La Graine 34 on the Cyclos instance, channel of the professional accounts, first port tried.
// None of this is secret.
export const DEFAULTS = Object.freeze({
  baseUrl: "https://laruchedesmonnaieslocales.org/lagraine34/api",
  channel: "main",
  port: 3001,
});
// When the port is not imposed (PORT), the next ones are tried one after the other.
export const PORT_TRIES = 10;

// An error whose message is meant to be shown as it is to the merchant.
export class LaunchError extends Error {}
// The window is not a real console: the password cannot be typed hidden, so it is not asked.
export class NotConsoleError extends LaunchError {}
// Ctrl+C (or end of the input) while typing.
export class CancelledError extends Error {}

export const MESSAGES = Object.freeze({
  notConsole:
    "Ce programme doit être ouvert dans une vraie fenêtre de terminal pour demander le mot de passe sans l'afficher.\n" +
    "Windows : Invite de commandes, PowerShell ou Windows Terminal (pas Git Bash).\n" +
    "Mac et Linux : l'application Terminal.\n" +
    "Le mot de passe n'a pas été demandé.",
  refused:
    "Cyclos a refusé l'identifiant ou le mot de passe.\n" +
    "Le programme ne réessaie pas, pour éviter que Cyclos bloque le compte ou l'adresse.\n" +
    "Vérifiez-les, puis relancez le programme une seule fois. Si le refus continue, contactez La Graine 34.",
  forbidden:
    "Cyclos reconnaît le compte mais n'autorise pas cet accès.\n" +
    "Le programme ne réessaie pas. Contactez La Graine 34.",
  unreachable:
    "Impossible de joindre Cyclos. Vérifiez la connexion internet, puis relancez le programme.",
  busy:
    "Cyclos demande de patienter (trop de demandes). N'insistez pas : attendez quelques minutes avant de relancer le programme.",
  unavailable: (status) =>
    `Cyclos ne répond pas correctement pour le moment${status ? ` (code ${status})` : ""}. ` +
    "Attendez quelques minutes avant de relancer le programme.",
  noAccount:
    "Cyclos n'a pas donné l'identifiant du compte, l'outil ne peut pas s'en servir. Contactez La Graine 34.",
  cancelled: "Annulé.",
  closeAfterError: "Appuyez sur Entrée pour fermer.",
  emptyLogin: "L'identifiant est vide.",
  emptyPassword: "Le mot de passe est vide.",
});

// ---------------------------------------------------------------------------------------------------------------
// Settings

// Reads the settings of the executable from the environment, with the built-in defaults. Throws LaunchError
// (message in French, without any value) when a variable is invalid.
export function readLaunchSettings(env) {
  const baseUrl = (env.CYCLOS_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) {
    throw new LaunchError("CYCLOS_BASE_URL invalide : une adresse commençant par https:// est attendue");
  }
  // Set but empty: no channel (as for the server). Not set: "main".
  const channel = env.CYCLOS_CHANNEL ?? DEFAULTS.channel;
  if (channel !== "" && !/^[A-Za-z0-9_-]{1,32}$/.test(channel)) {
    throw new LaunchError("CYCLOS_CHANNEL invalide : lettres, chiffres, tiret et soulignement uniquement, 32 caractères au maximum");
  }
  let port = DEFAULTS.port;
  const portImposed = env.PORT !== undefined && env.PORT !== "";
  if (portImposed) {
    if (!/^\d{1,5}$/.test(env.PORT) || Number(env.PORT) < 1 || Number(env.PORT) > 65535) {
      throw new LaunchError("PORT invalide : nombre entier de 1 à 65535 attendu");
    }
    port = Number(env.PORT);
  }
  const network = env.CAISSE_OPEN_NETWORK;
  if (network !== undefined && network !== "" && network !== "true" && network !== "false") {
    throw new LaunchError('CAISSE_OPEN_NETWORK invalide : "true" ou "false" attendu');
  }
  const openNetwork = network === "true";
  // Local address only, unless the network is opened on purpose (undefined = every interface).
  return { baseUrl, channel, port, portImposed, openNetwork, host: openNetwork ? undefined : "127.0.0.1" };
}

// ---------------------------------------------------------------------------------------------------------------
// Typing in the window

const isConsole = (input, output) => Boolean(input?.isTTY && output?.isTTY && typeof input.setRawMode === "function");

// Reads one line typed in the window, key by key. `hidden`: nothing is shown (password). Throws NotConsoleError when
// the input is not a real console (never falls back to an echoed password), CancelledError on Ctrl+C or end of input.
export function readLine({ input, output, prompt, hidden = false }) {
  if (!isConsole(input, output)) return Promise.reject(new NotConsoleError(MESSAGES.notConsole));
  return new Promise((resolve, reject) => {
    let value = "";
    let escape = 0; // 1: after ESC, 2: inside an escape sequence (arrow keys...)
    output.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();

    const finish = (done, result) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      done(result);
    };
    const onEnd = () => finish(reject, new CancelledError());
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escape === 1) {
          escape = ch === "[" || ch === "O" ? 2 : 0;
          continue;
        }
        if (escape === 2) {
          if (ch >= "@" && ch <= "~") escape = 0;
          continue;
        }
        if (ch === "\u001b") {
          escape = 1;
        } else if (ch === "\r" || ch === "\n") {
          return finish(resolve, value);
        } else if (ch === "\u0003" || ch === "\u0004") {
          return finish(reject, new CancelledError());
        } else if (ch === "\u007f" || ch === "\b") {
          if (value !== "") {
            value = Array.from(value).slice(0, -1).join("");
            if (!hidden) output.write("\b \b");
          }
        } else if (ch >= " ") {
          value += ch;
          if (!hidden) output.write(ch);
        }
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
  });
}

// Waits for the Enter key, so that a window opened by a double click does not vanish with its message.
// Without a real console there is nothing to wait for.
export async function waitForEnter({ input, output, message = MESSAGES.closeAfterError }) {
  if (!isConsole(input, output)) return;
  try {
    await readLine({ input, output, prompt: `${message} `, hidden: true });
  } catch {
    // Ctrl+C or end of input: closing anyway.
  }
}

// Login, then password, only for what the environment does not give. Empty answers are asked again (no call to
// Cyclos is made here). Returns { login, password }.
export async function askCredentials({ env, input, output }) {
  let login = env.CAISSE_CYCLOS_LOGIN ?? "";
  let password = env.CAISSE_CYCLOS_PASSWORD ?? "";
  if (login.trim() !== "" && password !== "") return { login, password };
  if (!isConsole(input, output)) throw new NotConsoleError(MESSAGES.notConsole);
  while (login.trim() === "") {
    login = (await readLine({ input, output, prompt: "Identifiant : " })).trim();
    if (login === "") output.write(`${MESSAGES.emptyLogin}\n`);
  }
  while (password === "") {
    password = await readLine({ input, output, prompt: "Mot de passe (rien ne s'affiche) : ", hidden: true });
    if (password === "") output.write(`${MESSAGES.emptyPassword}\n`);
  }
  return { login, password };
}

// ---------------------------------------------------------------------------------------------------------------
// The single check of the credentials

// Opens a Cyclos session once, reads the account id, closes the session. Never repeated. Returns null when all
// is well, otherwise the message to show (a fixed text: no login, no password, no address, only a status code).
export async function checkCredentials(push, { login, password }) {
  let token = null;
  try {
    token = await push.createSession(login, password);
    const id = await push.getUserId(token);
    return id ? null : MESSAGES.noAccount;
  } catch (error) {
    if (error instanceof PushAuthError) return MESSAGES.refused;
    if (error instanceof PushForbiddenError) return MESSAGES.forbidden;
    if (error instanceof PushUnavailableError) {
      if (error.status === 429) return MESSAGES.busy;
      if (error.status) return MESSAGES.unavailable(error.status);
      return /^(network error|timeout)/.test(error.message) ? MESSAGES.unreachable : MESSAGES.unavailable();
    }
    return MESSAGES.unavailable();
  } finally {
    if (token) await push.closeSession(token).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Browser

// Command that opens `url` in the default browser. The url is built by this program (local address and port): it
// is passed as an argument, never through a shell. Windows and Linux: written from the documentation, not tested.
export function browserCommand(platform, url) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

// Tries to open the page. Resolves true when the command ran without error, false otherwise (a missing command,
// a non-zero exit): the caller then only shows the address. Never throws.
export function openBrowser(url, { platform = process.platform, spawn = nodeSpawn, waitMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const [command, args] = browserCommand(platform, url);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(true), waitMs);
    timer.unref?.();
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => done(false));
      child.on("exit", (code) => done(code === 0));
      child.unref?.();
    } catch {
      done(false);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Server

// Starts the server on the first free port (or only on the imposed one). `start(options)` is startServer().
export async function listenOnFreePort(start, settings, caisse) {
  const first = settings.port;
  const count = settings.portImposed ? 1 : PORT_TRIES;
  for (let i = 0; i < count; i += 1) {
    try {
      return await start({
        port: first + i,
        host: settings.host,
        cyclosBaseUrl: settings.baseUrl,
        cyclosChannel: settings.channel,
        caisse,
      });
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new LaunchError(
    settings.portImposed
      ? `Le port ${first} est déjà utilisé. Un autre exemplaire du programme est peut-être déjà ouvert.`
      : `Aucun port libre entre ${first} et ${first + count - 1}. Un autre exemplaire du programme est peut-être déjà ouvert.`,
  );
}

// The whole start-up. `deps`: { env, input, output, start (startServer), createPush (settings -> Cyclos client),
// open (url -> Promise<boolean>) }. Returns { code: 0, handle, url } once the server runs, or { code: 1 } after an
// error whose message has been shown (the caller then waits for Enter and exits).
export async function launch({ env, input, output, start, createPush, open }) {
  const say = (text) => output.write(`${text}\n`);
  let settings;
  let credentials;
  try {
    settings = readLaunchSettings(env);
    credentials = await askCredentials({ env, input, output });
  } catch (error) {
    if (error instanceof CancelledError) {
      say(MESSAGES.cancelled);
      return { code: 1, cancelled: true };
    }
    if (error instanceof LaunchError) {
      say(error.message);
      return { code: 1 };
    }
    throw error;
  }

  say("Vérification de l'identifiant auprès de Cyclos...");
  const problem = await checkCredentials(createPush(settings), credentials);
  if (problem) {
    say(problem);
    return { code: 1 };
  }

  let handle;
  try {
    // The credentials go to the server by its options, never by the environment (which programs started later inherit).
    handle = await listenOnFreePort(start, settings, { enabled: true, ...credentials });
  } catch (error) {
    // Invalid CAISSE_* variable (the message names it, never its value) or no free port.
    say(error.message);
    return { code: 1 };
  }
  const url = `http://127.0.0.1:${handle.port}`;
  say(`La caisse est prête : ${url}`);
  if (settings.openNetwork) {
    say("Attention : l'accès est ouvert à tout le réseau local (CAISSE_OPEN_NETWORK=true).");
  }
  say("Laissez cette fenêtre ouverte. Pour arrêter : Ctrl+C, ou fermez la fenêtre.");
  if (!(await open(url))) {
    say(`Le navigateur n'a pas pu être ouvert. Ouvrez vous-même cette adresse : ${url}`);
  }
  return { code: 0, handle, url };
}
