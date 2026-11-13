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

async function run(responses, audio = null, notif = null, store = null) {
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
    removeEventListener: (type, fn) => {
      if (listeners[type] === fn) delete listeners[type];
    },
  };
  set("document", document);
  set("window", { addEventListener: (type, fn) => (listeners[`window:${type}`] = fn), AudioContext: audio?.AudioContext, Notification: notif?.Notification, isSecureContext: notif?.secure ?? true, focus: () => (seen.focused += 1), localStorage: store ?? undefined });
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

// A stand-in for the AudioContext. `audio.state` is what resume() leaves the context in: tests change it to say "the browser now
// accepts the audio" (after a real gesture) or "still refuses".
function fakeAudio(state = "running") {
  const audio = { created: 0, notes: 0, contexts: [], state };
  audio.AudioContext = class {
    constructor() {
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
      audio.created += 1;
      audio.contexts.push(this);
    }
    async resume() {
      this.state = audio.state;
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

// A stand-in for localStorage; `blocked` makes every access throw (private window).
function fakeStore(initial = {}, { blocked = false } = {}) {
  const values = { ...initial };
  return {
    values,
    getItem(key) {
      if (blocked) throw new Error("blocked");
      return key in values ? values[key] : null;
    },
    setItem(key, value) {
      if (blocked) throw new Error("blocked");
      values[key] = String(value);
    },
  };
}

const GESTURES = ["pointerdown", "pointerup", "touchend", "click", "keydown"];
const armed = (page) => GESTURES.filter((type) => page.listeners[type]);
const tap = async (page, type = "click") => {
  page.listeners[type]?.();
  await flush();
};
const soundLine = (page) => page.nodes.get("caisse-zone-son").children[0].children[1].textContent;
const soundButton = (page) => page.nodes.get("caisse-zone-son").children[0].children[0];
const buttonText = (page) => (soundButton(page).hidden ? null : soundButton(page).textContent);
const nextRead = (page) => page.timers.filter((t) => !t.every && t.ms === 3000).at(-1).fn();

test("son : actif par défaut, mais « en attente » tant que le navigateur n'a pas laissé l'audio démarrer, aucun bip", async () => {
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2, { isNew: true }), ticket(1)]))], audio, null, fakeStore());
  try {
    assert.equal(soundLine(page), "Son en attente : toucher la page pour l'activer");
    assert.ok(!/Son activé/.test(soundLine(page)));
    assert.equal(audio.created, 0, "no audio context before a gesture");
    assert.deepEqual(armed(page), GESTURES, "listening for the first gesture");
    nextRead(page);
    await flush();
    assert.equal(audio.notes, 0, "a new payment rings nothing while the audio is not running");
  } finally {
    page.restore();
  }
});

test("son : le premier geste sur la page débloque l'audio sans bip, les écouteurs sont retirés, puis un bip par lot de nouveaux paiements", async () => {
  const audio = fakeAudio();
  const page = await run(
    [ok(data([ticket(1, { isNew: true })])), ok(data([ticket(1)])), ok(data([ticket(4), ticket(3), ticket(2), ticket(1)])), ok(data([ticket(4), ticket(3), ticket(2), ticket(1)]))],
    audio,
    null,
    fakeStore(),
  );
  try {
    await tap(page, "click");
    assert.equal(audio.created, 1);
    assert.equal(audio.notes, 0, "the unlocking gesture rings nothing");
    assert.equal(soundLine(page), "Son activé");
    assert.deepEqual(armed(page), [], "listeners removed after use");
    nextRead(page); // nothing new
    await flush();
    assert.equal(audio.notes, 0);
    nextRead(page); // three payments at once: one bip
    await flush();
    assert.equal(audio.notes, 2, "one bip (two notes) for a batch of three");
    nextRead(page);
    await flush();
    assert.equal(audio.notes, 2);
  } finally {
    page.restore();
  }
});

test("son : un toucher dont le premier événement n'est pas accepté laisse « en attente » et garde les écouteurs, le suivant débloque", async () => {
  const audio = fakeAudio("suspended");
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], audio, null, fakeStore());
  try {
    await tap(page, "pointerdown"); // the browser does not count it yet
    assert.equal(soundLine(page), "Son en attente : toucher la page pour l'activer");
    assert.ok(!/Son activé/.test(soundLine(page)), "never 'activé' with a suspended context");
    assert.deepEqual(armed(page), GESTURES, "still listening");
    nextRead(page);
    await flush();
    assert.equal(audio.notes, 0, "no bip while suspended");
    audio.state = "running";
    await tap(page, "pointerup");
    assert.equal(soundLine(page), "Son activé");
    assert.deepEqual(armed(page), []);
  } finally {
    page.restore();
  }
});

test("son : un geste n'est écouté qu'une fois à la fois (écouteurs posés une seule fois, pas de contexte en double)", async () => {
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1)]))], audio, null, fakeStore());
  try {
    const before = { ...page.listeners };
    page.listeners.click();
    page.listeners.keydown();
    await flush();
    assert.equal(audio.created, 1);
    assert.ok(Object.keys(before).includes("click"));
  } finally {
    page.restore();
  }
});

test("son : si le navigateur suspend l'audio après coup, l'état redevient « en attente » et un geste suffit à le relancer", async () => {
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], audio, null, fakeStore());
  try {
    await tap(page);
    assert.equal(soundLine(page), "Son activé");
    audio.contexts[0].state = "interrupted";
    audio.contexts[0].onstatechange();
    assert.equal(soundLine(page), "Son en attente : toucher la page pour l'activer");
    assert.deepEqual(armed(page), GESTURES, "listening again");
    nextRead(page);
    await flush();
    assert.equal(audio.notes, 0, "no bip while interrupted");
    await tap(page, "keydown");
    assert.equal(soundLine(page), "Son activé");
  } finally {
    page.restore();
  }
});

test("son : choix « coupé » mémorisé = désactivé au chargement, aucun écouteur de geste, aucun contexte, aucun bip", async () => {
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], audio, null, fakeStore({ "caisse-son": "off" }));
  try {
    assert.equal(soundLine(page), "Son désactivé : cliquer pour activer");
    assert.deepEqual(armed(page), []);
    nextRead(page);
    await flush();
    assert.equal(audio.created, 0);
    assert.equal(audio.notes, 0);
  } finally {
    page.restore();
  }
});

test("son : le bouton « Couper le son » coupe et mémorise ; « Activer le son » le remet et mémorise", async () => {
  const audio = fakeAudio();
  const store = fakeStore();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], audio, fakeNotifications({ permission: "granted" }), store);
  try {
    await tap(page);
    assert.equal(buttonText(page), "Couper le son");
    soundButton(page).listeners.click();
    await flush();
    assert.equal(store.values["caisse-son"], "off");
    assert.equal(soundLine(page), "Son désactivé : cliquer pour activer");
    assert.equal(buttonText(page), "Activer le son");
    nextRead(page);
    await flush();
    assert.equal(audio.notes, 0, "cut: nothing rings");
    soundButton(page).listeners.click();
    await flush();
    assert.equal(store.values["caisse-son"], "on");
    assert.equal(soundLine(page), "Son activé");
    assert.equal(audio.notes, 2, "the button plays the test bip");
  } finally {
    page.restore();
  }
});

test("son : stockage bloqué ou absent = la page fonctionne, le son reste actif par défaut", async () => {
  const blocked = await run([ok(data([ticket(1)]))], fakeAudio(), null, fakeStore({}, { blocked: true }));
  try {
    assert.equal(soundLine(blocked), "Son en attente : toucher la page pour l'activer");
    await tap(blocked);
    assert.equal(soundLine(blocked), "Son activé");
    soundButton(blocked).listeners.click(); // cut: cannot be remembered, nothing breaks
    await flush();
    assert.equal(soundLine(blocked), "Son désactivé : cliquer pour activer");
  } finally {
    blocked.restore();
  }
  const absent = await run([ok(data([ticket(1)]))], fakeAudio());
  try {
    assert.equal(soundLine(absent), "Son en attente : toucher la page pour l'activer");
  } finally {
    absent.restore();
  }
});

test("son : le premier chargement ne sonne pas même avec le son débloqué avant la réponse", async () => {
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1, { isNew: true })]))], audio, null, fakeStore());
  try {
    await tap(page);
    assert.equal(audio.notes, 0);
  } finally {
    page.restore();
  }
});

test("son : navigateur sans Web Audio = message clair, aucun écouteur, la page fonctionne", async () => {
  const page = await run([ok(data([ticket(1)]))]);
  try {
    assert.match(soundLine(page), /Son non disponible sur ce navigateur/);
    assert.deepEqual(armed(page), []);
    assert.equal(buttonText(page), null, "no button: nothing to turn on");
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

test("notifications : déjà accordées au chargement = actives tout de suite, sans bouton, sans nouvelle demande", async () => {
  const notif = fakeNotifications({ permission: "granted" });
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], null, notif);
  try {
    assert.equal(notifLine(page), "Notifications activées");
    assert.equal(page.nodes.get("caisse-zone-notif").children[0].children[0].hidden, true, "the notification line never has its own button");
    assert.equal(buttonText(page), null, "nothing left to turn on");
    assert.equal(notif.requested, 0);
    nextRead(page);
    await flush();
    assert.equal(notif.shown.length, 1);
  } finally {
    page.restore();
  }
});

test("notifications : la permission n'est jamais demandée toute seule (ni au geste sur la page), seulement au clic sur le bouton", async () => {
  const notif = fakeNotifications();
  const audio = fakeAudio();
  const page = await run([ok(data([ticket(1)])), ok(data([ticket(2), ticket(1)]))], audio, notif, fakeStore());
  try {
    assert.match(notifLine(page), /Notifications désactivées : cliquer pour activer/);
    assert.equal(buttonText(page), "Activer le son et les notifications");
    await tap(page); // a touch on the page: unlocks the audio, asks nothing
    assert.equal(notif.requested, 0, "no request without a click on the button");
    nextRead(page);
    await flush();
    assert.equal(notif.requested, 0);
    assert.equal(notif.shown.length, 0, "no notification without the permission");
    assert.equal(buttonText(page), "Activer le son et les notifications", "still one to turn on");
  } finally {
    page.restore();
  }
});

test("bouton unique : un clic active le son (bip d'essai) ET demande les notifications, puis devient « Couper le son »", async () => {
  const audio = fakeAudio();
  const notif = fakeNotifications();
  const store = fakeStore();
  const page = await run([ok(data([ticket(1)]))], audio, notif, store);
  try {
    assert.equal(buttonText(page), "Activer le son et les notifications");
    soundButton(page).listeners.click();
    await flush();
    assert.equal(notif.requested, 1);
    assert.equal(audio.created, 1);
    assert.equal(audio.notes, 2, "test bip");
    assert.equal(store.values["caisse-son"], "on");
    assert.equal(soundLine(page), "Son activé");
    assert.equal(notifLine(page), "Notifications activées");
    assert.equal(buttonText(page), "Couper le son");
    assert.deepEqual(armed(page), []);
  } finally {
    page.restore();
  }
});

test("bouton unique : son déjà actif et notifications à accorder = même bouton, sans second bip d'essai", async () => {
  const audio = fakeAudio();
  const notif = fakeNotifications();
  const page = await run([ok(data([ticket(1)]))], audio, notif, fakeStore());
  try {
    await tap(page);
    assert.equal(soundLine(page), "Son activé");
    assert.equal(buttonText(page), "Activer le son et les notifications");
    soundButton(page).listeners.click();
    await flush();
    assert.equal(notif.requested, 1);
    assert.equal(audio.notes, 0, "the sound was already on: no test bip");
    assert.equal(buttonText(page), "Couper le son");
  } finally {
    page.restore();
  }
});

test("bouton unique : notifications refusées = le bouton ne promet que le son ; navigateur sans son = « Activer les notifications »", async () => {
  const denied = await run([ok(data([ticket(1)]))], fakeAudio(), fakeNotifications({ permission: "denied" }), fakeStore());
  try {
    assert.equal(buttonText(denied), "Activer le son");
    assert.match(notifLine(denied), /Notifications refusées\. Pour les réactiver/);
  } finally {
    denied.restore();
  }
  const noSound = await run([ok(data([ticket(1)]))], null, fakeNotifications());
  try {
    assert.equal(buttonText(noSound), "Activer les notifications");
  } finally {
    noSound.restore();
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
    assert.ok(!/SECRET/.test(JSON.stringify([notif.shown[0].title, notif.shown[0].options])));
  } finally {
    page.restore();
  }
});

test("notifications : jamais pour le premier chargement ni pour l'historique d'ouverture", async () => {
  const notif = fakeNotifications({ permission: "granted" });
  const audio = fakeAudio();
  const page = await run(
    [ok(data([ticket(2, { isNew: true }), ticket(1)])), ok(data([ticket(9, { initial: true }), ticket(2), ticket(1)])), ok(data([ticket(9, { initial: true }), ticket(2), ticket(1)]))],
    audio,
    notif,
    fakeStore(),
  );
  try {
    await tap(page);
    nextRead(page);
    await flush();
    nextRead(page);
    await flush();
    assert.equal(notif.shown.length, 0);
    assert.equal(audio.notes, 0, "no sound either");
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

test("notifications : refusées = phrase d'explication ; non prises en charge ou hors HTTPS = message", async () => {
  const denied = await run([ok(data([ticket(1)]))], null, fakeNotifications({ permission: "denied" }));
  try {
    assert.match(notifLine(denied), /Notifications refusées\. Pour les réactiver/);
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
    soundButton(page).listeners.click();
    await flush();
    nextRead(page);
    await flush();
    assert.equal(notif.shown.length, 0);
  } finally {
    page.restore();
  }
});
