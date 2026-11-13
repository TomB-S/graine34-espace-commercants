// Smoke test of the Cyclos push stream (GET /push/subscribe), run by hand.
//
// Question answered: does the stream accept a SESSION TOKEN (POST /auth/session,
// then the Session-Token header) with the Channel header, and what shape do the
// events have? Until now the stream was only tested from a browser (cookie).
//
// What it prints: HTTP status, content type, how long each connection stayed
// open, event NAMES, and the NAMES of the keys of the data. Never a value:
// no payer, amount, description, id or token. The credentials come from
// environment variables only and are never printed.
//
// Usage (the password is not typed in the command line):
//   read -s CAISSE_PW
//   CAISSE_CYCLOS_LOGIN="..." CAISSE_CYCLOS_PASSWORD="$CAISSE_PW" \
//   CYCLOS_CHANNEL=main CYCLOS_BASE_URL="https://.../api" node push-smoke.js
//   unset CAISSE_PW
//
// Optional: SMOKE_MAX_SECONDS (default 60) = longest wait for one connection.
// To see a payment event, pay the test account while the script listens.

const BASE = (process.env.CYCLOS_BASE_URL ?? "").replace(/\/+$/, "");
const CHANNEL = process.env.CYCLOS_CHANNEL ?? "main";
const LOGIN = process.env.CAISSE_CYCLOS_LOGIN ?? "";
const PASSWORD = process.env.CAISSE_CYCLOS_PASSWORD ?? "";
const MAX_SECONDS = Number(process.env.SMOKE_MAX_SECONDS) > 0 ? Number(process.env.SMOKE_MAX_SECONDS) : 60;

if (!BASE || !LOGIN || !PASSWORD) {
  console.error("Variables manquantes : CYCLOS_BASE_URL, CAISSE_CYCLOS_LOGIN, CAISSE_CYCLOS_PASSWORD");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,32}$/.test(CHANNEL)) {
  console.error("CYCLOS_CHANNEL invalide");
  process.exit(1);
}

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
const channelHeader = { Channel: CHANNEL };

// Only the code of a network error, never the URL or the headers.
function networkCode(error) {
  return error?.cause?.code ?? error?.name ?? "erreur";
}

// Key paths of a JSON value ("notification.date", "items[].id"), no value.
// Anything that does not look like a field name is hidden, in case a key
// carried data.
function keyPaths(value, prefix = "", out = new Set(), depth = 0) {
  if (depth > 5 || value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) keyPaths(item, `${prefix}[]`, out, depth + 1);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${NAME.test(key) ? key : "<cle?>"}` : NAME.test(key) ? key : "<cle?>";
    out.add(path);
    keyPaths(child, path, out, depth + 1);
  }
  return out;
}

// Minimal SSE reader: chunks in, events out. Comments (":...") are counted, not shown.
function sseReader(onEvent, onComment) {
  let buffer = "";
  let current = { event: "", data: [], id: null };
  const flush = () => {
    if (current.data.length > 0 || current.event) onEvent(current);
    current = { event: "", data: [], id: current.id };
  };
  return (text) => {
    buffer += text;
    let index;
    while ((index = buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer.startsWith("\r\n", index) ? 2 : 1));
      if (line === "") flush();
      else if (line.startsWith(":")) onComment(line.slice(1).trim());
      else {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const val = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") current.event = val;
        else if (field === "data") current.data.push(val);
        else if (field === "id") current.id = val;
      }
    }
  };
}

const summary = new Map(); // event name -> { count, keys:Set, jsonFailures }
let lastId = null;

async function openStream(label, clientId, token, lastEventId) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_SECONDS * 1000);
  const headers = { Accept: "text/event-stream", "Session-Token": token, ...channelHeader };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;
  const url = `${BASE}/push/subscribe?clientId=${clientId}&kinds=accountStatus&kinds=newNotification`;

  let response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    console.log(`[${label}] echec reseau : ${networkCode(error)}`);
    return { ok: false };
  }
  console.log(`[${label}] statut HTTP : ${response.status}`);
  console.log(`[${label}] type de contenu : ${response.headers.get("content-type") ?? "(absent)"}`);
  console.log(`[${label}] Last-Event-ID envoye : ${lastEventId ? "oui" : "non"}`);
  if (!response.ok) {
    clearTimeout(timer);
    let code = "";
    try {
      const body = await response.json();
      if (typeof body?.code === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(body.code)) code = body.code;
    } catch {
      // no JSON body
    }
    console.log(`[${label}] code d'erreur Cyclos : ${code || "(aucun)"}`);
    return { ok: false, status: response.status };
  }

  const decoder = new TextDecoder();
  let comments = 0;
  let initialized = false;
  let events = 0;
  const read = sseReader(
    (evt) => {
      events += 1;
      if (evt.id !== null) lastId = evt.id;
      const name = NAME.test(evt.event) ? evt.event : evt.event ? "(nom illisible)" : "(sans nom)";
      const entry = summary.get(name) ?? { count: 0, keys: new Set(), jsonFailures: 0 };
      entry.count += 1;
      try {
        for (const path of keyPaths(JSON.parse(evt.data.join("\n")))) entry.keys.add(path);
      } catch {
        entry.jsonFailures += 1;
      }
      summary.set(name, entry);
    },
    (comment) => {
      comments += 1;
      if (comment === "Initialized") initialized = true;
    },
  );

  let endedBy = "fermeture par Cyclos";
  try {
    for await (const chunk of response.body) read(decoder.decode(chunk, { stream: true }));
  } catch (error) {
    endedBy = error?.name === "AbortError" ? `delai de ${MAX_SECONDS} s atteint (annule par le script)` : `erreur : ${networkCode(error)}`;
  }
  clearTimeout(timer);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[${label}] duree d'ouverture : ${seconds} s (${endedBy})`);
  console.log(`[${label}] commentaire ":Initialized" recu : ${initialized ? "oui" : "non"} (${comments} commentaire(s))`);
  console.log(`[${label}] evenements recus : ${events}`);
  return { ok: true };
}

async function main() {
  // 1. Session token, same call as the server: Basic + Channel.
  const basic = Buffer.from(`${LOGIN}:${PASSWORD}`, "utf-8").toString("base64");
  let token;
  try {
    const response = await fetch(`${BASE}/auth/session`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, ...channelHeader },
    });
    console.log(`POST /auth/session : statut ${response.status}`);
    if (!response.ok) process.exit(2);
    const body = await response.json();
    token = body.sessionToken;
    console.log(`jeton de session recu : ${typeof token === "string" && token ? "oui" : "non"}`);
    console.log(`cles de la reponse (noms seulement) : ${[...keyPaths(body)].filter((k) => !k.includes("permissions") && k.split(".").length <= 2).join(", ")}`);
  } catch (error) {
    console.error(`POST /auth/session : echec reseau : ${networkCode(error)}`);
    process.exit(2);
  }
  if (typeof token !== "string" || !token) process.exit(2);

  // 2. First connection, then a second one with Last-Event-ID (same clientId).
  const clientId = crypto.randomUUID();
  console.log("\nPremiere connexion (faites un paiement vers le compte pendant l'ecoute pour voir un evenement)");
  const first = await openStream("flux 1", clientId, token, null);
  if (first.ok) {
    console.log("\nSeconde connexion, meme clientId");
    console.log(`dernier id d'evenement memorise : ${lastId === null ? "aucun (les evenements n'ont pas d'id)" : "oui"}`);
    await openStream("flux 2", clientId, token, lastId);
  }

  console.log("\nEvenements vus (noms des evenements et noms des cles, aucune valeur) :");
  if (summary.size === 0) console.log("  (aucun evenement pendant l'ecoute)");
  for (const [name, entry] of summary) {
    console.log(`  ${name} : ${entry.count} fois, ${entry.jsonFailures} JSON illisible(s)`);
    console.log(`    cles : ${[...entry.keys].sort().join(", ") || "(aucune)"}`);
  }

  // 3. Close the Cyclos session, errors ignored.
  try {
    const response = await fetch(`${BASE}/auth/session`, {
      method: "DELETE",
      headers: { "Session-Token": token, ...channelHeader },
    });
    console.log(`\nDELETE /auth/session : statut ${response.status}`);
  } catch (error) {
    console.log(`\nDELETE /auth/session : echec reseau : ${networkCode(error)}`);
  }
}

await main();
