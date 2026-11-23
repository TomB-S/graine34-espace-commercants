// Builds the single executable of the current platform: npm run build:exe (see "Exécutable" in README.md).
// The executable is made from a Node 25.5 or later, which provides --build-sea. If the Node that runs npm is older,
// give the path of a suitable one in SEA_NODE.
// 1. esbuild (development tool only) gathers src/main.js, the server modules and luxon into build/server.cjs;
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

// The statement of transactions (/espace/releve) exists in the multi-merchant mode only, which the executable never has. Its PDF
// module and pdfkit (which reads its own files from disk, and the logo through import.meta.url) are left out of the bundle: server.js
// loads them on demand, which never happens here.
const leaveOutStatementPdf = {
  name: "leave-out-statement-pdf",
  setup(b) {
    b.onResolve({ filter: /(^|\/)releve-pdf\.js$|^pdfkit(\/|$)/ }, (args) => ({ path: args.path, external: true }));
  },
};

const bundle = await build({
  entryPoints: ["src/main.js"],
  outfile: "build/server.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // Never evaluated in the executable (the static files come from the embedded assets).
  define: { "import.meta.url": "undefined" },
  plugins: [leaveOutStatementPdf],
  metafile: true,
  logLevel: "warning",
});

// A guard, not a hope: the build stops if the PDF code or pdfkit got into the executable all the same.
const leaked = Object.keys(bundle.metafile.inputs).filter((file) => /pdfkit|releve-pdf/.test(file));
if (leaked.length > 0) {
  console.error(`Le PDF du relevé ne doit pas être dans l'exécutable, mais le build contient : ${leaked.join(", ")}`);
  process.exit(1);
}

// Names relative to web/: the same ones the server asks for (see src/assets.js).
const browserScripts = [
  "caisse", "caisse-view", "caisse-texts", "new-payments", "date-line", "age", "sound",
  "sound-logic", "notification", "notification-logic", "controls-logic", "refresh-logic", "print-ticket",
].map((name) => `js/${name}.js`);
const output = platform() === "win32" ? "build/graine34-notif-caisse.exe" : "build/graine34-notif-caisse";
const assets = Object.fromEntries(
  [
    "style.css",
    "images/logo-lagraine34.png",
    "images/icon-lagraine34.png",
    ...readdirSync("web/fonts").filter((f) => f.endsWith(".woff2")).map((f) => `fonts/${f}`),
    ...browserScripts,
  ].map((name) => [name, `web/${name}`]),
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
