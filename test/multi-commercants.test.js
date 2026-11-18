// === WHAT THIS FILE CHECKS ===
// The listener manager in multi-merchant mode (src/listener-manager.js), with the real listeners and a fake Cyclos where each
// merchant has data of his own. The main point is ISOLATION: a merchant never sees the tickets, the recap, the state or the
// stream events of another, whatever happens to the other (stop, refusal, idle delay). Also: the whitelist at the door, the
// ceiling of listeners, the queue of starts (3 at a time), and no password nor token in the log.
// All names, amounts and identifiers are fictitious.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeCyclos, entry, transfer, paymentNotification, todayAt } from "./support/fake-cyclos.js";
import { readCaisseConfig } from "../src/caisse-config.js";
import { createCyclosPush } from "../src/cyclos-push.js";
import { createListenerManager } from "../src/listener-manager.js";

const MERCHANTS = {
  "u-marie": { login: "marie", password: "mdp-marie-test", display: "Marie Boulangerie" },
  "u-paul": { login: "paul", password: "mdp-paul-test", display: "Paul Fromagerie" },
  "u-zoe": { login: "zoe", password: "mdp-zoe-test", display: "Zoe Librairie" },
};
const MARIE = "u-marie";
const PAUL = "u-paul";
const ZOE = "u-zoe";

async function waitFor(condition, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé : ${what}`);
}

// A fake Cyclos with the merchants above (each with his own data), a manager in multi-merchant mode and a clock moved by hand.
// `data(id)` returns the options of addUser for one merchant. `credentials` can replace the password of a merchant (refusal test).
async function withMulti(options, fn) {
  const { data = () => ({ entries: [] }), allowed = "u-marie,u-paul,u-zoe", config = {}, credentials = {}, wrapPush, managerOptions = {} } = options;
  const cyclos = await startFakeCyclos();
  cyclos.state.push.lifetimeMs = null;
  for (const [id, who] of Object.entries(MERCHANTS)) {
    cyclos.addUser(who.login, who.password, { id, display: who.display, ...data(id) });
  }
  const realPush = createCyclosPush({ baseUrl: cyclos.url, channel: "main" });
  const push = wrapPush ? wrapPush(realPush) : realPush;
  const clock = { at: Date.now() };
  const logs = { info: [], error: [] };
  const log = { info: (m) => logs.info.push(m), error: (m) => logs.error.push(m) };
  const base = readCaisseConfig(
    { CAISSE_ENABLED: "true", CAISSE_CYCLOS_LOGIN: "ecouteur-test", CAISSE_CYCLOS_PASSWORD: "mdp-ecouteur-test", CAISSE_MULTI_MERCHANT: "true", CAISSE_ALLOWED_USERS: allowed },
    { idleSeconds: 45, streamWatchdogSeconds: 60, reconnectMaxSeconds: 30, reauthMax: 3, safetyPollSeconds: 3600, historyInitial: 10, ticketsKept: 50, ...config },
  );
  // How the listener of a merchant gets his Cyclos session: here his own login (the way in is the business of a later step).
  const conf = Object.freeze({
    ...base,
    credentialsFor: (key) => (MERCHANTS[key] ? { login: MERCHANTS[key].login, password: credentials[key] ?? MERCHANTS[key].password } : null),
  });
  const manager = createListenerManager({
    config: conf,
    push,
    log,
    now: () => clock.at,
    sweepIntervalMs: 3_600_000,
    listenerOptions: { shortStreamMs: 0 },
    processorOptions: { debounceMs: 20 },
    ...managerOptions,
  });
  try {
    await fn({ cyclos, manager, clock, logs, conf });
  } finally {
    await manager.stopAll();
    await cyclos.close();
  }
}

const live = (manager, key) => waitFor(() => manager.touch(key).view.status === "live", `${key} live`);
const view = (manager, key) => manager.touch(key).view;
const amounts = (manager, key) => view(manager, key).tickets.map((t) => t.amount);
const tokenOwners = (cyclos) =>
  cyclos.state.requests
    .filter((r) => r.headers["session-token"])
    .map((r) => ({ path: r.path, user: cyclos.state.tokenUsers.get(r.headers["session-token"])?.id }));

// Each merchant has payments of his own, with amounts, payers and descriptions found nowhere else.
const OWN = (id) =>
  ({
    "u-marie": { entries: [entry(2, { amount: "2.00", description: "Pain complet", who: "Client Marie" }), entry(1, { amount: "1.00", description: "Baguette", who: "Client Marie" })] },
    "u-paul": { entries: [entry(3, { amount: "33.00", description: "Comté 18 mois", who: "Client Paul" })] },
    "u-zoe": { entries: [entry(4, { amount: "44.00", description: "Roman policier", who: "Client Zoe" })] },
  })[id];

// === Isolation ===

// Intention: two merchants listening at the same time each see only their own payments, in the tickets and everywhere else.
test("multi : chaque commerçant ne voit que ses propres paiements", () =>
  withMulti({ data: OWN }, async ({ manager }) => {
    manager.touch(MARIE);
    manager.touch(PAUL);
    await Promise.all([live(manager, MARIE), live(manager, PAUL)]);
    assert.deepEqual(amounts(manager, MARIE), ["2.00", "1.00"]);
    assert.deepEqual(amounts(manager, PAUL), ["33.00"]);
    const marie = JSON.stringify(view(manager, MARIE));
    const paul = JSON.stringify(view(manager, PAUL));
    for (const secret of ["Comté", "Client Paul", "33.00", "T00003"]) assert.equal(marie.includes(secret), false, `Marie voit ${secret}`);
    for (const secret of ["Pain complet", "Baguette", "Client Marie", "2.00", "T00001"]) assert.equal(paul.includes(secret), false, `Paul voit ${secret}`);
  }));

// Intention: a payment pushed to one merchant reaches his tickets only.
test("multi : un paiement poussé à un commerçant n'arrive qu'à lui", () =>
  withMulti(
    {
      data: (id) => {
        const base = OWN(id);
        return { ...base, transfers: new Map(id === MARIE ? [["tr-9", transfer(9, { amount: "9.00", description: "Gâteau", payer: "Payeur Marie" })]] : []) };
      },
    },
    async ({ cyclos, manager }) => {
      manager.touch(MARIE);
      manager.touch(PAUL);
      await Promise.all([live(manager, MARIE), live(manager, PAUL)]);
      cyclos.pushTo(MARIE, "newNotification", paymentNotification(9, { payer: "Payeur Marie" }));
      await waitFor(() => amounts(manager, MARIE).includes("9.00"), "paiement chez Marie");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(amounts(manager, PAUL), ["33.00"]);
      assert.equal(JSON.stringify(view(manager, PAUL)).includes("Gâteau"), false);
    },
  ));

// Intention: the recap of yesterday is per merchant: Marie's total never shows at Paul's, who had nothing yesterday.
test("multi : le bilan d'hier est propre à chaque commerçant", () =>
  withMulti(
    {
      data: (id) => ({
        entries:
          id === MARIE
            ? [entry(5, { amount: "10.00", date: new Date(todayAt(5, -1)).toISOString() }), entry(6, { amount: "5.50", date: new Date(todayAt(6, -1)).toISOString() })]
            : [],
      }),
    },
    async ({ manager }) => {
      manager.touch(MARIE);
      manager.touch(PAUL);
      await Promise.all([live(manager, MARIE), live(manager, PAUL)]);
      await waitFor(() => view(manager, MARIE).recap?.state === "ok" && view(manager, PAUL).recap?.state === "ok", "bilans lus");
      assert.equal(view(manager, MARIE).recap.count, 2);
      assert.equal(view(manager, MARIE).recap.total, "15.50");
      assert.equal(view(manager, PAUL).recap.count, 0);
      assert.equal(view(manager, PAUL).recap.total, "0.00");
    },
  ));

// Intention: every call a listener makes to Cyclos carries the token of ITS merchant: no token is shared, none is lent.
test("multi : chaque écouteur n'utilise que le jeton de son commerçant", () =>
  withMulti({ data: OWN }, async ({ cyclos, manager }) => {
    manager.touch(MARIE);
    manager.touch(PAUL);
    manager.touch(ZOE);
    await Promise.all([live(manager, MARIE), live(manager, PAUL), live(manager, ZOE)]);
    const owners = tokenOwners(cyclos);
    assert.ok(owners.length > 6);
    for (const { path, user } of owners) assert.ok(user, `jeton inconnu pour ${path}`);
    // One token per merchant, and each token only ever served the data of its owner (checked above through the tickets).
    const tokens = new Set(cyclos.state.requests.map((r) => r.headers["session-token"]).filter(Boolean));
    assert.equal(tokens.size, 3);
    assert.equal(new Set(owners.map((o) => o.user)).size, 3);
  }));

// Intention: stopping one merchant (his logout) closes his Cyclos session and cuts his stream only: the others go on, untouched.
test("multi : l'arrêt d'un commerçant ne touche pas les autres", () =>
  withMulti({ data: OWN }, async ({ cyclos, manager }) => {
    manager.touch(MARIE);
    manager.touch(PAUL);
    await Promise.all([live(manager, MARIE), live(manager, PAUL)]);
    const marieToken = [...cyclos.state.tokenUsers].find(([, user]) => user.id === MARIE)[0];
    await manager.stop(MARIE, "déconnexion");
    assert.deepEqual(cyclos.state.deleted, [marieToken]);
    assert.equal(cyclos.openStreams(), 1);
    assert.equal(manager.size, 1);
    assert.equal(view(manager, PAUL).status, "live");
    assert.deepEqual(amounts(manager, PAUL), ["33.00"]);
  }));

// Intention: after a stop and a new visit, a merchant starts from nothing: no memory of his earlier tickets and none of another's.
test("multi : après l'arrêt, le commerçant repart de zéro, sans donnée d'un autre", () =>
  withMulti({ data: OWN }, async ({ manager }) => {
    manager.touch(MARIE);
    manager.touch(PAUL);
    await Promise.all([live(manager, MARIE), live(manager, PAUL)]);
    await manager.stop(MARIE);
    const again = manager.touch(MARIE);
    assert.equal(again.view.status, "starting");
    assert.deepEqual(again.view.tickets, [], "rien gardé en mémoire");
    await live(manager, MARIE);
    assert.deepEqual(amounts(manager, MARIE), ["2.00", "1.00"]);
    assert.equal(JSON.stringify(view(manager, MARIE)).includes("33.00"), false);
  }));

// Intention: one merchant whose Cyclos session is refused ends in "error" alone; the others stay live and keep their payments.
test("multi : le refus d'un commerçant par Cyclos ne dérange pas les autres", () =>
  withMulti({ data: OWN, credentials: { [MARIE]: "mauvais-mot-de-passe" } }, async ({ manager }) => {
    manager.touch(MARIE);
    manager.touch(PAUL);
    await live(manager, PAUL);
    await waitFor(() => view(manager, MARIE).status === "error", "Marie en erreur");
    assert.deepEqual(view(manager, MARIE).tickets, []);
    assert.equal(view(manager, PAUL).status, "live");
    assert.deepEqual(amounts(manager, PAUL), ["33.00"]);
  }));

// Intention: the idle delay is per merchant: the one nobody visits stops, the one still visited stays.
test("multi : l'inactivité est comptée par commerçant", () =>
  withMulti({ data: OWN }, async ({ manager, clock, cyclos }) => {
    manager.touch(MARIE);
    manager.touch(PAUL);
    await Promise.all([live(manager, MARIE), live(manager, PAUL)]);
    clock.at += 30_000;
    manager.touch(PAUL);
    clock.at += 30_000;
    await manager.sweep();
    assert.equal(manager.size, 1);
    assert.equal(cyclos.openStreams(), 1);
    assert.equal(view(manager, PAUL).status, "live");
    assert.deepEqual(amounts(manager, PAUL), ["33.00"]);
  }));

// Intention: several tabs of ONE merchant share one listener; two merchants never do, even with the same payment numbers.
test("multi : un écouteur par commerçant, jamais partagé, même avec des numéros de paiement identiques", () =>
  withMulti(
    { data: (id) => ({ entries: id === ZOE ? [] : [entry(1, { amount: id === MARIE ? "1.00" : "7.00" })] }) },
    async ({ cyclos, manager }) => {
      for (let i = 0; i < 3; i += 1) manager.touch(MARIE);
      manager.touch(PAUL);
      await Promise.all([live(manager, MARIE), live(manager, PAUL)]);
      assert.equal(manager.size, 2);
      assert.equal(cyclos.calls("POST", "/auth/session").length, 2);
      assert.deepEqual(amounts(manager, MARIE), ["1.00"]);
      assert.deepEqual(amounts(manager, PAUL), ["7.00"]);
    },
  ));

// === Door: whitelist ===

// Intention: a merchant on the list gets his own number as key; the e-mail address works too, without case nor spaces around.
test("multi : autorisation par numéro interne ou par e-mail, la clé est le numéro du visiteur", () =>
  withMulti({ allowed: "u-marie, Paul@Exemple.test" }, async ({ manager, cyclos }) => {
    assert.deepEqual(await manager.authorize({ id: MARIE }), { ok: true, merchantKey: MARIE });
    assert.deepEqual(await manager.authorize(MARIE), { ok: true, merchantKey: MARIE });
    assert.deepEqual(await manager.authorize({ id: PAUL, email: "  PAUL@exemple.TEST " }), { ok: true, merchantKey: PAUL });
    assert.equal(cyclos.state.requests.length, 0, "aucun appel à Cyclos pour décider");
  }));

// Intention: refusal by default: not on the list, empty list, unreadable identity. Nothing is listened to, and the log
// line holds the internal number only (never the e-mail address) to help the administrator.
test("multi : refus par défaut, aucune écoute, ligne de journal avec le numéro seulement", () =>
  withMulti({ allowed: "u-marie" }, async ({ manager, cyclos, logs }) => {
    assert.deepEqual(await manager.authorize({ id: ZOE, email: "zoe@exemple.test" }), { ok: false, status: 403 });
    assert.ok(logs.error.includes("compte refusé (absent de CAISSE_ALLOWED_USERS), numéro interne Cyclos : u-zoe"));
    assert.equal(JSON.stringify(logs).includes("zoe@exemple.test"), false);
    for (const bad of [null, undefined, "", 42, {}, { id: "" }, { id: "a b" }, { email: "marie@exemple.test" }]) {
      assert.deepEqual(await manager.authorize(bad), { ok: false, status: 403 }, JSON.stringify(bad));
    }
    assert.equal(manager.size, 0);
    assert.equal(cyclos.state.requests.length, 0);
  }));

test("multi : liste vide, personne n'est autorisé", () =>
  withMulti({ allowed: "" }, async ({ manager }) => {
    for (const id of [MARIE, PAUL, ZOE]) assert.deepEqual(await manager.authorize({ id }), { ok: false, status: 403 });
  }));

// Intention: a key that is not a plain Cyclos number cannot open a listener (nothing with a path or a query in it).
test("multi : une clé qui n'est pas un numéro interne simple est refusée", () =>
  withMulti({}, async ({ manager }) => {
    for (const key of ["a/b", "../u-marie", "u-marie?x=1", "", " u-marie", null, undefined, 7, "x".repeat(65)]) {
      assert.deepEqual(manager.touch(key), { ok: false, status: 403 }, String(key));
    }
    assert.equal(manager.size, 0);
  }));

// === Ceiling and queue of starts ===

// Intention: the ceiling counts the merchants, refuses the next with 503, an existing one is still served, a freed slot is reusable.
test("multi : plafond d'écouteurs, 503 au-delà, place libérée réutilisable", () =>
  withMulti({ config: { maxListeners: 2 } }, async ({ manager, logs, clock }) => {
    assert.equal(manager.touch(MARIE).ok, true);
    assert.equal(manager.touch(PAUL).ok, true);
    assert.deepEqual(manager.touch(ZOE), { ok: false, status: 503 });
    assert.equal(manager.touch(MARIE).ok, true);
    assert.ok(logs.error.some((l) => /plafond de 2 écouteur\(s\) atteint/.test(l)));
    await manager.stop(PAUL);
    assert.equal(manager.touch(ZOE).ok, true);
    clock.at += 0;
  }));

// A push client whose logins wait for a gate, to see how many logins are in progress at the same time.
function gatedPush(gate, counters) {
  return (real) => ({
    ...real,
    async createSession(login, password, signal) {
      counters.inFlight += 1;
      counters.max = Math.max(counters.max, counters.inFlight);
      counters.started += 1;
      try {
        await gate.promise;
        return await real.createSession(login, password, signal);
      } finally {
        counters.inFlight -= 1;
      }
    },
  });
}

function gate() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
}

// Intention: at most 3 merchants load their first history at the same time; the others wait their turn, then all get through.
test("multi : 3 démarrages à la fois, les suivants font la queue puis passent", async () => {
  const g = gate();
  const counters = { inFlight: 0, max: 0, started: 0 };
  const ids = ["u-a1", "u-a2", "u-a3", "u-a4", "u-a5"];
  const wasLive = [];
  await withMulti(
    { wrapPush: gatedPush(g, counters), config: { maxListeners: 10 }, allowed: ids.join(",") },
    async ({ manager, cyclos }) => {
      for (const id of ids) {
        MERCHANTS[id] = { login: id, password: `mdp-${id}`, display: id };
        cyclos.addUser(id, `mdp-${id}`, { id, entries: [] });
      }
      try {
        for (const id of ids) {
          const visit = manager.touch(id);
          assert.equal(visit.ok, true);
          assert.equal(visit.view.status, "starting", "visible tout de suite, en attente");
        }
        await waitFor(() => counters.started === 3, "3 démarrages");
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(counters.started, 3, "les 2 autres attendent");
        assert.equal(manager.size, 5);
        g.open();
        await Promise.all(ids.map((id) => live(manager, id)));
        for (const id of ids) wasLive.push(view(manager, id).status);
        assert.equal(counters.started, 5);
        assert.ok(counters.max <= 3, `jamais plus de 3 connexions en cours (max ${counters.max})`);
      } finally {
        for (const id of ids) delete MERCHANTS[id];
      }
    },
  );
  assert.deepEqual(wasLive, ids.map(() => "live"));
});

// Intention: a merchant who leaves while still waiting in the queue is never started (no login for him), and the queue goes on.
test("multi : un commerçant parti pendant l'attente n'est jamais démarré", async () => {
  const g = gate();
  const counters = { inFlight: 0, max: 0, started: 0 };
  const ids = ["u-b1", "u-b2", "u-b3", "u-b4"];
  await withMulti(
    { wrapPush: gatedPush(g, counters), config: { maxListeners: 10 }, allowed: ids.join(",") },
    async ({ manager, cyclos }) => {
      for (const id of ids) {
        MERCHANTS[id] = { login: id, password: `mdp-${id}`, display: id };
        cyclos.addUser(id, `mdp-${id}`, { id, entries: [] });
      }
      try {
        for (const id of ids) manager.touch(id);
        await waitFor(() => counters.started === 3, "3 démarrages");
        await manager.stop("u-b4"); // still waiting
        assert.equal(manager.size, 3);
        g.open();
        await Promise.all(ids.slice(0, 3).map((id) => live(manager, id)));
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(counters.started, 3, "u-b4 n'a jamais ouvert de session");
        assert.equal(cyclos.state.users.get("u-b4") !== undefined, true);
      } finally {
        for (const id of ids) delete MERCHANTS[id];
      }
    },
  );
});

// Intention: a listener that ends in error still frees its start slot (the queue does not stall behind a refused merchant).
test("multi : un démarrage en erreur libère sa place dans la file", async () => {
  const ids = ["u-c1", "u-c2", "u-c3", "u-c4"];
  await withMulti(
    { config: { maxListeners: 10 }, allowed: ids.join(","), credentials: { "u-c1": "faux", "u-c2": "faux", "u-c3": "faux" } },
    async ({ manager, cyclos }) => {
      for (const id of ids) {
        MERCHANTS[id] = { login: id, password: `mdp-${id}`, display: id };
        cyclos.addUser(id, `mdp-${id}`, { id, entries: [entry(8, { amount: "8.00" })] });
      }
      try {
        for (const id of ids) manager.touch(id);
        await live(manager, "u-c4");
        assert.equal(view(manager, "u-c1").status, "error");
        assert.deepEqual(amounts(manager, "u-c4"), ["8.00"]);
      } finally {
        for (const id of ids) delete MERCHANTS[id];
      }
    },
  );
});

// === Log ===

// Intention: neither a password nor a Cyclos token ever reaches the log, whatever happens (normal run, stop, refusal).
test("multi : ni mot de passe ni jeton dans le journal", () =>
  withMulti({ data: OWN, credentials: { [ZOE]: "mauvais-mot-de-passe" }, allowed: "u-marie,u-paul" }, async ({ manager, cyclos, logs }) => {
    manager.touch(MARIE);
    manager.touch(PAUL);
    manager.touch(ZOE);
    await Promise.all([live(manager, MARIE), live(manager, PAUL)]);
    await waitFor(() => view(manager, ZOE).status === "error", "Zoe en erreur");
    await manager.authorize({ id: ZOE });
    await manager.stop(MARIE, "déconnexion");
    const text = JSON.stringify(logs);
    for (const who of Object.values(MERCHANTS)) assert.equal(text.includes(who.password), false, who.password);
    for (const token of cyclos.state.tokenUsers.keys()) assert.equal(text.includes(token), false, token);
    assert.equal(text.includes("mauvais-mot-de-passe"), false);
  }));
