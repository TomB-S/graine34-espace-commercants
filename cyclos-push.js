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

export class PushAuthError extends Error {}
export class PushForbiddenError extends Error {}
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

    // Account to read, same rule as the statement: the first account of GET /self/accounts.
    // Returns { accountType, currency } or null when the list is empty.
    async getAccount(token, signal) {
      const accounts = await getJson("/self/accounts", token, "getAccount", signal);
      const first = Array.isArray(accounts) ? accounts[0] : null;
      const accountType = first?.type?.internalName;
      if (typeof accountType !== "string" || !ACCOUNT_TYPE.test(accountType)) return null;
      return { accountType, currency: first.currency ?? null };
    },

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
