// The routes of the statement (/espace/releve), multi-merchant mode only. server.js gives what it owns (the sessions of the area,
// the checks, the answers); everything the statement needs is here, so that server.js only forwards the paths:
//   GET  /espace/releve         the filters (shortcuts ?preset=aujourdhui|hier|6h)
//   POST /espace/releve/ticket  the ticket, read again from Cyclos for the two dates typed, or for the month (fields mois and annee)
//   POST /espace/releve/ticket.pdf  the same ticket as a PDF download (same checks, the data is read again)
// Each POST: origin check, session of the area (its Cyclos token), CSRF token of that session, then ONE reading at a time per
// session. Nothing but the two dates is taken from the browser. A Cyclos 401 ends the session of the area, as for the cash register.
import { PushAuthError, PushForbiddenError, PushUnavailableError } from "./cyclos-push.js";
import { rangeValues, presetRange, parseRange, monthRange, ticketModel } from "./releve-calcul.js";
import {
  renderReleveFilters,
  renderReleveTicket,
  renderReleveForbidden,
  renderReleveAccessDenied,
  renderReleveAccountsDenied,
  renderReleveUnavailable,
  renderReleveBusy,
} from "./releve-page.js";

export const RELEVE_PATH = "/espace/releve";
// The whole reading of a statement (up to about 12 calls to Cyclos, one after the other) must end within this time.
export const DEFAULT_READ_TIMEOUT_MS = 60_000;
// A whole month can need dozens of pages (HISTORY_MAX_ROWS_MONTH lines): its reading gets this much more time per page it may read.
export const MONTH_PAGE_ALLOWANCE_MS = 2_000;

// deps: {
//   helpers { escapeHtml, htmlPage, errorMessage }, send, redirect, readBody, isSameOrigin, isValidCsrf,
//   findSession(req)        -> { id, session } of the area, or null
//   endSession(found, res)  -> closes the session of the area (local record + Cyclos token) and sends the redirect to /espace
//   push()                  -> the Cyclos client (getStatement)
//   limits()                -> { pageSize, maxRows }
//   monthMaxRows()          -> the cap of lines of the whole-month mode
//   readTimeoutMs()         -> milliseconds
//   pdf(model, statement)   -> { bytes, filename }: the PDF of a ticket (loaded on demand, see server.js)
// }
export function createReleveRoutes(deps) {
  const { helpers, send, redirect, readBody, isSameOrigin, isValidCsrf, findSession, endSession } = deps;
  // Sessions of the area with a reading in progress: a second request of the same session is refused, not queued.
  const busy = new Set();

  function forbidden(res, message, hasSession) {
    send(res, 403, "text/html", renderReleveForbidden(message, { hasSession }, helpers));
  }

  // Shared by the ticket and the PDF: origin, session, CSRF, dates, reading. Answers by itself and returns null when it cannot
  // produce a statement; otherwise returns { statement, found, release } and the caller answers, then calls `release`.
  async function load(req, res) {
    if (!isSameOrigin(req)) {
      forbidden(res, "Origine de la requête non autorisée.", false);
      return null;
    }
    const found = findSession(req);
    if (!found) {
      redirect(res, "/espace");
      return null;
    }
    const { csrfToken } = found.session;
    const form = new URLSearchParams(await readBody(req));
    if (!isValidCsrf(found.session, form.get("csrf"))) {
      forbidden(res, "Jeton de sécurité absent ou invalide. Retournez aux filtres et recommencez.", true);
      return null;
    }
    // Whole-month mode: the form sends a month and a year (and no dates). Otherwise the two dates typed.
    const monthly = form.has("mois") || form.has("annee");
    const values = { start: form.get("start") ?? "", end: form.get("end") ?? "" };
    const range = monthly ? monthRange(form.get("annee") ?? "", form.get("mois") ?? "") : parseRange(values.start, values.end);
    if (range.error) {
      const filters = monthly
        ? { csrfToken, values: rangeValues(presetRange()), error: range.error }
        : { csrfToken, values, error: range.error };
      send(res, 400, "text/html", renderReleveFilters(filters, helpers));
      return null;
    }
    if (busy.has(found.id)) {
      send(res, 429, "text/html", renderReleveBusy(helpers), { "Retry-After": "5" });
      return null;
    }

    busy.add(found.id);
    try {
      // The month mode has its own cap of lines, and more time to read the pages that go with it. All the calls of one reading follow
      // each other on the same Cyclos token, so it stays in use from the first to the last page; the area's session was renewed when
      // this request arrived (its idle delay is counted in minutes, a reading in seconds).
      const base = deps.limits();
      const limits = monthly ? { ...base, maxRows: deps.monthMaxRows() } : base;
      const timeoutMs = monthly ? deps.readTimeoutMs() + Math.ceil(limits.maxRows / limits.pageSize) * MONTH_PAGE_ALLOWANCE_MS : deps.readTimeoutMs();
      const statement = await deps.push().getStatement(
        found.session.sessionToken,
        { from: range.from.toUTC().toISO(), until: range.until.toUTC().toISO(), ...limits },
        AbortSignal.timeout(timeoutMs),
      );
      return {
        statement: { ...statement, from: range.from, to: range.to, maxRows: limits.maxRows, month: monthly ? range : null },
        found,
        release: () => busy.delete(found.id),
      };
    } catch (error) {
      busy.delete(found.id);
      if (error instanceof PushAuthError) {
        // Cyclos no longer accepts the token (it ended on its side): the session of the area is over too.
        await endSession(found, res);
        return null;
      }
      if (error instanceof PushForbiddenError) {
        // The account is not allowed to do this, but the session itself is fine.
        send(res, 403, "text/html", error.accountsDenied ? renderReleveAccountsDenied(helpers) : renderReleveAccessDenied(helpers));
        return null;
      }
      const slow = error?.name === "TimeoutError" || error?.name === "AbortError";
      if (error instanceof PushUnavailableError || slow) {
        console.error(`Cyclos injoignable ou en erreur : ${slow ? "délai dépassé" : error.message}`);
        send(res, 502, "text/html", renderReleveUnavailable(helpers));
        return null;
      }
      throw error;
    }
  }

  return {
    // Answers the request when its route is one of the statement's and returns true; otherwise returns false.
    async handle(req, res, pathname) {
      const route = `${req.method} ${pathname}`;
      switch (route) {
        case `GET ${RELEVE_PATH}`: {
          const found = findSession(req);
          if (!found) {
            redirect(res, "/espace");
            return true;
          }
          const preset = new URL(req.url, "http://x").searchParams.get("preset");
          send(res, 200, "text/html", renderReleveFilters({ csrfToken: found.session.csrfToken, values: rangeValues(presetRange(preset)) }, helpers));
          return true;
        }
        case `POST ${RELEVE_PATH}/ticket`: {
          const loaded = await load(req, res);
          if (!loaded) return true;
          try {
            const model = ticketModel(loaded.statement);
            send(res, 200, "text/html", renderReleveTicket({ model, csrfToken: loaded.found.session.csrfToken, pdf: Boolean(deps.pdf) }, helpers));
          } finally {
            loaded.release();
          }
          return true;
        }
        case `POST ${RELEVE_PATH}/ticket.pdf`: {
          const loaded = await load(req, res);
          if (!loaded) return true;
          try {
            // The whole PDF is built before any header is sent: a failure here ends in a plain error answer, not in a half-sent file.
            let pdf;
            try {
              pdf = await deps.pdf(ticketModel(loaded.statement), loaded.statement);
            } catch (error) {
              console.error(error);
              send(res, 500, "text/plain", "Impossible de générer le PDF");
              return true;
            }
            res.writeHead(200, {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="${pdf.filename}"`,
              "Content-Length": pdf.bytes.length,
              "Cache-Control": "no-store",
            });
            res.end(pdf.bytes);
          } finally {
            loaded.release();
          }
          return true;
        }
        case `GET ${RELEVE_PATH}/ticket`:
        case `GET ${RELEVE_PATH}/ticket.pdf`:
          // A link or a reload cannot ask for a statement: only the form does.
          redirect(res, RELEVE_PATH);
          return true;
        default:
          return false;
      }
    },
  };
}
