// HTML of the cash register page (/caisse): pure functions, state in, text out.
//
// The page is complete without any script (it is the fallback): the only script is the external file
// /caisse.js, which then updates it from /caisse/data; with no script, a <meta refresh> inside <noscript>
// reloads the page. No inline script, no inline style. Every text that comes from Cyclos (payer,
// description, number) goes through escapeHtml. The state is always written in words, never by colour alone.
//
// The helpers of server.js (escapeHtml, formatAmount, htmlPage, errorMessage, logoutForm) are given
// by the caller: importing server.js from here would be a circular import.
import { ticketDisplay } from "./ticket-store.js";
import { TEXTS } from "../web/js/caisse-texts.js";
import { pollFooterText } from "../web/js/refresh-logic.js";
import { LIST_SIZE, bannerOf, payerText, amountText } from "./caisse-data.js";

const TITLE = "Caisse : paiements reçus";

// Banner of the listening, as HTML. Nothing while it works; a warning or an error with an icon and a sentence;
// "starting" is a neutral line. The three zones below (header badge, banner, content) are the ones the script updates.
function stateBlock(status, e) {
  const banner = bannerOf(status);
  if (!banner) return "";
  if (banner.level === "info") return `<p class="caisse-etat" role="status">${e(banner.text)}</p>`;
  const kind = banner.level === "error" ? "erreur" : "avertissement";
  return `<p class="caisse-bandeau ${kind}" role="status"><span class="icone" aria-hidden="true">⚠</span> ${e(banner.text)}</p>`;
}

// Small badge of the header: only while the listening works. It disappears during a reconnection.
function liveBadge(status) {
  if (status !== "live" && status !== "fallback") return "";
  return `<span class="caisse-direct"><span class="caisse-direct-point" aria-hidden="true"></span>${TEXTS.live}</span>`;
}

// The page of the merchant. `view`: { status, tickets } from the listener manager. `options`:
// { refreshSeconds (reload without script), pollSeconds (script), hidePayerName, nameOrder, hiddenDescriptions, now }. `helpers`: see the top of the file.
export function renderCaissePage(view, { refreshSeconds, pollSeconds = 3, hidePayerName, nameOrder, hiddenDescriptions, now, csrfToken }, helpers) {
  const { escapeHtml, formatAmount, logoutForm, stylesheetHref = "/style.css" } = helpers;
  const e = escapeHtml;
  const show = (ticket) => ticketDisplay(ticket, { now, formatAmount, hiddenDescriptions });
  const payerOf = (d) => payerText(d, hidePayerName, nameOrder);
  const amountOf = amountText;

  const [latest, ...others] = view.tickets;
  let main = "";
  if (latest) {
    const d = show(latest);
    main += `<section class="caisse-gros${d.isFresh ? " caisse-gros-neuf" : ""}" aria-label="${TEXTS.lastPayment}">
    ${d.isNew ? `<p class="caisse-nouveau">${TEXTS.newMark}</p>` : ""}
    <p class="caisse-gros-payeur">${e(payerOf(d))}</p>
    <p class="${d.amount === null ? "caisse-gros-attente" : "caisse-gros-montant"}">${e(amountOf(d))}</p>
    <p class="caisse-gros-heure">${e(d.dateLine)}</p>
    ${d.description ? `<p class="caisse-gros-description">${TEXTS.descriptionLabel}${e(d.description)}</p>` : ""}
    ${d.number ? `<p class="caisse-gros-numero">${TEXTS.numberLabel}${e(d.number)}</p>` : ""}
  </section>`;
    const rows = others.slice(0, LIST_SIZE).map((ticket) => {
      const r = show(ticket);
      return `<li class="caisse-ligne">
      <span class="caisse-heure">${e(r.time)}</span>
      <span class="caisse-qui">
        <span class="caisse-payeur">${e(payerOf(r))}${r.isNew ? ` <span class="caisse-nouveau-petit">${TEXTS.newMark}</span>` : ""}</span>
        ${r.description ? `<span class="caisse-description">${e(r.description)}</span>` : ""}
      </span>
      ${r.number ? `<span class="caisse-numero">${TEXTS.numberLabel}${e(r.number)}</span>\n      ` : ""}<span class="caisse-montant">${e(amountOf(r))}</span>
    </li>`;
    });
    if (rows.length > 0) {
      main += `
  <h2>${TEXTS.previous}</h2>
  <ol class="caisse-precedents">
    ${rows.join("\n    ")}
  </ol>`;
    }
  } else if (view.status !== "starting") {
    // Only while the listening works: during a reconnection or an error the banner speaks, an "empty" line would mislead.
    if (view.status === "live" || view.status === "fallback") {
      main += `<div class="caisse-vide"><p class="caisse-vide-titre">${TEXTS.emptyTitle}</p><p>${TEXTS.emptyHelp}</p></div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/png" href="/icon.png">
  <link rel="stylesheet" href="${e(stylesheetHref)}">
  <noscript><meta http-equiv="refresh" content="${e(refreshSeconds)}"></noscript>
  <script type="module" src="/caisse.js"></script>
  <title>${e(TITLE)}</title>
</head>
<body>
  <header class="entete caisse-entete">
    <span class="logo"><img src="/logo.png" width="104" height="40" alt="La Graine 34, monnaie locale"></span>
    <h1 class="nom-outil">${e(TITLE)}</h1>
    <span class="caisse-zone" id="caisse-zone-direct">${liveBadge(view.status)}</span>
    ${logoutForm(csrfToken)}
  </header>
  <div class="page" id="caisse" data-poll-seconds="${e(pollSeconds)}" data-data-url="/caisse/data" data-login-url="/">
  <div class="caisse-zone" id="caisse-zone-son"></div>
  <div class="caisse-zone" id="caisse-zone-actualiser"></div>
  <div class="caisse-zone" id="caisse-zone-notif"></div>
  <div class="caisse-zone" id="caisse-zone-etat">${stateBlock(view.status, e)}</div>
  <div class="caisse-zone" id="caisse-zone-contenu">
  ${main}
  </div>
  <p class="caisse-actualisation" id="caisse-actualisation">${e(pollFooterText(pollSeconds === 0 ? 0 : refreshSeconds))}</p>
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
