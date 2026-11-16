// Builds the single executable of the current platform: npm run build:exe (see "Exécutable" in README.md).
// The executable is made from a Node 25.5 or later, which provides --build-sea. If the Node that runs npm is older,
// give the path of a suitable one in SEA_NODE.
// 1. esbuild (development tool only) gathers main.js, the server modules and luxon into build/server.cjs;
// 2. the static files are listed as assets of the executable;
// 3. "node --build-sea" writes build/graine34-notif-caisse (build/graine34-notif-caisse.exe on Windows);
// 4. on macOS, the result gets an ad hoc signature, without which the system kills it at launch.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";

const seaNode = process.env.SEA_NODE || process.execPath;
const version = execFileSync(seaNode, ["--version"], { encoding: "utf8" }).trim();
const [major, minor] = version.slice(1).split(".").map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  console.error(`${seaNode} est en ${version} : il faut Node 25.5 ou plus récent. Indiquer son chemin dans SEA_NODE.`);
  process.exit(1);
}

mkdirSync("build", { recursive: true });

await build({
  entryPoints: ["main.js"],
  outfile: "build/server.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // Never evaluated in the executable (the static files come from the embedded assets).
  define: { "import.meta.url": "undefined" },
  logLevel: "warning",
});

const browserScripts = [
  "caisse", "caisse-view", "caisse-texts", "new-payments", "date-line", "age", "sound",
  "sound-logic", "notification", "notification-logic", "controls-logic", "refresh-logic",
].map((name) => `${name}.js`);
const output = platform() === "win32" ? "build/graine34-notif-caisse.exe" : "build/graine34-notif-caisse";
const assets = Object.fromEntries(
  [
    "style.css",
    "logo-lagraine34.png",
    "icon-lagraine34.png",
    ...readdirSync("fonts").filter((f) => f.endsWith(".woff2")).map((f) => `fonts/${f}`),
    ...browserScripts,
  ].map((name) => [name, name]),
);

writeFileSync(
  "build/sea-config.json",
  JSON.stringify({ main: "build/server.cjs", output, assets, disableExperimentalSEAWarning: true }, null, 2),
);

execFileSync(seaNode, ["--build-sea", "build/sea-config.json"], { stdio: "inherit" });

if (platform() === "darwin") {
  execFileSync("codesign", ["--force", "--sign", "-", output], { stdio: "inherit" });
}
console.log(`Exécutable prêt : ${output}`);
