// HTML of the cash register page (/caisse): pure functions, state in, text out.
//
// No script, no inline style, no <meta refresh> (the reload is the `Refresh` HTTP header, set by
// the route): the Content-Security-Policy of the site does not change. Every text that comes from
// Cyclos (payer, description, number) goes through escapeHtml. The state is always written in words,
// never by colour alone.
//
// The helpers of server.js (escapeHtml, formatAmount, htmlPage, errorMessage, logoutForm) are given
// by the caller: importing server.js from here would be a circular import.
import { ticketDisplay } from "./ticket-store.js";

const TITLE = "Caisse : paiements reçus";
const LIST_SIZE = 10;
const EMPTY_TITLE = "Aucun paiement pour l'instant";
const EMPTY_HELP = "Le prochain paiement s'affichera ici dès qu'il sera reçu.";

// Banner of the listening. Nothing while it works (the "fallback" state, where the notification setting
// is not confirmed at Cyclos, is a live stream too: the payments still show up, so no banner). A banner
// only when the merchant must know something. No "État :" prefix.
const RECONNECTING = "Connexion interrompue, reconnexion en cours. Les nouveaux paiements peuvent apparaître avec du retard.";
const UNREADABLE = "Impossible de lire les paiements pour le moment. Prévenir l'équipe La Graine 34.";

function stateBlock(status) {
  if (status === "live" || status === "fallback") return "";
  if (status === "error") {
    return `<p class="caisse-bandeau erreur" role="status"><span class="icone" aria-hidden="true">⚠</span> ${UNREADABLE}</p>`;
  }
  if (status === "reconnecting" || status === "degraded") {
    return `<p class="caisse-bandeau avertissement" role="status"><span class="icone" aria-hidden="true">⚠</span> ${RECONNECTING}</p>`;
  }
  // "starting" (not in the table of the instructions): the first connection, a neutral line as before.
  return '<p class="caisse-etat" role="status">Connexion à Cyclos en cours</p>';
}

// Small badge of the header: only while the listening works. It disappears during a reconnection.
function liveBadge(status) {
  if (status !== "live" && status !== "fallback") return "";
  return '<span class="caisse-direct"><span class="caisse-direct-point" aria-hidden="true"></span>En direct</span>';
}

// The page of the merchant. `view`: { status, tickets } from the listener manager. `options`:
// { refreshSeconds, hidePayerName, now }. `helpers`: see the top of the file.
export function renderCaissePage(view, { refreshSeconds, hidePayerName, now, csrfToken }, helpers) {
  const { escapeHtml, formatAmount, logoutForm, stylesheetHref = "/style.css" } = helpers;
  const e = escapeHtml;
  const show = (ticket) => ticketDisplay(ticket, { now, formatAmount });
  const payerOf = (d) => (hidePayerName ? "Client" : d.payer || "Payeur inconnu");
  const amountOf = (d) => d.amount ?? (d.amountState === "unreadable" ? "Montant indisponible" : "Montant en cours de lecture");

  const [latest, ...others] = view.tickets;
  let main = "";
  if (latest) {
    const d = show(latest);
    main += `<section class="caisse-gros${d.isFresh ? " caisse-gros-neuf" : ""}" aria-label="Dernier paiement reçu">
    ${d.isNew ? '<p class="caisse-nouveau">Nouveau</p>' : ""}
    <p class="caisse-gros-payeur">${e(payerOf(d))}</p>
    <p class="${d.amount === null ? "caisse-gros-attente" : "caisse-gros-montant"}">${e(amountOf(d))}</p>
    <p class="caisse-gros-heure">${e(d.dateLine)}</p>
    ${d.description ? `<p class="caisse-gros-description">Description : ${e(d.description)}</p>` : ""}
    ${d.number ? `<p class="caisse-gros-numero">N° ${e(d.number)}</p>` : ""}
  </section>`;
    const rows = others.slice(0, LIST_SIZE).map((ticket) => {
      const r = show(ticket);
      return `<li class="caisse-ligne">
      <span class="caisse-heure">${e(r.time)}</span>
      <span class="caisse-qui">
        <span class="caisse-payeur">${e(payerOf(r))}${r.isNew ? ' <span class="caisse-nouveau-petit">Nouveau</span>' : ""}</span>
        ${r.description ? `<span class="caisse-description">${e(r.description)}</span>` : ""}
      </span>
      <span class="caisse-montant">${e(amountOf(r))}</span>
    </li>`;
    });
    if (rows.length > 0) {
      main += `
  <h2>Paiements précédents</h2>
  <ol class="caisse-precedents">
    ${rows.join("\n    ")}
  </ol>`;
    }
  } else if (view.status !== "starting") {
    // Only while the listening works: during a reconnection or an error the banner speaks, an "empty" line would mislead.
    if (view.status === "live" || view.status === "fallback") {
      main += `<div class="caisse-vide"><p class="caisse-vide-titre">${EMPTY_TITLE}</p><p>${EMPTY_HELP}</p></div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${e(stylesheetHref)}">
  <title>${e(TITLE)}</title>
</head>
<body>
  <header class="entete caisse-entete">
    <span class="logo"><img src="/logo.png" width="104" height="40" alt="La Graine 34, monnaie locale"></span>
    <h1 class="nom-outil">${e(TITLE)}</h1>
    ${liveBadge(view.status)}
    ${logoutForm(csrfToken)}
  </header>
  <div class="page">
  ${stateBlock(view.status)}
  ${main}
  <p class="caisse-actualisation">Mise à jour automatique toutes les ${e(refreshSeconds)} secondes.</p>
  </div>
</body>
</html>`;
}

// Pages that explain a refusal. `kind`: "denied" (403, not the registered merchant), "unavailable"
// (503, the service cannot tell or cannot listen right now), "busy" (503, too many listeners).
export function renderCaisseRefused(kind, csrfToken, { escapeHtml, htmlPage, errorMessage, logoutForm }) {
  const pages = {
    denied: {
      title: "Accès à la caisse refusé",
      text: "votre compte n'est pas inscrit à la page caisse.",
    },
    unavailable: {
      title: "Caisse indisponible",
      text: "le service de notification est momentanément indisponible. Réessayez dans un instant.",
    },
    busy: {
      title: "Caisse très sollicitée",
      text: "trop d'écoutes sont en cours en ce moment. Réessayez dans un instant.",
    },
  };
  const { title, text } = pages[kind] ?? pages.unavailable;
  return htmlPage(
    title,
    `<h1>${escapeHtml(title)}</h1>
  ${errorMessage(escapeHtml(text))}
  <p><a href="/">Retour</a></p>
  ${csrfToken ? logoutForm(csrfToken) : ""}`,
  );
}
