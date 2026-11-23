// The routes of the statement (/espace/releve), multi-merchant mode only. server.js gives what it owns (the sessions of the area,
// the checks, the answers); everything the statement needs is here, so that server.js only forwards the paths:
//   GET  /espace/releve         the filters (a query string is ignored: the shortcuts are buttons of a POST form, not links)
//   POST /espace/releve/ticket  the ticket, read again from Cyclos for the two dates typed, for a day between two hours (fields jour, de, a and, when checked, lendemain)
//                               or for a whole month (fields mois and annee), or for a shortcut (field raccourci: aujourdhui, hier or 6h)
//   POST /espace/releve/ticket.pdf  the same ticket as a PDF download (same checks, the data is read again)
// Each POST: origin check, session of the area (its Cyclos token), CSRF token of that session, then ONE reading at a time per
// session. Nothing but the two dates is taken from the browser. A Cyclos 401 ends the session of the area, as for the cash register.
import { PushAuthError, PushForbiddenError, PushUnavailableError } from "./cyclos-push.js";
import { rangeValues, presetRange, parseRange, monthRange, dayRange, dayDefaults, previousMonth, allowedYears, ticketModel } from "./releve-calcul.js";
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
//   helpers { escapeHtml, htmlPage, errorMessage }, ticketPolicy (the policy of the ticket page, the only one with a script), send, redirect, readBody, isSameOrigin, isValidCsrf,
//   findSession(req)        -> { id, session } of the area, or null
//   endSession(found, res)  -> closes the session of the area (local record + Cyclos token) and sends the redirect to /espace
//   push()                  -> the Cyclos client (getStatement)
//   limits()                -> { pageSize, maxRows }
//   payerNames()            -> { hidePayerName, nameOrder }: how the counterparty is written (the cash register's settings)
//   monthMaxRows()          -> the cap of lines of the whole-month mode
//   readTimeoutMs()         -> milliseconds
//   pdf(model, statement)   -> { bytes, filename }: the PDF of a ticket (loaded on demand, see server.js)
// }
// The month and the year typed in the monthly block, when they are values the lists offer; otherwise the usual default (the
// previous month). Only used to select the same options again after an error.
function submittedMonth(form) {
  const month = Number(form.get("mois"));
  const year = Number(form.get("annee"));
  const fallback = previousMonth();
  return {
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : fallback.month,
    year: allowedYears().includes(year) ? year : fallback.year,
  };
}

const SHORTCUTS = ["aujourdhui", "hier", "6h"];

// The range of a shortcut: the two bounds presetRange computes, validated by parseRange like the two dates the old page filled in
// (same bounds, the end of "today" brought back to now). Anything but the three known names is refused.
function shortcutRange(name) {
  if (!SHORTCUTS.includes(name)) return { error: "Raccourci inconnu : choisissez Aujourd'hui, Hier ou 6 dernières heures." };
  const { start, end } = rangeValues(presetRange(name));
  return parseRange(start, end);
}

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
    // Three ways to choose the period, told apart by the fields the form sends: a month and a year (whole month), a day and two hours
    // (jour, de, a), otherwise the two full dates typed. If a request carried fields of several, the month wins, then the day.
    const monthly = form.has("mois") || form.has("annee");
    const daily = !monthly && (form.has("jour") || form.has("de") || form.has("a"));
    // A shortcut button of the filters page (last in the order of priority). Only the three known names are accepted.
    const shortcut = !monthly && !daily && form.has("raccourci");
    const values = { start: form.get("start") ?? "", end: form.get("end") ?? "" };
    // The "next day" box: a checkbox sends its value ("1") only when checked; anything else counts as unchecked.
    const dayValues = { jour: form.get("jour") ?? "", de: form.get("de") ?? "", a: form.get("a") ?? "", lendemain: form.get("lendemain") === "1" };
    const range = monthly
      ? monthRange(form.get("annee") ?? "", form.get("mois") ?? "")
      : daily
        ? dayRange(dayValues.jour, dayValues.de, dayValues.a, dayValues.lendemain)
        : shortcut
          ? shortcutRange(form.get("raccourci"))
          : parseRange(values.start, values.end);
    if (range.error) {
      // The page is shown again with what was typed in the block that was used (the other blocks have their usual values), and the
      // message is placed by that block (`errorFor`).
      const filters = { csrfToken, values: rangeValues(presetRange()), day: dayDefaults(), error: range.error, errorFor: "range" };
      if (monthly) {
        Object.assign(filters, { errorFor: "month", month: submittedMonth(form) });
      } else if (daily) {
        Object.assign(filters, { errorFor: "day", day: dayValues });
      } else if (shortcut) {
        Object.assign(filters, { errorFor: "shortcut" });
      } else {
        Object.assign(filters, { values });
      }
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
        statement: { ...statement, from: range.from, to: range.to, maxRows: limits.maxRows, month: monthly ? range : null, day: daily ? range.day : null, payerNames: deps.payerNames() },
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
          // Same page whatever the query string (old ?preset= links included): the default values, the folded menu closed.
          send(res, 200, "text/html", renderReleveFilters({ csrfToken: found.session.csrfToken, values: rangeValues(presetRange()) }, helpers));
          return true;
        }
        case `POST ${RELEVE_PATH}/ticket`: {
          const loaded = await load(req, res);
          if (!loaded) return true;
          try {
            const model = ticketModel(loaded.statement);
            // The only answer of the statement that carries a script (the print button): its policy adds script-src 'self' and nothing else.
            send(res, 200, "text/html", renderReleveTicket({ model, csrfToken: loaded.found.session.csrfToken, pdf: Boolean(deps.pdf) }, helpers), {
              "Content-Security-Policy": deps.ticketPolicy,
            });
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
