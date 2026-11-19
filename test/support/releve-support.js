// Shared by the tests of the statement (/espace/releve): a merchant of the fake Cyclos, a small browser that keeps the area's cookie,
// the login of the area, transactions on a day that is over, and readers of the pages. All names and secrets are fictitious.
import assert from "node:assert/strict";
import { CAISSE_OPTIONS } from "./options.js";
import { entry } from "./fake-cyclos.js";

export const MARIE = { id: "u-marie", login: "marie", password: "mdp-marie-fictif", email: "marie@exemple.test", display: "Boutique de Marie" };
export const RANGE = { start: "2026-01-10T00:00", end: "2026-01-10T23:59" };
export const NNBSP = "\u202f";

export const options = (more = {}, caisse = {}) => ({
  cyclosChannel: "main",
  caisseHooks: CAISSE_OPTIONS.caisseHooks,
  caisse: { enabled: true, multiMerchant: true, allowedUsers: { ids: [MARIE.id], emails: [] }, ...caisse },
  ...more,
});

// A merchant of the fake Cyclos with data of his own.
export function seed(app, entries = [], display = MARIE.display) {
  app.cyclos.addUser(MARIE.login, MARIE.password, { id: MARIE.id, email: MARIE.email, display, entries });
  app.cyclos.state.push.lifetimeMs = null;
}
export const setEntries = (app, entries) => {
  app.cyclos.state.users.get(MARIE.login).entries = entries;
};

// A small browser keeping the cookies by name (the area's cookie only here).
export function browser(app) {
  const jar = new Map();
  const cookieLine = () => [...jar].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
  async function request(path, { method = "GET", form, headers = {} } = {}) {
    const init = { method, redirect: "manual", headers: { ...headers } };
    if (cookieLine()) init.headers.Cookie = cookieLine();
    if (form) {
      init.headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    }
    const res = await fetch(`${app.base}${path}`, init);
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, ...value] = pair.split("=");
      jar.set(name, value.join("="));
    }
    return res;
  }
  const self = {
    base: app.base,
    request,
    jar,
    enter: (password = MARIE.password) => request("/espace/connexion", { method: "POST", form: { login: MARIE.login, password }, headers: { Origin: app.base } }),
    csrf: async () => (await (await request("/espace")).text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1],
    // POST /espace/releve/ticket with the Origin of the page.
    ticket: (form, { origin = app.base } = {}) => request("/espace/releve/ticket", { method: "POST", form, headers: origin ? { Origin: origin } : {} }),
  };
  return self;
}

// Logs the merchant into the area and returns { b, csrf }.
export async function connected(app, entries, { display } = {}) {
  seed(app, entries, display);
  const b = browser(app);
  assert.equal((await b.enter()).status, 303);
  return { b, csrf: await b.csrf() };
}

// n transactions on 10 January 2026 (a day that is over), most recent first like Cyclos; one in four is outgoing.
export const on = (n, extra = {}) => entry(n, { ...extra, date: new Date(Date.UTC(2026, 0, 10, 12, 0, 0) + n * 1000).toISOString() });
export function history(count) {
  const list = [];
  for (let n = count - 1; n >= 0; n -= 1) list.push(on(n, { amount: n % 4 === 3 ? "-2.50" : `${(n % 7) + 1}.25` }));
  return list;
}

export const summaryOf = (html) => [...html.matchAll(/<dt>(.*?)<\/dt>\s*<dd>(.*?)<\/dd>/g)].map((m) => [m[1], m[2]]);
export const rowsOf = (html) => [...html.matchAll(/<li class="ligne">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
export const numbersOf = (html) => [...html.matchAll(/<span class="numero">(.*?)<\/span>/g)].map((m) => m[1]);
export const amountsOf = (html) => [...html.matchAll(/<span class="montant">(.*?)<\/span>/g)].map((m) => m[1]);
export const cents = (text) => Math.round(Number(text.replaceAll(NNBSP, "").replace(",", ".")) * 100);
export const historyCalls = (app) => app.cyclos.calls("GET", "/self/accounts/membre/history");

