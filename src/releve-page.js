// HTML of the statement of transactions (/espace/releve): pure functions, state in, text out. A filter page (three ways to choose the period and three
// shortcuts) and the end-of-service ticket. Under /espace, so the pages link back to the area ("Retour à l'espace"), there is no
// logout button here (the area has its own).
//
// Same rules as the other pages: no inline script, no inline style (the CSP of these pages forbids both), every value that is not a
// constant goes through escapeHtml. The only script is the one of the ticket (the Print button, loaded by src at the end of the body). The helpers of server.js are given by the caller (importing it from here would be circular).

import { backButton } from "./format.js";
import { MONTH_NAMES, allowedYears, previousMonth, dayDefaults } from "./releve-calcul.js";

export const TOOL_NAME = "Relevés de caisse";
const FILTERS_HREF = "/espace/releve";
const AREA_HREF = "/espace";

const PRINT_SCRIPT = "/print-ticket.js";
// Column titles of the month ticket: hidden on screen, printed at the top of the table and repeated on every printed page (A4 only).
const columnHeader = `<li class="entete-colonnes"><span>Date</span><span>Numéro</span><span>Contrepartie</span><span>Description</span><span>Montant</span></li>
      `;
const backToArea = `<p><a href="${AREA_HREF}">Retour à l'espace</a></p>`;

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The filter page: the period is chosen in three ways, from the top down: one day or evening between two hours, a whole month, and (in a
// folded menu, native details/summary, no script) any range of several days with two full dates.
// `values`: the start/end strings of the free range (computed by the server, or, after a validation error, exactly what the user
// typed). `day`: the values of the day block ({ jour, de, a }: today from 00:00 to 23:59 by default, or what the user typed).
// `error`: plain text, or null; `errorFor` ("day", "month" or "range") says which block it belongs to, and the message is placed in
// that block; for "range" (and only then) the folded menu is opened by the server (attribute open). Any other `errorFor` puts the
// message at the top of the page (an unknown shortcut). `month` and `years`: what the monthly block shows as selected (the previous month by
// default) and the years it offers; all constants of the server, never taken from the browser as they are.
export function renderReleveFilters(
  { csrfToken, values, day = dayDefaults(), error = null, errorFor = null, month = previousMonth(), years = allowedYears() },
  { htmlPage, errorMessage, escapeHtml },
) {
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">`;
  const monthOptions = MONTH_NAMES.map(
    (name, i) => `<option value="${i + 1}"${i + 1 === month.month ? " selected" : ""}>${capitalized(name)}</option>`,
  ).join("\n        ");
  const yearOptions = years
    .map((year) => `<option value="${year}"${year === month.year ? " selected" : ""}>${year}</option>`)
    .join("\n        ");
  const message = error ? errorMessage(escapeHtml(error)) : "";
  const at = (block) => (errorFor === block ? message : "");
  const top = ["day", "month", "range"].includes(errorFor) ? "" : message;
  return htmlPage(
    "Choisir la période",
    `${backButton(AREA_HREF, "Retour à l'espace")}
  <h1>Choisir la période</h1>
  ${top}
  <div class="raccourcis">
    <form method="post" action="${FILTERS_HREF}/ticket" aria-label="Raccourcis">
      ${csrf}
      <span class="titre-raccourcis">Raccourcis :</span>
      <button type="submit" name="raccourci" value="aujourdhui">Aujourd'hui</button>
      <button type="submit" name="raccourci" value="hier">Hier</button>
      <button type="submit" name="raccourci" value="6h">6 dernières heures</button>
    </form>
  </div>
  <form method="post" action="${FILTERS_HREF}/ticket" class="bloc-periode releve-jour" aria-labelledby="titre-jour">
    ${csrf}
    <h2 id="titre-jour">Une journée ou une soirée</h2>
    <p>Choisissez le jour, puis l'heure de début et l'heure de fin.</p>
    ${at("day")}
    <p><label for="jour">Jour</label>
      <input type="date" id="jour" name="jour" value="${escapeHtml(day.jour)}" autocomplete="off" required></p>
    <div class="heures">
      <p><label for="de">De</label>
        <input type="time" id="de" name="de" value="${escapeHtml(day.de)}" autocomplete="off" required></p>
      <p><label for="a">À</label>
        <input type="time" id="a" name="a" value="${escapeHtml(day.a)}" autocomplete="off" required></p>
    </div>
    <p class="aide-jour">Votre soirée finit après minuit ? Indiquez par exemple de 18:00 à 02:00 : le relevé s'arrêtera à 02:00 le lendemain.</p>
    <p><button type="submit">Voir le relevé</button></p>
  </form>
  <form method="post" action="${FILTERS_HREF}/ticket" class="bloc-periode releve-mensuel" aria-labelledby="titre-mensuel">
    ${csrf}
    <h2 id="titre-mensuel">Un mois complet</h2>
    <p>Du 1er au dernier jour du mois.</p>
    ${at("month")}
    <p><label for="mois">Mois</label>
      <select id="mois" name="mois" required>
        ${monthOptions}
      </select></p>
    <p><label for="annee">Année</label>
      <select id="annee" name="annee" required>
        ${yearOptions}
      </select></p>
    <p><button type="submit">Voir le mois</button></p>
  </form>
  <details class="bloc-periode autre-periode"${errorFor === "range" ? " open" : ""}>
    <summary>Autre période (plusieurs jours)</summary>
    ${at("range")}
    <form method="post" action="${FILTERS_HREF}/ticket">
      ${csrf}
      <p><label for="start">Début</label>
        <input type="datetime-local" id="start" name="start" value="${escapeHtml(values.start)}" required></p>
      <p><label for="end">Fin</label>
        <input type="datetime-local" id="end" name="end" value="${escapeHtml(values.end)}" required></p>
      <p><button type="submit">Voir la période</button></p>
    </form>
  </details>`,
    { toolName: TOOL_NAME },
  );
}

// The ticket. `model`: the result of ticketModel(). `pdf`: also offer the PDF download (a POST form carrying the range again).
export function renderReleveTicket({ model: m, csrfToken, pdf = false }, { htmlPage, escapeHtml }) {
  const rows = m.rows
    .map(
      (row) => `<li class="ligne">
        <span class="date">${escapeHtml(row.when)}</span>
        <span class="numero">${escapeHtml(row.number)}</span>
        <span class="contrepartie">${escapeHtml(row.counterparty)}</span>
        <span class="description">${escapeHtml(row.description)}</span>
        <span class="montant">${escapeHtml(row.amount)}</span>
      </li>`,
    )
    .join("\n      ");

  const summary = m.summary
    .map((line) => `<div${line.net ? ' class="net"' : ""}><dt>${escapeHtml(line.label)}</dt>
      <dd>${escapeHtml(line.value)}</dd></div>`)
    .join("\n    ");

  const download = pdf
    ? `<form method="post" action="${FILTERS_HREF}/ticket.pdf" class="telechargement">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
      ${
        m.month
          ? `<input type="hidden" name="mois" value="${escapeHtml(m.month.month)}">
      <input type="hidden" name="annee" value="${escapeHtml(m.month.year)}">`
          : m.day
            ? `<input type="hidden" name="jour" value="${escapeHtml(m.day.jour)}">
      <input type="hidden" name="de" value="${escapeHtml(m.day.de)}">
      <input type="hidden" name="a" value="${escapeHtml(m.day.a)}">`
            : `<input type="hidden" name="start" value="${escapeHtml(m.start)}">
      <input type="hidden" name="end" value="${escapeHtml(m.end)}">`
      }
      <button type="submit">Télécharger le PDF</button>
    </form>
    `
    : "";

  return htmlPage(
    m.title,
    `<main class="ticket">
  <nav class="navigation-ticket" aria-label="Navigation">
    ${backButton(AREA_HREF, "Retour à l'espace")}
    ${backButton(FILTERS_HREF, "Changer de période")}
  </nav>
  <h1>${escapeHtml(m.title)}</h1>
  ${m.merchantName ? `<p class="commercant">${escapeHtml(m.merchantName)}</p>` : ""}
  <p class="periode">${escapeHtml(m.period)}</p>
  <p class="generation">${escapeHtml(m.generated)}</p>

  <h2>Résumé</h2>
  <p class="unite">${escapeHtml(m.unit)}</p>
  <dl class="resume">
    ${summary}
  </dl>

  <h2>Détail</h2>
  ${m.warning ? `<p class="avertissement" role="alert">${escapeHtml(m.warning)}</p>` : ""}
  ${
    rows
      ? `<ol class="detail">
      ${m.month ? columnHeader : ""}${rows}
  </ol>`
      : `<p class="vide">${escapeHtml(m.emptyText)}</p>`
  }

  <div class="actions">
    ${download}
  </div>
</main>`,
    // The month ticket prints on A4 (the page-mois rules of style.css); the ticket of a period keeps the 80 mm ticket.
    { toolName: TOOL_NAME, scripts: [PRINT_SCRIPT], htmlClass: m.month ? "page-mois" : "" },
  );
}

// A refused request (bad security token...). `hasSession`: then the way back is the filters, otherwise the area.
export function renderReleveForbidden(message, { hasSession }, { htmlPage, errorMessage, escapeHtml }) {
  const back = hasSession ? `<p><a href="${FILTERS_HREF}">Retour aux filtres</a></p>` : backToArea;
  return htmlPage(
    "Requête refusée",
    `<h1>Requête refusée</h1>
  ${errorMessage(escapeHtml(message))}
  ${back}`,
    { toolName: TOOL_NAME },
  );
}

// Cyclos refuses (403): the account is not allowed to read its statement. The session stays open.
export function renderReleveAccessDenied({ htmlPage, errorMessage }) {
  return htmlPage(
    "Accès refusé",
    `<h1>Accès refusé</h1>
  ${errorMessage("Votre compte n'a pas l'autorisation d'utiliser cet outil.")}
  <p><a href="${FILTERS_HREF}">Retour</a></p>
  ${backToArea}`,
    { toolName: TOOL_NAME },
  );
}

// Cyclos refuses (403) or gives nothing (empty list) on the list of accounts: no money account, or no right to read it through the API.
export function renderReleveAccountsDenied({ htmlPage, errorMessage }) {
  return htmlPage(
    "Accès aux comptes refusé",
    `<h1>Accès aux comptes refusé</h1>
  ${errorMessage("Cyclos refuse l'accès aux comptes de cet utilisateur. Soit il n'a pas de compte de monnaie, soit l'accès par l'API ne lui est pas autorisé. Contactez l'association.")}
  <p><a href="${FILTERS_HREF}">Retour</a></p>
  ${backToArea}`,
    { toolName: TOOL_NAME },
  );
}

// Cyclos does not answer (or too slowly, or with an error).
export function renderReleveUnavailable({ htmlPage, errorMessage }) {
  return htmlPage(
    "Cyclos ne répond pas",
    `<h1>Cyclos ne répond pas</h1>
  ${errorMessage("Impossible de lire le relevé auprès de Cyclos pour le moment. Réessayez dans quelques instants.")}
  <p><a href="${FILTERS_HREF}">Retour aux filtres</a></p>
  ${backToArea}`,
    { toolName: TOOL_NAME },
  );
}

// A reading of the statement is already running for this session (one at a time): nothing is stacked up.
export function renderReleveBusy({ htmlPage, errorMessage }) {
  return htmlPage(
    "Lecture en cours",
    `<h1>Lecture en cours</h1>
  ${errorMessage("Un relevé est déjà en cours de lecture pour votre session. Attendez qu'il s'affiche, puis recommencez si besoin.")}
  <p><a href="${FILTERS_HREF}">Retour aux filtres</a></p>
  ${backToArea}`,
    { toolName: TOOL_NAME },
  );
}
