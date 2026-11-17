// === READ THIS FIRST: what is this file for? ===
// This is not a test: it is a TOOL used by the tests.
// Cyclos is the software that manages the local currency accounts. Our tool talks to it through a REST
// API, that is, through HTTP requests (a method + a path, for example "GET /self/accounts") to which Cyclos
// answers in JSON (a text format for data: { "key": "value" }).
// In the tests we NEVER want to talk to the real Cyclos: it would need a network, real accounts, and the
// results would change from one day to the next. This file therefore starts a small LOCAL HTTP server that
// answers like Cyclos, with made-up data. It only imitates the routes our tool uses:
//   POST   /auth/session                    login (login + password -> session token)
//   DELETE /auth/session                    logout (the token is closed on the Cyclos side)
//   GET    /users/self                      display name of the merchant
//   GET    /self/accounts                   list of the merchant's accounts
//   GET    /self/accounts/membre            totals (received, sent, net balance) over a period
//   GET    /self/accounts/membre/history    transactions, PAGE by page (`direction=credit` keeps the entries received)
// and, for the cash register page (/caisse):
//   GET    /push/subscribe                  stream of events (SSE), closed after `streamLifetimeMs` like the real one (about 41 s)
//   GET    /transfers/{id}  /transactions/{key}   detail of a payment (404 when unknown)
//   GET    /self/notification-settings/data-for-edit   is "payment received" enabled?
// Any other route answers 404. The tests can make it simulate: a wrong password (401), a refusal (403),
// an outage (500), a cut connection ("drop"), an expired token, several pages of transactions, and the
// "no totals" answer of the real instance. See `state` and the functions returned at the very bottom of the file.
// Fake Cyclos for the tests: a small local HTTP server that imitates the
// endpoints used by the server. No external network, fictitious credentials.
import http from "node:http";

// FICTITIOUS credentials of the test merchant. No real password is used anywhere in this project.
export const USER = { login: "commercant", password: "motdepasse-de-test", display: "Boutique de Test", id: "user-1" };

// Builds a fictitious transaction. `n` makes it unique and orders it in time (the n-th one is n minutes
// after the previous one); the default amount is 10.00.
// Builds a history line in Cyclos' format (negative amount = outgoing payment).
export function entry(n, { amount = "10.00", date, description, who = "Client" } = {}) {
  const base = Date.parse("2026-01-10T08:00:00Z") + n * 60_000;
  return {
    transactionNumber: `T${String(n).padStart(5, "0")}`,
    date: date ?? new Date(base).toISOString(),
    amount,
    description: description ?? `Achat ${n}`,
    relatedAccount: { user: { display: `${who} ${n}` } },
  };
}

// Builds the answer of GET /self/notification-settings/data-for-edit as the real instance sends it: the settings are the array
// `settings.notifications`, every element has kind, type, internal, sms, email and app. `paymentReceived`: the flags of the
// "paymentReceived" element ({ internal, ... }, null = no such element); `others` are elements of other types, placed before and after;
// `extra` are more elements added at the end (a duplicate type, an odd element...).
export function notificationSettingsBody({ paymentReceived = { internal: true }, others = true, extra = [] } = {}) {
  const element = (type, kind, flags = {}) => ({ kind, type, internal: false, sms: false, email: false, app: false, ...flags });
  const notifications = [];
  if (others) notifications.push(element("paymentAwaitingAuthorization", "payment", { internal: true, email: true }), element("generalMessage", "message", { internal: true, app: true }));
  if (paymentReceived) notifications.push(element("paymentReceived", "payment", { email: true, app: true, ...paymentReceived }));
  if (others) notifications.push(element("paymentReceivedChargedBack", "payment", { internal: true }), element("passwordChanged", "user", { email: true }));
  notifications.push(...extra);
  return { user: { display: "Boutique de Test" }, settings: { notifications } };
}

// Builds the answer of GET /transfers/{id} in the shape of the real instance: the description is NOT at the root,
// it is in `transaction.description`; the amount is a STRING; the date has a time zone. Fictitious values only.
export function transfer(n, { amount = "1.00", description = `Objet ${n}`, payer = `Payeur ${n}`, date, id = `tr-${n}` } = {}) {
  const base = Date.parse("2026-01-10T08:00:00Z") + n * 60_000;
  return {
    id,
    transactionNumber: `T${String(n).padStart(5, "0")}`,
    amount,
    date: date ?? new Date(base).toISOString().replace("Z", "+00:00"),
    from: { user: { display: payer } },
    currency: { symbol: "G", suffix: " G", decimalDigits: 2 },
    transaction: { description },
  };
}

// Builds the "newNotification" event data for a payment received (the shape of section 2 of the instructions).
export function paymentNotification(n, { payer = `Payeur ${n}`, entityId = `tr-${n}`, entityType = "transfer", type = "paymentReceived", date } = {}) {
  const base = Date.parse("2026-01-10T08:00:00Z") + n * 60_000;
  return {
    notification: {
      date: date ?? new Date(base).toISOString().replace("Z", "+00:00"),
      relatedUser: { display: payer },
      subject: "Sujet de test",
      message: "Message de test",
      read: false,
      entityId,
      type,
      entityType,
    },
    newNotifications: 1,
    unreadNotifications: 1,
  };
}

// Starts the fake Cyclos and returns what is needed to drive it: its address (`url`), its state (`state`)
// and a few functions (`force`, `expireTokens`, `calls`, `close`). `async`: the function waits (`await`) for the
// server to be ready before handing back; see test/statique.test.js for an explanation of async/await.
export async function startFakeCyclos() {
  // `state` is the memory of the fake Cyclos. Tests MODIFY it before acting to build the wanted situation
  // (for example `app.cyclos.state.entries = [...]` to choose the transactions that are returned).
  const state = {
    requests: [], // { method, path, headers, query } of each call received
    tokens: new Set(),
    // token -> user of the login that created it ({ id, display }).
    tokenUsers: new Map(),
    // Other users able to log in, besides USER: login -> { password, id, display }.
    users: new Map(),
    // Cash register page. `transfers` / `transactions`: id -> body, answered by GET /transfers/{id} and /transactions/{key}.
    transfers: new Map(),
    transactions: new Map(),
    // Body of GET /self/notification-settings/data-for-edit, in the shape of the real instance (the default has "payment received"
    // enabled). Build another one with notificationSettingsBody().
    notificationSettings: notificationSettingsBody(),
    // Push stream. `lifetimeMs`: the stream is closed by the "server" after this delay (null = stays open until
    // endStreams()). `silent`: no byte at all, not even ":Initialized" (dead connection). `history`: events sent so far,
    // replayed to a client that reconnects with Last-Event-ID, like Cyclos does for a short cut.
    push: { lifetimeMs: 200, silent: false, history: [], nextId: 1, replay: true },
    streams: new Set(), // responses of the streams currently open
    omitUserId: false, // true: GET /users/self answers without the user id
    deleted: [], // tokens closed by DELETE /auth/session
    entries: [], // most recent first, like Cyclos
    pageSize: null, // when set, forces the page size (otherwise the requested one)
    totals: null, // when set, replaces the computed totals
    // false: reproduces the real instance, which answers without incoming, outgoing
    // or netInflow (only balances and credit limits).
    indicators: true,
    accountsBody: undefined, // when set, replaces the answer to GET /self/accounts
    displayName: USER.display,
    // Forced answers: "METHOD /path" -> status (e.g. "GET /self/accounts": 403).
    forced: new Map(),
    currency: { name: "Graines", decimalDigits: 2 },
    counter: 0,
  };

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  // Every request received goes through here. It is recorded in `state.requests`: tests can then check what OUR
  // server sent to Cyclos (which calls, with which headers). `key` looks like "GET /self/accounts".
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    const path = url.pathname.replace(/^\/api/, "");
    const key = `${req.method} ${path}`;
    state.requests.push({
      method: req.method,
      path,
      headers: req.headers,
      query: url.searchParams,
    });
    req.resume();

    // Forced situation: if a test asked "this route must fail", we answer right away with that status
    // (401, 403, 500...) without looking at anything else. "drop" cuts the connection: the client gets a network error.
    const forced = state.forced.get(key);
    if (forced) {
      if (forced === "drop") return req.socket.destroy();
      if (forced === "hang") return; // never answers (timeout tests)
      return json(res, forced, { code: forced === 401 ? "loggedOut" : forced === 403 ? "forbidden" : "unknownError" });
    }

    // Login. The HTTP header `Authorization: Basic xxx` holds "login:password" encoded in base64 (a mere encoding,
    // not encryption). We decode it (`Buffer`: see test/statique.test.js) and compare it with USER. If it matches, we invent
    // a session token ("jeton-1", "jeton-2"...); otherwise 401 (not authenticated).
    if (key === "POST /auth/session") {
      const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
      const [login, ...rest] = Buffer.from(encoded ?? "", "base64").toString("utf-8").split(":");
      const password = rest.join(":");
      const other = state.users.get(login);
      const known =
        login === USER.login && password === USER.password
          ? { id: USER.id, display: USER.display }
          : other && other.password === password
            ? { id: other.id, display: other.display }
            : null;
      if (scheme !== "Basic" || !known) {
        return json(res, 401, { code: "login" });
      }
      const token = `jeton-${++state.counter}`;
      state.tokens.add(token);
      state.tokenUsers.set(token, known);
      return json(res, 200, { sessionToken: token, user: { display: known.display }, permissions: ["secret"] });
    }

    // After login, our tool no longer sends the password: it sends the token in the `Session-Token` header.
    // An unknown (or expired) token is refused with 401, as the real Cyclos would do.
    const token = req.headers["session-token"];
    if (!state.tokens.has(token)) return json(res, 401, { code: "loggedOut" });

    if (key === "DELETE /auth/session") {
      state.tokens.delete(token);
      state.deleted.push(token);
      res.writeHead(204);
      return res.end();
    }
    if (key === "GET /users/self") {
      const user = state.tokenUsers.get(token);
      // The default user keeps the display name tests may have changed in `state.displayName`.
      const display = !user || user.id === USER.id ? state.displayName : user.display;
      // `state.omitUserId`: the answer has no id (the registration check must then refuse, never guess).
      return json(res, 200, { id: state.omitUserId ? undefined : (user?.id ?? USER.id), display });
    }
    if (key === "GET /self/notification-settings/data-for-edit") return json(res, 200, state.notificationSettings);
    const detail = /^GET \/(transfers|transactions)\/([^/]+)$/.exec(key);
    if (detail) {
      const found = state[detail[1]].get(decodeURIComponent(detail[2]));
      return found ? json(res, 200, found) : json(res, 404, { code: "entityNotFound" });
    }
    // Push stream: ":Initialized", the events missed since Last-Event-ID (when replay is on), then the events pushed by the
    // test (cyclos.push). The "server" ends it after `push.lifetimeMs`, which is the normal end of a real stream.
    if (key === "GET /push/subscribe") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.flushHeaders();
      state.streams.add(res);
      let timer;
      res.on("close", () => {
        clearTimeout(timer);
        state.streams.delete(res);
      });
      if (state.push.silent) return;
      res.write(":Initialized\n\n");
      const lastId = Number(req.headers["last-event-id"]);
      if (state.push.replay && Number.isFinite(lastId)) {
        for (const event of state.push.history) if (event.id > lastId) res.write(event.text);
      }
      if (state.push.lifetimeMs !== null) {
        timer = setTimeout(() => res.end(), state.push.lifetimeMs);
        timer.unref();
      }
      return;
    }
    if (key === "GET /self/accounts") {
      if (state.accountsBody !== undefined) return json(res, 200, state.accountsBody);
      return json(res, 200, [{ type: { internalName: "membre" }, currency: state.currency }]);
    }
    // Totals of the period. "membre" is the type of the fictitious account. With `state.indicators = false` we imitate the real
    // instance, which does not return the received/sent totals: our tool must then compute them (see test/totaux-calcules.test.js).
    if (key === "GET /self/accounts/membre") {
      if (!state.indicators) {
        return json(res, 200, {
          status: {
            balance: "125.00",
            availableBalance: "125.00",
            creditLimit: "0.00",
            reservedAmount: "0.00",
            beginDate: "2026-01-01T00:00:00.000+01:00",
            endDate: "2026-02-01T00:00:00.000+01:00",
            upperCreditLimit: "1000.00",
          },
        });
      }
      if (state.totals) return json(res, 200, { status: state.totals });
      const sum = (list) => list.reduce((total, e) => total + Math.abs(Number(e.amount)), 0).toFixed(2);
      const incoming = state.entries.filter((e) => Number(e.amount) > 0);
      const outgoing = state.entries.filter((e) => Number(e.amount) < 0);
      return json(res, 200, {
        status: {
          incoming: { count: incoming.length, sum: sum(incoming) },
          outgoing: { count: outgoing.length, sum: sum(outgoing) },
          netInflow: (Number(sum(incoming)) - Number(sum(outgoing))).toFixed(2),
        },
      });
    }
    // PAGINATED history: instead of returning everything at once, Cyclos splits it into pages. The client asks for `page` (0, 1, 2...)
    // and `pageSize` (lines per page); the `X-Has-Next-Page: true` header says whether another page remains to be read.
    if (key === "GET /self/accounts/membre/history") {
      const page = Number(url.searchParams.get("page") ?? 0);
      const size = state.pageSize ?? Number(url.searchParams.get("pageSize") ?? 40);
      // `direction=credit` (cash register page): only the entries received, amount above zero.
      const all =
        url.searchParams.get("direction") === "credit" ? state.entries.filter((e) => Number(e.amount) > 0) : state.entries;
      const slice = all.slice(page * size, (page + 1) * size);
      const hasNext = (page + 1) * size < all.length;
      return json(res, 200, slice, { "X-Has-Next-Page": String(hasNext) });
    }
    json(res, 404, { code: "notFound" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    // What the tests receive to drive the fake Cyclos:
    url: `http://127.0.0.1:${server.address().port}/api`,
    state,
    // Every token becomes invalid (token expired on the Cyclos side).
    expireTokens: () => state.tokens.clear(),
    // Calls "METHOD /path" answer with this status ("drop" cuts the connection).
    force: (key, status) => state.forced.set(key, status),
    calls: (method, path) => state.requests.filter((r) => r.method === method && r.path === path),
    // A second user able to log in (tests of the registration check).
    addUser: (login, password, { id, display = "Autre Utilisateur de Test" }) => state.users.set(login, { password, id, display }),
    // Sends an event on every open stream and keeps it for the replay. `data` is an object (sent as JSON);
    // `name` the SSE event name (null = no "event:" line). Returns the id given to the event.
    push(name, data, { id = state.push.nextId++ } = {}) {
      const text = `id: ${id}\n${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
      state.push.history.push({ id: Number(id), text });
      for (const stream of state.streams) stream.write(text);
      return id;
    },
    // Raw text on every open stream (broken JSON, odd lines...), not kept for the replay.
    pushRaw: (text) => state.streams.forEach((stream) => stream.write(text)),
    // The "server" closes every open stream now.
    endStreams: () => state.streams.forEach((stream) => stream.end()),
    openStreams: () => state.streams.size,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
