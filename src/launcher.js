// Start-up of the single executable, for a merchant who is not a technician (see "Exécutable" in README.md).
// What it does, in order: built-in default settings (all can be changed by environment variables), the server on the
// local address only, then the page opened in the default browser. The login and the password are typed on that page,
// never in the window and never in the environment: they do not pass through this file.
//
// Nothing here is used by "npm start" or "node server.js". The functions take their streams and helpers as
// parameters, so that the tests need no terminal, no network and no browser.

import { spawn as nodeSpawn } from "node:child_process";

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

// Longest life of a page session in the executable (the server's own default is 8 hours).
export const SESSION_MAX_MS = 12 * 3_600_000;

export const MESSAGES = Object.freeze({
  networkRefused:
    "Cette version du programme ne s'ouvre pas au réseau local : CAISSE_OPEN_NETWORK n'est pas accepté.\n" +
    "Retirez cette variable, puis relancez le programme.",
  closeAfterError: "Appuyez sur Entrée pour fermer.",
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
  // Meant for automated checks: the page is not opened, only its address is shown.
  const noBrowser = env.CAISSE_NO_BROWSER;
  if (noBrowser !== undefined && noBrowser !== "" && noBrowser !== "true" && noBrowser !== "false") {
    throw new LaunchError('CAISSE_NO_BROWSER invalide : "true" ou "false" attendu');
  }
  // Local address only, unless the network is opened on purpose (undefined = every interface).
  return { baseUrl, channel, port, portImposed, openNetwork, noBrowser: noBrowser === "true", host: openNetwork ? undefined : "127.0.0.1" };
}

// ---------------------------------------------------------------------------------------------------------------
// Keeping the window open

const isConsole = (input, output) => Boolean(input?.isTTY && output?.isTTY);

// Waits for the Enter key after an error, so that a window opened by a double click does not vanish with its message.
// Nothing typed is read or kept. Without a real console there is nothing to wait for.
export function waitForEnter({ input, output, message = MESSAGES.closeAfterError }) {
  if (!isConsole(input, output)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      input.off("data", done);
      input.off("end", done);
      input.pause();
      resolve();
    };
    output.write(`${message} `);
    input.once("data", done);
    input.once("end", done);
    input.resume();
  });
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

// Starts the server on the first free port (or only on the imposed one). `start(options)` is startServer(). The login is
// typed on the page and starts the listening (option `listenOnLogin`, reserved to this entry point): no credentials are passed.
export async function listenOnFreePort(start, settings) {
  const first = settings.port;
  const count = settings.portImposed ? 1 : PORT_TRIES;
  for (let i = 0; i < count; i += 1) {
    try {
      return await start({
        port: first + i,
        host: settings.host,
        cyclosBaseUrl: settings.baseUrl,
        cyclosChannel: settings.channel,
        listenOnLogin: true,
        maxMs: SESSION_MAX_MS,
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

// ---------------------------------------------------------------------------------------------------------------
// Start-up

// The whole start-up of the executable: nothing is asked in the window. The server starts on the local address, the page
// is opened in the default browser at the plain address, and the merchant types the login there. The credentials never
// pass through this file. `deps`: { env, output, start (startServer), open (url -> Promise<boolean>) }. Returns
// { code: 0, handle, url } once the server runs, or { code: 1 } after an error whose message has been shown (the caller
// then waits for Enter and exits).
export async function launch({ env, output, start, open }) {
  const say = (text) => output.write(`${text}\n`);
  let settings;
  try {
    settings = readLaunchSettings(env);
  } catch (error) {
    if (error instanceof LaunchError) {
      say(error.message);
      return { code: 1 };
    }
    throw error;
  }
  if (settings.openNetwork) {
    say(MESSAGES.networkRefused);
    return { code: 1 };
  }

  let handle;
  try {
    handle = await listenOnFreePort(start, settings);
  } catch (error) {
    say(error.message);
    return { code: 1 };
  }
  const url = `http://127.0.0.1:${handle.port}`;
  say(`La caisse est prête : ${url}`);
  say("Dans la page qui s'ouvre, saisissez votre identifiant et votre mot de passe. Rien n'est demandé dans cette fenêtre.");
  say("Laissez cette fenêtre ouverte. Pour arrêter : Ctrl+C, ou fermez la fenêtre.");
  if (settings.noBrowser) return { code: 0, handle, url };
  if (!(await open(url))) {
    say(`Le navigateur n'a pas pu être ouvert. Ouvrez vous-même cette adresse : ${url}`);
  }
  return { code: 0, handle, url };
}
