// The script file itself (caisse.js), run in Node with stand-ins for the browser (document, fetch, location, timers).
// Intention: it reads /caisse/data on its rhythm, keeps reading when the tab is hidden, reads at once when the tab comes back, shows the
// "Connexion au serveur interrompue." banner when the network fails, goes back to the login page on 401, and detects no new payment on the
// first load. The elements themselves are checked in caisse-view.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

class Node {
  constructor() {
    this.className = "";
    this.hidden = false;
    this.children = [];
    this.own = "";
    this.attributes = {};
  }
  set textContent(value) {
    this.children = [];
    this.own = String(value);
  }
  get textContent() {
    return this.own + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(type, fn) {
    this.listeners = { ...this.listeners, [type]: fn };
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
    this.own = "";
  }
}

async function run(responses, audio = null, notif = null) {
  const nodes = new Map();
  for (const id of ["caisse-zone-direct", "caisse-zone-etat", "caisse-zone-contenu", "caisse-zone-son", "caisse-zone-notif", "caisse-actualisation"]) nodes.set(id, new Node());
  const root = new Node();
  root.dataset = { pollSeconds: "3", dataUrl: "/caisse/data", loginUrl: "/" };
  nodes.set("caisse", root);
  const listeners = {};
  const timers = [];
  const calls = [];
  const seen = { assigned: [], reloaded: 0, focused: 0 };
  const saved = {};
  const set = (name, value) => {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  const document = {
    visibilityState: "hidden",
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: () => new Node(),
    addEventListener: (type, fn) => (listeners[type] = fn),
  };
  set("document", document);
  set("window", { addEventListener: (type, fn) => (listeners[`window:${type}`] = fn), AudioContext: audio?.AudioContext, Notification: notif?.Notification, isSecureContext: notif?.secure ?? true, focus: () => (seen.focused += 1) });
  set("location", { assign: (url) => seen.assigned.push(url), reload: () => (seen.reloaded += 1) });
  set("setTimeout", (fn, ms) => timers.push({ fn, ms }) - 1);
  set("clearTimeout", () => {});
  set("setInterval", (fn, ms) => timers.push({ fn, ms, every: true }) - 1);
  set("fetch", async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  await import(`../caisse.js?run=${Math.random()}`);
  await flush();
  const restore = () => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  return { nodes, document, listeners, timers, calls, seen, restore };
}

const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const ticket = (n, extra = {}) => ({ keys: [`k${n}`], initial: false, payer: `P${n}`, amount: `${n},00 G`, amountReady: true, time: "12:00", dateLabel: "Aujourd'hui 12:00", at: Date.now(), description: "", number: "", isNew: false, ...extra });
const data = (tickets) => ({ status: "live", banner: null, now: Date.now(), tickets });

test("script : lit /caisse/data sans cache, enchaîne la lecture suivante toutes les N secondes, même onglet caché", async () => {
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(1)])), ok(data([ticket(1)]))]);
  try {
    assert.equal(page.calls[0].url, "/caisse/data");
    assert.equal(page.calls[0].init.cache, "no-store");
    assert.equal(page.calls[0].init.credentials, "same-origin");
    const next = page.timers.filter((t) => !t.every && t.ms === 3000);
    assert.equal(next.length, 1, "next read planned in 3 s");
    // The tab is hidden (document.visibilityState === "hidden"): the chain goes on all the same.
    next[0].fn();
    await flush();
    assert.equal(page.calls.length, 2);
    assert.equal(page.timers.filter((t) => !t.every && t.ms === 3000).length, 2);
    assert.match(page.nodes.get("caisse-zone-contenu").textContent, /P1/);
    assert.ok(page.timers.some((t) => t.every && t.ms === 15_000), "age worked out again every 15 s");
  } finally {
    page.restore();
  }
});

test("script : au retour au premier plan, relit tout de suite ; caché, ne relit pas en plus", async () => {
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(1)]))]);
  try {
    assert.equal(page.calls.length, 1);
    page.document.visibilityState = "hidden";
    page.listeners.visibilitychange();
    await flush();
    assert.equal(page.calls.length, 1, "hiding the tab triggers nothing");
    page.document.visibilityState = "visible";
    page.listeners.visibilitychange();
    await flush();
    assert.equal(page.calls.length, 2, "back to the foreground: read at once");
  } finally {
    page.restore();
  }
});

test("script : réseau coupé = bannière « Connexion au serveur interrompue. », affichage conservé, puis retour à la normale", async () => {
  const page = await run([ok(data([ticket(1)])), new TypeError("fetch failed"), ok(data([ticket(1)]))]);
  try {
    const timerOf = () => page.timers.filter((t) => !t.every && t.ms === 3000).at(-1);
    timerOf().fn();
    await flush();
    assert.match(page.nodes.get("caisse-zone-etat").textContent, /Connexion au serveur interrompue\./);
    assert.match(page.nodes.get("caisse-zone-contenu").textContent, /P1/, "display kept");
    assert.ok(timerOf(), "keeps trying");
    timerOf().fn();
    await flush();
    assert.equal(page.nodes.get("caisse-zone-etat").textContent, "");
  } finally {
    page.restore();
  }
});

test("script : 401 = retour à la page de connexion ; 403 = rechargement (la page explique le refus)", async () => {
  const expired = await run([{ ok: false, status: 401, json: async () => ({}) }]);
  try {
    assert.deepEqual(expired.seen.assigned, ["/"]);
  } finally {
    expired.restore();
  }
  const denied = await run([{ ok: false, status: 403, json: async () => ({}) }]);
  try {
    assert.equal(denied.seen.reloaded, 1);
  } finally {
    denied.restore();
  }
});

test("script : une erreur 503 du serveur est traitée comme une coupure (bannière, affichage conservé)", async () => {
  const page = await run([ok(data([ticket(1)])), { ok: false, status: 503, json: async () => ({}) }]);
  try {
    page.timers.filter((t) => !t.every && t.ms === 3000).at(-1).fn();
    await flush();
    assert.match(page.nodes.get("caisse-zone-etat").textContent, /Connexion au serveur interrompue\./);
  } finally {
    page.restore();
  }
});

test("script : le premier chargement n'affiche pas le fond « nouveau », un paiement arrivé ensuite l'affiche", async () => {
  const page = await run([ok(data([ticket(1, { isNew: true })])), ok(data([ticket(2, { isNew: true }), ticket(1, { isNew: true })]))]);
  try {
    const bigClass = () => page.nodes.get("caisse-zone-contenu").children[0].children[0].className;
    assert.equal(bigClass(), "caisse-gros", "first load: nothing detected, no fade");
    page.timers.filter((t) => !t.every && t.ms === 3000).at(-1).fn();
    await flush();
    assert.equal(bigClass(), "caisse-gros caisse-gros-neuf");
  } finally {
    page.restore();
  }
});

// ---- the sound ----

// A stand-in for the AudioContext: counts the notes played. `behaviour.state` is what resume() leaves the context in.
function fakeAudio(behaviour = { state: "running" }) {
  const audio = { created: 0, notes: 0, contexts: [] };
  audio.AudioContext = class {
    constructor() {
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
      audio.created += 1;
      audio.contexts.push(this);
    }
    async resume() {
      this.state = behaviour.state;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
    }
    createOscillator() {
      return { frequency: {}, connect() {}, start: () => (audio.notes += 1), stop() {} };
    }
  };
  return audio;
}

const soundLine = (page) => page.nodes.get("caisse-zone-son").children[0].children[1].textContent;
const soundButton = (page) => page.nodes.get("caisse-zone-son").children[0].children[0];
const nextRead = (page) => page.timers.filter((t) => !t.every && t.ms === 3000).at(-1).fn();

test("son : démarre désactivé à chaque chargement, aucun AudioContext créé avant un clic, aucun bip", async () => {
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2, { isNew: true }), ticket(1)]))], audio);
  try {
    assert.match(soundLine(page), /Son désactivé : cliquer pour activer/);
    assert.equal(soundButton(page).textContent, "Activer le son");
    nextRead(page);
    await flush();
    assert.equal(audio.created, 0, "no audio context without a click");
    assert.equal(audio.notes, 0, "a new payment with the sound off rings nothing");
  } finally {
    page.restore();
  }
});

test("son : le clic active (bip d'essai), puis un seul bip par lot de nouveaux paiements, jamais au premier chargement", async () => {
  const audio = fakeAudio();
  const page = await run(
    [ok(data([ticket(1, { isNew: true })])), ok(data([ticket(1)])), ok(data([ticket(4), ticket(3), ticket(2), ticket(1)])), ok(data([ticket(4), ticket(3), ticket(2), ticket(1)]))],
    audio,
  );
  try {
    soundButton(page).listeners.click();
    await flush();
    assert.equal(audio.created, 1);
    assert.equal(audio.notes, 2, "the test bip: two notes");
    assert.match(soundLine(page), /^Son activé/);
    assert.equal(soundButton(page).textContent, "Couper le son");
    const afterTest = audio.notes;
    nextRead(page); // same payments: nothing new
    await flush();
    assert.equal(audio.notes, afterTest);
    nextRead(page); // three payments at once: one bip
    await flush();
    assert.equal(audio.notes, afterTest + 2, "one bip (two notes) for a batch of three");
    nextRead(page); // nothing new
    await flush();
    assert.equal(audio.notes, afterTest + 2);
  } finally {
    page.restore();
  }
});

test("son : le premier chargement ne sonne pas même si le son a été activé avant la réponse", async () => {
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1, { isNew: true })]))], audio);
  try {
    soundButton(page).listeners.click();
    await flush();
    assert.equal(audio.notes, 2, "only the test bip");
  } finally {
    page.restore();
  }
});

test("son : audio suspendu par le navigateur = jamais « Son activé », pas de bip", async () => {
  const audio = fakeAudio({ state: "suspended" });
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], audio);
  try {
    soundButton(page).listeners.click();
    await flush();
    assert.match(soundLine(page), /Son désactivé : cliquer pour activer/);
    assert.ok(!/Son activé/.test(soundLine(page)));
    nextRead(page);
    await flush();
    assert.equal(audio.notes, 0);
  } finally {
    page.restore();
  }
});

test("son : si le navigateur suspend l'audio après l'activation, l'état le dit et le bip est évité", async () => {
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], audio);
  try {
    soundButton(page).listeners.click();
    await flush();
    assert.match(soundLine(page), /^Son activé/);
    audio.contexts[0].state = "suspended";
    audio.contexts[0].onstatechange();
    assert.match(soundLine(page), /Son désactivé : cliquer pour activer/);
    const notes = audio.notes;
    nextRead(page);
    await flush();
    assert.equal(audio.notes, notes, "no bip while the audio is suspended");
  } finally {
    page.restore();
  }
});

test("son : le bouton coupe le son", async () => {
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], audio);
  try {
    soundButton(page).listeners.click();
    await flush();
    soundButton(page).listeners.click();
    await flush();
    assert.match(soundLine(page), /Son désactivé/);
    const notes = audio.notes;
    nextRead(page);
    await flush();
    assert.equal(audio.notes, notes);
  } finally {
    page.restore();
  }
});

test("son : navigateur sans Web Audio = message clair, pas de bouton, la page fonctionne", async () => {
  const page = await run([ok(data([ticket(1)]))]);
  try {
    assert.match(soundLine(page), /Son non disponible sur ce navigateur/);
    assert.equal(soundButton(page).hidden, true);
    assert.match(page.nodes.get("caisse-zone-contenu").textContent, /P1/);
  } finally {
    page.restore();
  }
});

// ---- the notifications ----

function fakeNotifications({ permission = "default", answer = "granted", secure = true } = {}) {
  const notif = { requested: 0, shown: [], secure };
  notif.Notification = class {
    static permission = permission;
    static async requestPermission() {
      notif.requested += 1;
      notif.Notification.permission = answer;
      return answer;
    }
    constructor(title, options) {
      this.title = title;
      this.options = options;
      notif.shown.push(this);
    }
    close() {}
  };
  return notif;
}

const notifLine = (page) => page.nodes.get("caisse-zone-notif").children[0].children[1].textContent;
const notifButton = (page) => page.nodes.get("caisse-zone-notif").children[0].children[0];

test("notifications : la permission n'est jamais demandée toute seule, seulement au clic", async () => {
  const notif = fakeNotifications();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], null, notif);
  try {
    assert.match(notifLine(page), /Notifications désactivées : cliquer pour activer/);
    assert.equal(notifButton(page).textContent, "Activer les notifications");
    nextRead(page);
    await flush();
    assert.equal(notif.requested, 0, "no request without a click");
    assert.equal(notif.shown.length, 0, "no notification without the permission");
    notifButton(page).listeners.click();
    await flush();
    assert.equal(notif.requested, 1);
    assert.equal(notifLine(page), "Notifications activées");
    assert.equal(notifButton(page).hidden, true);
  } finally {
    page.restore();
  }
});

test("notifications : permission accordée, un nouveau paiement = une notification « Paiement reçu : montant » de payeur, sans description ni numéro", async () => {
  const notif = fakeNotifications({ permission: "granted" });
  const page = await run(
    [ok(data([ticket(1, { description: "SECRET", number: "T-SECRET" })])), ok(data([ticket(2, { description: "SECRET", number: "T-SECRET" }), ticket(1)]))],
    null,
    notif,
  );
  try {
    assert.equal(notif.shown.length, 0, "first load: nothing");
    nextRead(page);
    await flush();
    assert.equal(notif.shown.length, 1);
    assert.equal(notif.shown[0].title, "Paiement reçu : 2,00 G");
    assert.equal(notif.shown[0].options.body, "de P2");
    assert.equal(notif.shown[0].options.icon, "/icon.png");
    assert.equal(notif.shown[0].options.tag, "k2");
    assert.ok(!/SECRET/.test(JSON.stringify([notif.shown[0].title, notif.shown[0].options])));
  } finally {
    page.restore();
  }
});

test("notifications : jamais pour le premier chargement ni pour l'historique d'ouverture", async () => {
  const notif = fakeNotifications({ permission: "granted" });
  const page = await run(
    [ok(data([ticket(2, { isNew: true }), ticket(1)])), ok(data([ticket(9, { initial: true }), ticket(2), ticket(1)])), ok(data([ticket(9, { initial: true }), ticket(2), ticket(1)]))],
    null,
    notif,
  );
  try {
    nextRead(page);
    await flush();
    nextRead(page);
    await flush();
    assert.equal(notif.shown.length, 0);
  } finally {
    page.restore();
  }
});

test("notifications : plus de 3 paiements d'un coup = une seule « N nouveaux paiements »", async () => {
  const notif = fakeNotifications({ permission: "granted" });
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(5), ticket(4), ticket(3), ticket(2), ticket(1)]))], null, notif);
  try {
    nextRead(page);
    await flush();
    assert.equal(notif.shown.length, 1);
    assert.equal(notif.shown[0].title, "4 nouveaux paiements");
  } finally {
    page.restore();
  }
});

test("notifications : un paiement dont le montant n'est pas encore lu attend, puis part avec le montant", async () => {
  const notif = fakeNotifications({ permission: "granted" });
  const pending = ticket(2, { amount: "Montant en cours de lecture", amountReady: false });
  const page = await run([ok(data([ticket(1)])), ok(data([pending, ticket(1)])), ok(data([ticket(2), ticket(1)]))], null, notif);
  try {
    nextRead(page);
    await flush();
    assert.equal(notif.shown.length, 0, "held back");
    nextRead(page);
    await flush();
    assert.equal(notif.shown.length, 1);
    assert.equal(notif.shown[0].title, "Paiement reçu : 2,00 G");
    assert.equal(notif.shown[0].options.body, "de P2");
  } finally {
    page.restore();
  }
});

test("notifications : un clic sur la notification ramène l'onglet au premier plan", async () => {
  const notif = fakeNotifications({ permission: "granted" });
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], null, notif);
  try {
    nextRead(page);
    await flush();
    notif.shown[0].onclick();
    assert.equal(page.seen.focused, 1);
  } finally {
    page.restore();
  }
});

test("notifications : refusées = phrase d'explication et aucun bouton ; non prises en charge ou hors HTTPS = message", async () => {
  const denied = await run([ok(data([ticket(1)]))], null, fakeNotifications({ permission: "denied" }));
  try {
    assert.match(notifLine(denied), /Notifications refusées\. Pour les réactiver/);
    assert.equal(notifButton(denied).hidden, true);
  } finally {
    denied.restore();
  }
  const none = await run([ok(data([ticket(1)]))]);
  try {
    assert.match(notifLine(none), /Notifications non disponibles sur ce navigateur/);
  } finally {
    none.restore();
  }
  const insecure = await run([ok(data([ticket(1)]))], null, fakeNotifications({ permission: "granted", secure: false }));
  try {
    assert.match(notifLine(insecure), /HTTPS/);
  } finally {
    insecure.restore();
  }
});

test("notifications : accordées après un paiement annoncé sans permission, ce paiement n'est pas annoncé en retard", async () => {
  const notif = fakeNotifications();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)])), ok(data([ticket(2), ticket(1)]))], null, notif);
  try {
    nextRead(page);
    await flush();
    notifButton(page).listeners.click();
    await flush();
    nextRead(page);
    await flush();
    assert.equal(notif.shown.length, 0);
  } finally {
    page.restore();
  }
});

test("notifications et son sont indépendants : chacun a sa ligne et son état", async () => {
  const notif = fakeNotifications({ permission: "granted" });
  const page = await run([ok(data([ticket(1)]))], fakeAudio(), notif);
  try {
    assert.match(soundLine(page), /Son désactivé/);
    assert.equal(notifLine(page), "Notifications activées");
  } finally {
    page.restore();
  }
});
