// HTML of the statement of transactions (/espace/releve): pure functions, state in, text out. A filter page (two dates and three
// shortcuts) and the end-of-service ticket. Under /espace, so the pages link back to the area ("Retour à l'espace"), there is no
// logout button here (the area has its own).
//
// Same rules as the other pages: no script, no inline style (the CSP of these pages forbids both), every value that is not a
// constant goes through escapeHtml. The helpers of server.js are given by the caller (importing it from here would be circular).

import { MONTH_NAMES, allowedYears, previousMonth } from "./releve-calcul.js";

export const TOOL_NAME = "Relevés de service";
const FILTERS_HREF = "/espace/releve";
const AREA_HREF = "/espace";

const backToArea = `<p><a href="${AREA_HREF}">Retour à l'espace</a></p>`;

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The filter page. `values`: the start/end strings to put in the fields (computed by the server, or, after a validation error,
// exactly what the user typed). `error`: plain text, or null. `month` and `years`: what the monthly block shows as selected (the
// previous month by default) and the years it offers; both are constants of the server, never taken from the browser as they are.
export function renderReleveFilters(
  { csrfToken, values, error = null, month = previousMonth(), years = allowedYears() },
  { htmlPage, errorMessage, escapeHtml },
) {
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">`;
  const monthOptions = MONTH_NAMES.map(
    (name, i) => `<option value="${i + 1}"${i + 1 === month.month ? " selected" : ""}>${capitalized(name)}</option>`,
  ).join("\n        ");
  const yearOptions = years
    .map((year) => `<option value="${year}"${year === month.year ? " selected" : ""}>${year}</option>`)
    .join("\n        ");
  return htmlPage(
    "Choisir la plage horaire",
    `<h1>Choisir la plage horaire</h1>
  ${error ? errorMessage(escapeHtml(error)) : ""}
  <p class="raccourcis">Raccourcis :
    <a href="${FILTERS_HREF}?preset=aujourdhui">Aujourd'hui</a>
    <a href="${FILTERS_HREF}?preset=hier">Hier</a>
    <a href="${FILTERS_HREF}?preset=6h">6 dernières heures</a>
  </p>
  <form method="post" action="${FILTERS_HREF}/ticket">
    ${csrf}
    <p><label for="start">Début</label>
      <input type="datetime-local" id="start" name="start" value="${escapeHtml(values.start)}" required></p>
    <p><label for="end">Fin</label>
      <input type="datetime-local" id="end" name="end" value="${escapeHtml(values.end)}" required></p>
    <p><button type="submit">Voir le relevé</button></p>
  </form>
  <form method="post" action="${FILTERS_HREF}/ticket" class="releve-mensuel" aria-labelledby="titre-mensuel">
    ${csrf}
    <h2 id="titre-mensuel">Relevé mensuel</h2>
    <p>Un mois complet, du 1er au dernier jour.</p>
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
  ${backToArea}`,
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
      ${rows}
  </ol>`
      : `<p class="vide">${escapeHtml(m.emptyText)}</p>`
  }

  <div class="actions">
    ${download}<p><a href="${FILTERS_HREF}">Changer la plage horaire</a></p>
    ${backToArea}
  </div>
</main>`,
    { toolName: TOOL_NAME },
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
