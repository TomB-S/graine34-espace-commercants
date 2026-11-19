// === WHAT THIS FILE CHECKS ===
// The statement read of the statement page (getStatement in cyclos-push.js), against the fake Cyclos: name, totals of the period and
// ALL the transactions (credits and debits), page by page, up to a limit; and what the ticket then shows: totals computed in exact
// integers when Cyclos gives none, "Non disponible" (never an invented figure) when the list is cut or an amount unreadable.
// Most cases come from the original statement tool, with the same expectations. All values are fictitious.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { startFakeCyclos, USER, entry } from "./support/fake-cyclos.js";
import { createCyclosPush, PushAuthError, PushForbiddenError, PushUnavailableError } from "../src/cyclos-push.js";
import { ticketModel } from "../src/releve-calcul.js";

const NNBSP = " ";
const NA = "Non disponible";
const ZONE = "Europe/Paris";
// A period around today: the fixtures are dated today.
const FROM = DateTime.now().setZone(ZONE).startOf("day").minus({ days: 1 });
const UNTIL = DateTime.now().setZone(ZONE).endOf("day").plus({ days: 1 });
const LIMITS = { pageSize: 200, maxRows: 2000 };

async function withClient(fn, { state = {}, options = {} } = {}) {
  const cyclos = await startFakeCyclos();
  Object.assign(cyclos.state, state);
  const push = createCyclosPush({ baseUrl: cyclos.url, channel: "main", ...options });
  try {
    const token = await push.createSession(USER.login, USER.password);
    await fn({ cyclos, push, token });
  } finally {
    await cyclos.close();
  }
}

const read = (push, token, limits = LIMITS) =>
  push.getStatement(token, { from: FROM.toUTC().toISO(), until: UNTIL.toUTC().toISO(), ...limits });
// What the ticket shows for a statement: [label, value] of the three summary lines.
const summary = (statement, maxRows = LIMITS.maxRows) =>
  ticketModel({ from: FROM, to: UNTIL, ...statement, maxRows }).summary.map((line) => [line.label, line.value]);

// Lines with the given amounts (most recent first, like Cyclos).
const withAmounts = (amounts) => amounts.map((amount, n) => entry(n, { amount })).reverse();
// n lines: three incoming for one outgoing.
function history(count) {
  const list = [];
  for (let n = count - 1; n >= 0; n -= 1) list.push(entry(n, { amount: n % 4 === 3 ? "-2.50" : `${(n % 7) + 1}.25` }));
  return list;
}
const fr = (cents) => {
  const abs = Math.abs(cents);
  const integer = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);
  return `${integer},${String(abs % 100).padStart(2, "0")}`;
};

// ------------------------------------------------------------------------- what is asked of Cyclos

// Intention: the name, the account, the totals and the history are read with the session token and the channel, the period is sent
// as two `datePeriod` values (UTC), and credits AND debits are asked for (no `direction` filter).
test("getStatement : appels, jeton, canal, période en UTC, crédits et débits", () =>
  withClient(
    async ({ cyclos, push, token }) => {
      const statement = await read(push, token);
      assert.equal(statement.merchantName, USER.display);
      assert.deepEqual(statement.currency, { name: "Graines", decimalDigits: 2 });
      assert.equal(statement.entries.length, 2);
      assert.equal(statement.truncated, false);
      const [history] = cyclos.calls("GET", "/self/accounts/membre/history");
      assert.equal(history.headers["session-token"], token);
      assert.equal(history.headers.channel, "main");
      assert.deepEqual(history.query.getAll("datePeriod"), [FROM.toUTC().toISO(), UNTIL.toUTC().toISO()]);
      assert.equal(history.query.get("direction"), null, "pas de filtre : les débits sont lus aussi");
      assert.equal(history.query.get("page"), "0");
      assert.equal(history.query.get("pageSize"), "200");
      assert.deepEqual(cyclos.calls("GET", "/self/accounts/membre")[0].query.getAll("datePeriod"), history.query.getAll("datePeriod"));
      assert.equal(cyclos.calls("GET", "/users/self")[0].query.get("fields"), "display");
      assert.deepEqual(statement.entries.map((e) => e.amount), ["-4.00", "10.00"], "débit et crédit, du plus récent au plus ancien");
    },
    { state: { entries: [entry(2, { amount: "-4.00" }), entry(1, { amount: "10.00" })] } },
  ));

// Intention: only the entries inside the period are returned, the end included.
test("getStatement : seules les lignes de la période sont lues", () =>
  withClient(
    async ({ push, token }) => {
      const statement = await read(push, token);
      assert.deepEqual(statement.entries.map((e) => e.transactionNumber), ["T00001"]);
    },
    { state: { entries: [entry(1), entry(0, { date: FROM.minus({ days: 5 }).toUTC().toISO() })] } },
  ));

// Intention: the account is the first one of the list (documented limit for a merchant with several accounts).
test("getStatement : le compte lu est le premier de la liste", () =>
  withClient(
    async ({ cyclos, push, token }) => {
      await read(push, token);
      assert.equal(cyclos.calls("GET", "/self/accounts/membre").length, 1);
    },
    { state: { accountsBody: [{ type: { internalName: "membre" }, currency: { name: "Graines", decimalDigits: 2 } }, { type: { internalName: "autre" }, currency: {} }] } },
  ));

// ------------------------------------------------------------------------- totals computed by the code

// Intention: without totals from Cyclos, they are computed over all pages, exactly (the real instance answers without them).
test("sans indicateurs : totaux calculés sur plusieurs pages (450 lignes, 3 pages)", () =>
  withClient(
    async ({ cyclos, push, token }) => {
      const entries = history(450);
      cyclos.state.entries = entries;
      const statement = await read(push, token);
      assert.equal(cyclos.calls("GET", "/self/accounts/membre/history").length, 3);
      assert.equal(statement.entries.length, 450);
      assert.equal(statement.truncated, false);
      const cents = (e) => Math.round(Number(e.amount) * 100);
      const incoming = entries.filter((e) => cents(e) > 0);
      const outgoing = entries.filter((e) => cents(e) < 0);
      const inSum = incoming.reduce((t, e) => t + cents(e), 0);
      const outSum = outgoing.reduce((t, e) => t - cents(e), 0);
      assert.deepEqual(summary(statement), [
        [`${incoming.length} paiements reçus`, fr(inSum)],
        [`${outgoing.length} paiements sortis`, fr(outSum)],
        ["Solde net", `${inSum - outSum >= 0 ? "+" : "-"}${fr(inSum - outSum)}`],
      ]);
    },
    { state: { indicators: false } },
  ));

test("sans indicateurs : précision décimale (0,1 + 0,2 = 0,30 exact)", () =>
  withClient(
    async ({ cyclos, push, token }) => {
      assert.deepEqual(summary(await read(push, token)), [["2 paiements reçus", "0,30"], ["3 paiements sortis", "0,50"], ["Solde net", "-0,20"]]);
      cyclos.state.entries = withAmounts(Array(10000).fill("0.10")).slice(0, 1500);
      assert.deepEqual(summary(await read(push, token)), [["1500 paiements reçus", "150,00"], ["0 paiement sorti", "0,00"], ["Solde net", "+150,00"]]);
      cyclos.state.entries = withAmounts(["5", "1234567.5", "-0.05"]);
      assert.deepEqual(summary(await read(push, token)), [
        ["2 paiements reçus", `1${NNBSP}234${NNBSP}572,50`],
        ["1 paiement sorti", "0,05"],
        ["Solde net", `+1${NNBSP}234${NNBSP}572,45`],
      ]);
    },
    { state: { indicators: false, entries: withAmounts(["0.10", "0.20", "-0.10", "-0.20", "-0.20"]) } },
  ));

test("sans indicateurs : plage vide -> 0 reçu, 0 sorti, net 0", () =>
  withClient(
    async ({ push, token }) => {
      const statement = await read(push, token);
      assert.deepEqual(statement.entries, []);
      assert.deepEqual(summary(statement), [["0 paiement reçu", "0,00"], ["0 paiement sorti", "0,00"], ["Solde net", "0,00"]]);
      assert.equal(ticketModel({ from: FROM, to: UNTIL, ...statement }).warning, "");
    },
    { state: { indicators: false, entries: [] } },
  ));

test("sans indicateurs : une transaction à 0 n'est ni reçue ni sortie ; net négatif", () =>
  withClient(
    async ({ push, token }) => {
      assert.deepEqual(summary(await read(push, token)), [["0 paiement reçu", "0,00"], ["1 paiement sorti", "3,00"], ["Solde net", "-3,00"]]);
    },
    { state: { indicators: false, entries: withAmounts(["0.00", "-3.00"]) } },
  ));

test("sans indicateurs : monnaie sans décimale (decimalDigits 0)", () =>
  withClient(
    async ({ push, token }) => {
      assert.deepEqual(summary(await read(push, token)), [["2 paiements reçus", "15"], ["1 paiement sorti", "4"], ["Solde net", "+11"]]);
    },
    { state: { indicators: false, currency: { name: "Graines", decimalDigits: 0 }, entries: withAmounts(["10", "5", "-4"]) } },
  ));

// Intention: an unreadable amount must not produce a total: "Non disponible" three times, the detail is still there.
test("sans indicateurs : montant illisible -> 'Non disponible', jamais inventé, détail conservé", () =>
  withClient(
    async ({ push, token }) => {
      const statement = await read(push, token);
      assert.deepEqual(summary(statement).map(([, value]) => value), [NA, NA, NA]);
      assert.equal(statement.entries.length, 2);
    },
    { state: { indicators: false, entries: withAmounts(["1.00", "abc"]) } },
  ));

// ------------------------------------------------------------------------- the limit of lines

// Edge case: exactly 2000 lines is a complete list: totals computed, no warning.
test("sans indicateurs : exactement 2000 lignes -> totaux calculés, pas d'avertissement", () =>
  withClient(
    async ({ push, token }) => {
      const statement = await read(push, token);
      assert.equal(statement.entries.length, 2000);
      assert.equal(statement.truncated, false);
      assert.deepEqual(summary(statement), [["2000 paiements reçus", `3${NNBSP}000,00`], ["0 paiement sorti", "0,00"], ["Solde net", `+3${NNBSP}000,00`]]);
      assert.equal(ticketModel({ from: FROM, to: UNTIL, ...statement }).warning, "");
    },
    { state: { indicators: false, entries: withAmounts(Array(2000).fill("1.50")) } },
  ));

// Intention: beyond 2000, a computed total would be wrong: "Non disponible" three times, a clear warning, no claim of exact totals.
test("sans indicateurs : 2001 lignes -> 'Non disponible' x3, avertissement clair, détail limité à 2000", () =>
  withClient(
    async ({ cyclos, push, token }) => {
      const statement = await read(push, token);
      assert.equal(statement.entries.length, 2000);
      assert.equal(statement.truncated, true);
      assert.equal(cyclos.calls("GET", "/self/accounts/membre/history").length, 10, "10 appels au plus pour 2000 lignes de 200");
      assert.deepEqual(summary(statement), [["Paiements reçus", NA], ["Paiements sortis", NA], ["Solde net", NA]]);
      const { warning } = ticketModel({ from: FROM, to: UNTIL, ...statement });
      assert.match(warning, /^Attention : la liste est limitée aux 2000 transactions les plus récentes/);
      assert.match(warning, /totaux du résumé ne peuvent pas être calculés au-delà de 2000 transactions/);
      assert.ok(!warning.includes("restent exacts"));
    },
    { state: { indicators: false, entries: withAmounts(Array(2001).fill("1.50")) } },
  ));

// Intention: the two limits are settings (HISTORY_PAGE_SIZE, HISTORY_MAX_ROWS): here 10 per page and 25 lines at most.
test("limites réglables : pages de 10, 25 lignes au plus", () =>
  withClient(
    async ({ cyclos, push, token }) => {
      const limits = { pageSize: 10, maxRows: 25 };
      const statement = await read(push, token, limits);
      assert.equal(statement.entries.length, 25);
      assert.equal(statement.truncated, true);
      assert.equal(cyclos.calls("GET", "/self/accounts/membre/history").length, 3);
      assert.equal(cyclos.calls("GET", "/self/accounts/membre/history")[0].query.get("pageSize"), "10");
      assert.match(ticketModel({ from: FROM, to: UNTIL, ...statement, maxRows: 25 }).warning, /limitée aux 25 transactions/);
      // Exactly 25 lines: complete, not cut.
      cyclos.state.entries = withAmounts(Array(25).fill("1.00"));
      assert.equal((await read(push, token, limits)).truncated, false);
    },
    { state: { indicators: false, entries: withAmounts(Array(40).fill("1.00")) } },
  ));

// Intention: a history answered without the X-Has-Next-Page header is still read to the end (a full page means "maybe more").
test("sans en-tête X-Has-Next-Page : la lecture va jusqu'au bout", () =>
  withClient(
    async ({ push, token }) => {
      const statement = await read(push, token);
      assert.equal(statement.entries.length, 450);
      assert.equal(statement.truncated, false);
    },
    { state: { omitHasNext: true, entries: withAmounts(Array(450).fill("1.00")) } },
  ));

// ------------------------------------------------------------------------- indicators given by Cyclos

// Intention: Cyclos' own totals are taken as they are (values deliberately different from the lines: nothing is recomputed).
test("avec indicateurs : les totaux de Cyclos sont repris tels quels", () =>
  withClient(
    async ({ push, token }) => {
      assert.deepEqual(summary(await read(push, token)), [["7 paiements reçus", "70,00"], ["3 paiements sortis", "30,00"], ["Solde net", "+40,00"]]);
    },
    { state: { entries: withAmounts(["1.00", "-1.00"]), totals: { incoming: { count: 7, sum: "70.00" }, outgoing: { count: 3, sum: "30.00" }, netInflow: "40.00" } } },
  ));

// Intention: even with the list cut, Cyclos' totals stay exact (computed over the whole period) and the warning says so.
test("avec indicateurs : liste tronquée -> totaux de Cyclos et mention 'restent exacts'", () =>
  withClient(
    async ({ push, token }) => {
      const statement = await read(push, token);
      assert.equal(statement.truncated, true);
      assert.deepEqual(summary(statement), [["2500 paiements reçus", `5${NNBSP}000,00`], ["0 paiement sorti", "0,00"], ["Solde net", `+5${NNBSP}000,00`]]);
      const { warning } = ticketModel({ from: FROM, to: UNTIL, ...statement });
      assert.match(warning, /totaux du résumé restent exacts/);
      assert.ok(!warning.includes(NA));
    },
    { state: { entries: withAmounts(Array(2500).fill("2.00")) } },
  ));

// ------------------------------------------------------------------------- errors

// Intention: a 401 anywhere (the token is no longer valid) is a PushAuthError, so that the page can close the session.
test("erreurs : 401 sur le nom, le compte, les totaux ou l'historique -> PushAuthError", async () => {
  for (const route of ["GET /users/self", "GET /self/accounts", "GET /self/accounts/membre", "GET /self/accounts/membre/history"]) {
    await withClient(async ({ cyclos, push, token }) => {
      cyclos.force(route, 401);
      await assert.rejects(read(push, token), PushAuthError, route);
    });
  }
});

// Intention: a refusal on the list of accounts (or an empty list) says "accountsDenied"; a refusal elsewhere does not.
test("erreurs : 403 sur les comptes ou liste vide -> accountsDenied ; 403 ailleurs -> refus simple", async () => {
  await withClient(async ({ cyclos, push, token }) => {
    cyclos.force("GET /self/accounts", 403);
    await assert.rejects(read(push, token), (error) => error instanceof PushForbiddenError && error.accountsDenied === true);
  });
  await withClient(
    async ({ push, token }) => {
      await assert.rejects(read(push, token), (error) => error instanceof PushForbiddenError && error.accountsDenied === true);
    },
    { state: { accountsBody: [] } },
  );
  await withClient(async ({ cyclos, push, token }) => {
    cyclos.force("GET /self/accounts/membre", 403);
    await assert.rejects(read(push, token), (error) => error instanceof PushForbiddenError && error.accountsDenied === false);
  });
});

// Intention: 5xx, cut connection and unreadable answers are "unavailable"; the message holds no token, no address.
test("erreurs : 5xx et réseau coupé -> PushUnavailableError sans donnée sensible", async () => {
  for (const [route, status] of [["GET /self/accounts", 500], ["GET /self/accounts/membre", "drop"], ["GET /self/accounts/membre/history", 502]]) {
    await withClient(async ({ cyclos, push, token }) => {
      cyclos.force(route, status);
      await assert.rejects(read(push, token), (error) => error instanceof PushUnavailableError && !/jeton|127\.0\.0\.1|http/.test(error.message));
    });
  }
});

// Intention: the name is a courtesy: any failure other than 401 leaves it out, the statement still comes.
test("le nom affiché est facultatif : une erreur 500 dessus ne bloque pas le relevé", () =>
  withClient(async ({ cyclos, push, token }) => {
    cyclos.force("GET /users/self", 500);
    const statement = await read(push, token);
    assert.equal(statement.merchantName, null);
    assert.equal(statement.entries.length, 1);
  }, { state: { entries: [entry(1)] } }));
