// Cyclos calls of the cash register page: open the push stream, read a
// transfer, read the latest credits, read the notification settings.
//
// It does not import server.js (that would be a circular import): the Cyclos
// address and the channel are given by server.js when it builds the client,
// with the same rules as the statement (path under the base address, `Channel`
// header on EVERY call, Session-Token instead of the password).
//
// Errors are only of three kinds, and carry no URL, no token, no identifier:
//   PushAuthError       401: bad credentials, or the session token is no longer valid
//   PushForbiddenError  403: the account is known but not allowed (rights, channel, blocked)
//   PushUnavailableError  network error, timeout, 429, 5xx, unreadable answer, any other status
//                         (`status` holds the HTTP status when there is one)

import { withComputedTotals } from "./releve-calcul.js";

export class PushAuthError extends Error {}
export class PushForbiddenError extends Error {
  // `accountsDenied`: the refusal comes from the list of money accounts (no account, or no right to read it): the statement says so.
  constructor(message, { accountsDenied = false } = {}) {
    super(message);
    this.accountsDenied = accountsDenied;
  }
}
export class PushUnavailableError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message, { cause });
    this.status = status;
  }
}

// Identifiers and account types go into URL paths: plain names only.
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_TYPE = /^[A-Za-z0-9_.-]{1,60}$/;
const DEFAULT_TIMEOUT_MS = 15_000;

// The account that receives the payments, by order of preference (type.internalName). Among the accounts of GET /self/accounts the
// first name of this list that is found wins, whatever the order Cyclos answers in; if none is found, the first account of the list.
// To change the rule, change this list.
export const PREFERRED_ACCOUNT_TYPES = ["MonComptePro", "monCompte"];

export function createCyclosPush({ baseUrl, channel = "", fetchImpl = globalThis.fetch, requestTimeoutMs = DEFAULT_TIMEOUT_MS }) {
  const channelHeader = channel ? { Channel: channel } : {};

  // Only the error code of a network failure, never the address.
  function networkError(error) {
    const code = error?.cause?.code ?? error?.code;
    return new PushUnavailableError(`network error${code ? ` (${code})` : ""}`, { cause: error });
  }

  // One fetch. `redirect: "error"`: the session token must never follow a redirection
  // to another address. A caller's abort (stop of the listener) is passed on untouched.
  async function request(path, { method = "GET", headers = {}, signal, timeoutMs = requestTimeoutMs } = {}) {
    const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
    const signals = [signal, timeout].filter(Boolean);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { ...headers, ...channelHeader },
        redirect: "error",
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      });
    } catch (error) {
      if (signal?.aborted) throw error; // asked by the caller: not an incident
      if (timeout?.aborted) throw new PushUnavailableError("timeout", { cause: error });
      throw networkError(error);
    }
    return { response, timeout };
  }

  // Turns a non-2xx answer into one of the three error kinds.
  function checkStatus(response, what) {
    if (response.ok) return;
    if (response.status === 401) throw new PushAuthError(`401 on ${what}`);
    if (response.status === 403) throw new PushForbiddenError(`403 on ${what}`);
    throw new PushUnavailableError(`${response.status} on ${what}`, { status: response.status });
  }

  async function getJson(path, token, what, signal) {
    const { response } = await request(path, { headers: { "Session-Token": token }, signal });
    checkStatus(response, what);
    try {
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new PushUnavailableError(`unreadable answer on ${what}`, { cause: error });
    }
  }

  // The account read by the cash register and by the statement: the first account whose type is in PREFERRED_ACCOUNT_TYPES (in that
  // order), otherwise the first one of GET /self/accounts. An empty list, or a type that cannot go in a path, gives null.
  async function readAccount(token, signal) {
    const accounts = await getJson("/self/accounts", token, "getAccount", signal);
    if (!Array.isArray(accounts)) return null;
    const typeOf = (account) => account?.type?.internalName;
    const chosen = PREFERRED_ACCOUNT_TYPES.map((name) => accounts.find((account) => typeOf(account) === name)).find(Boolean) ?? accounts[0];
    const accountType = typeOf(chosen);
    if (typeof accountType !== "string" || !ACCOUNT_TYPE.test(accountType)) return null;
    return { accountType, currency: chosen.currency ?? null };
  }

  // One page of a list that Cyclos answers page by page. `hasNext` comes from the X-Has-Next-Page header; without it, a full page
  // is taken to mean "there may be more".
  async function getPage(path, token, what, pageSize, signal) {
    const { response } = await request(path, { headers: { "Session-Token": token }, signal });
    checkStatus(response, what);
    let lines;
    try {
      lines = await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new PushUnavailableError(`unreadable answer on ${what}`, { cause: error });
    }
    if (!Array.isArray(lines)) throw new PushUnavailableError(`unexpected answer on ${what}`);
    const header = response.headers.get("x-has-next-page");
    return { lines, hasNext: header === null ? lines.length >= pageSize : header === "true" };
  }

  return {
    // Exchanges login + password for a Cyclos session token (same call as the login of
    // the statement: Basic + Channel). Returns the token only.
    // `signal` (optional) cancels the call when the listener stops.
    async createSession(login, password, signal) {
      const basic = Buffer.from(`${login}:${password}`, "utf-8").toString("base64");
      const { response } = await request("/auth/session", {
        method: "POST",
        headers: { Authorization: `Basic ${basic}` },
        signal,
      });
      checkStatus(response, "createSession");
      let body;
      try {
        body = await response.json();
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new PushUnavailableError("unreadable answer on createSession", { cause: error });
      }
      if (typeof body?.sessionToken !== "string" || body.sessionToken === "") {
        throw new PushUnavailableError("no session token on createSession");
      }
      return body.sessionToken;
    },

    // Closes the token on the Cyclos side. Errors are ignored on purpose.
    async closeSession(token) {
      try {
        const { response } = await request("/auth/session", { method: "DELETE", headers: { "Session-Token": token } });
        await response.body?.cancel();
      } catch {
        // ignored on purpose: the local session is gone whatever Cyclos answers
      }
    },

    // Cyclos identifier of the user of this token, or null when it cannot be read reliably.
    async getUserId(token, signal) {
      const body = await getJson("/users/self?fields=id", token, "getUserId", signal);
      return typeof body?.id === "string" && PLAIN_ID.test(body.id) ? body.id : null;
    },

    // Identity of the user of this token for the whitelist of the multi-merchant mode: { id, email }. `id` is null when it cannot be
    // read reliably; `email` is null when Cyclos does not give a plain address (it may not, depending on the profile settings).
    async getIdentity(token, signal) {
      const body = await getJson("/users/self?fields=id,email", token, "getIdentity", signal);
      const id = typeof body?.id === "string" && PLAIN_ID.test(body.id) ? body.id : null;
      const email = typeof body?.email === "string" && body.email.length <= 254 && /^[^\s@,]+@[^\s@,]+$/.test(body.email.trim()) ? body.email.trim() : null;
      return { id, email };
    },

    // Account to read: see PREFERRED_ACCOUNT_TYPES (then the first of GET /self/accounts when none of them is there).
    // Returns { accountType, currency } or null when the list is empty.
    getAccount: readAccount,

    // Is the internal notification "payment received" enabled? true, false, or null when the answer does not say (the caller
    // treats null as "not enabled": fallback mode). On the real instance the settings are NOT at the root of the answer: they are
    // the array `settings.notifications`, whose elements have the fields kind, type, internal, sms, email and app. The one we want
    // is the element whose `type` is "paymentReceived" (`kind` is not filtered). If several elements have that type, the setting is
    // enabled as soon as one has `internal === true`. No array, no such element, or no boolean `internal`: null.
    async getPaymentReceivedSetting(token, signal) {
      const body = await getJson("/self/notification-settings/data-for-edit", token, "getPaymentReceivedSetting", signal);
      const list = body?.settings?.notifications;
      if (!Array.isArray(list)) return null;
      const flags = list
        .filter((item) => item !== null && typeof item === "object" && item.type === "paymentReceived")
        .map((item) => item.internal)
        .filter((value) => typeof value === "boolean");
      return flags.length === 0 ? null : flags.some(Boolean);
    },

    // Latest payments received, most recent first (raw history lines).
    async getRecentCredits(token, { accountType, pageSize }, signal) {
      if (!ACCOUNT_TYPE.test(accountType ?? "")) throw new PushUnavailableError("invalid account type");
      const query = new URLSearchParams({
        direction: "credit",
        kinds: "payment",
        orderBy: "dateDesc",
        pageSize: String(pageSize),
        skipTotalCount: "true",
      });
      const body = await getJson(`/self/accounts/${accountType}/history?${query}`, token, "getRecentCredits", signal);
      if (!Array.isArray(body)) throw new PushUnavailableError("unexpected answer on getRecentCredits");
      return body;
    },

    // One page of the payments received between two moments (ISO texts with offset), most recent first. Returns
    // { lines, hasNext }. `hasNext` comes from the X-Has-Next-Page header; when the header is missing, a full page is taken
    // to mean "there may be more" (the caller then reads on, and its page limit protects it).
    async getCreditsPeriod(token, { accountType, from, to, page, pageSize }, signal) {
      if (!ACCOUNT_TYPE.test(accountType ?? "")) throw new PushUnavailableError("invalid account type");
      const query = new URLSearchParams({
        direction: "credit",
        kinds: "payment",
        orderBy: "dateDesc",
        datePeriod: `${from},${to}`,
        page: String(page),
        pageSize: String(pageSize),
        skipTotalCount: "true",
      });
      return getPage(`/self/accounts/${accountType}/history?${query}`, token, "getCreditsPeriod", pageSize, signal);
    },

    // Statement of the account over a period, for /espace/releve: the name shown by Cyclos, the totals of the period and ALL the
    // transactions (credits AND debits), most recent first, read page by page. `from` and `until` are ISO texts with offset (the
    // end is the last instant included). Reading stops at `maxRows` lines: `truncated` is then true, and the totals Cyclos gives
    // stay as they are, while the totals this code would compute are never made from a cut list (see withComputedTotals).
    // At most about maxRows / pageSize + 1 calls, one after the other. Errors are the three kinds above; a 403 or an empty list on
    // the accounts carries `accountsDenied`. Returns { merchantName, currency, totals, entries, truncated }.
    async getStatement(token, { from, until, pageSize, maxRows }, signal) {
      let merchantName = null;
      try {
        const body = await getJson("/users/self?fields=display", token, "getDisplayName", signal);
        merchantName = typeof body?.display === "string" && body.display ? body.display : null;
      } catch (error) {
        // A 401 means the session is over; any other failure only leaves the name out.
        if (error instanceof PushAuthError || signal?.aborted) throw error;
      }

      let account;
      try {
        account = await readAccount(token, signal);
      } catch (error) {
        if (error instanceof PushForbiddenError) throw new PushForbiddenError(error.message, { accountsDenied: true });
        throw error;
      }
      if (!account) throw new PushForbiddenError("no usable account", { accountsDenied: true });

      const period = new URLSearchParams();
      period.append("datePeriod", from);
      period.append("datePeriod", until);
      const totals = await getJson(`/self/accounts/${account.accountType}?${period}`, token, "getStatementTotals", signal);

      const entries = [];
      let truncated = false;
      for (let page = 0; ; page += 1) {
        const query = `${period}&page=${page}&pageSize=${pageSize}`;
        const { lines, hasNext } = await getPage(`/self/accounts/${account.accountType}/history?${query}`, token, "getStatementHistory", pageSize, signal);
        entries.push(...lines);
        if (entries.length > maxRows || (entries.length === maxRows && hasNext)) {
          truncated = true;
          entries.length = maxRows;
          break;
        }
        // An empty page ends the reading whatever the header says: no endless loop on an odd answer.
        if (!hasNext || lines.length === 0) break;
      }
      // Cyclos' own totals are kept; without them they are computed here, from a complete list only.
      const digits = account.currency?.decimalDigits ?? 2;
      return { merchantName, currency: account.currency, totals: withComputedTotals(totals, entries, truncated, digits), entries, truncated };
    },

    // Detail of a transfer: one call. Never give a transaction id here (they differ).
    async getTransfer(token, id, signal) {
      if (!PLAIN_ID.test(String(id))) throw new PushUnavailableError("invalid transfer id");
      return getJson(`/transfers/${id}`, token, "getTransfer", signal);
    },

    // Detail of a transaction, for a notification whose entityType is "transaction".
    async getTransaction(token, id, signal) {
      if (!PLAIN_ID.test(String(id))) throw new PushUnavailableError("invalid transaction id");
      return getJson(`/transactions/${id}`, token, "getTransaction", signal);
    },

    // Opens the push stream. Resolves once the answer is a 200, with { chunks }: an async
    // iterable of decoded text pieces, which ends when Cyclos closes the stream (about every
    // 41 s, normal) and throws a PushUnavailableError if the connection breaks. `signal`
    // cancels everything (the iteration then throws the AbortError).
    // `clientId` stays the same for the whole life of a listener; `lastEventId` is sent when known.
    async openStream(token, { clientId, lastEventId = null, signal }) {
      if (!PLAIN_ID.test(String(clientId))) throw new PushUnavailableError("invalid client id");
      const headers = { Accept: "text/event-stream", "Session-Token": token };
      if (lastEventId !== null && lastEventId !== undefined && lastEventId !== "") {
        headers["Last-Event-ID"] = String(lastEventId);
      }
      const query = `clientId=${clientId}&kinds=accountStatus&kinds=newNotification`;
      // No timeout on the stream itself: the listener has its own watchdog.
      const { response } = await request(`/push/subscribe?${query}`, { headers, signal, timeoutMs: 0 });
      try {
        checkStatus(response, "openStream");
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
      return {
        chunks: (async function* chunks() {
          const decoder = new TextDecoder();
          try {
            for await (const part of response.body) yield decoder.decode(part, { stream: true });
            const rest = decoder.decode();
            if (rest) yield rest;
          } catch (error) {
            if (signal?.aborted) throw error;
            throw networkError(error);
          }
        })(),
      };
    },
  };
}
