// Start-up check of the executable: node tools/smoke-exe.js [path-of-the-executable] (see "Exécutable" in README.md).
// Starts the executable without opening a browser (CAISSE_NO_BROWSER), waits for the login page and one embedded static
// file to answer on the local port, then stops the program. No login, no password, no call to Cyclos: only two GET
// requests on 127.0.0.1. Works the same on Windows, macOS and Linux. Exit code 0 when everything answered, 1 otherwise.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 3101; // imposed, away from the usual 3001, so that a program already open on a developer's machine does not interfere
const BASE = `http://127.0.0.1:${PORT}`;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

const defaultPath = platform() === "win32" ? "build/graine34-notif-caisse.exe" : "build/graine34-notif-caisse";
const exe = process.argv[2] || defaultPath;

if (!existsSync(exe)) {
  console.error(`Exécutable introuvable : ${exe}`);
  process.exit(1);
}

// Environment of the program: nothing of the project's settings is inherited, only what the system needs.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(CAISSE_|CYCLOS_|PORT$|SESSION_|COOKIE_SECURE$)/.test(name)),
);
env.PORT = String(PORT);
env.CAISSE_NO_BROWSER = "true";

let output = "";
const child = spawn(exe, [], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
let exited = false;
let exitInfo = "";
child.on("exit", (code, signal) => {
  exited = true;
  exitInfo = `code ${code}, signal ${signal}`;
});
child.on("error", (error) => {
  exited = true;
  exitInfo = `erreur de lancement : ${error.code ?? error.message}`;
});

async function get(path) {
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(3_000) });
  return { status: response.status, text: await response.text() };
}

// Waits until `check` returns without throwing, or until the start-up delay is over, or until the program has stopped.
async function waitFor(label, check) {
  const limit = Date.now() + START_TIMEOUT_MS;
  let last = "pas de réponse";
  while (Date.now() < limit) {
    if (exited) throw new Error(`le programme s'est arrêté (${exitInfo}) avant de répondre`);
    try {
      await check();
      return;
    } catch (error) {
      last = error.message;
    }
    await sleep(300);
  }
  throw new Error(`${label} : pas de réponse correcte en ${START_TIMEOUT_MS / 1000} s (${last})`);
}

async function stop() {
  if (exited) return;
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM"); // on Windows, ends the process
  const stopped = await Promise.race([done.then(() => true), sleep(STOP_TIMEOUT_MS).then(() => false)]);
  if (!stopped) {
    child.kill("SIGKILL");
    await Promise.race([done, sleep(STOP_TIMEOUT_MS)]);
  }
}

let failure = null;
try {
  await waitFor("page de connexion", async () => {
    const { status, text } = await get("/");
    if (status !== 200) throw new Error(`statut ${status}`);
    if (!text.includes('action="/connexion"') || !text.includes('type="password"')) throw new Error("formulaire de connexion absent");
  });
  console.log("Page de connexion : 200, formulaire présent.");
  const css = await get("/style.css");
  if (css.status !== 200 || css.text.length === 0) throw new Error(`fichier intégré /style.css : statut ${css.status}`);
  console.log("Fichier intégré /style.css : 200.");
} catch (error) {
  failure = error;
}

await stop();

if (failure) {
  console.error(`ÉCHEC du contrôle de démarrage : ${failure.message}`);
  console.error("--- sortie du programme ---");
  console.error(output.trim() || "(aucune)");
  process.exit(1);
}
console.log("Contrôle de démarrage réussi, programme arrêté.");
process.exit(0);
