// HTML of the merchants' area (/espace): pure functions, state in, text out. The entrance of the merchants: a login form,
// then, once the account has been checked and allowed, two links (cash register notifications, statement).
//
// Same rules as the cash register page: no inline script, no inline style (the CSP forbids them), every value that is not a
// constant goes through escapeHtml. The helpers of server.js are given by the caller (importing server.js from here would be a
// circular import).

export const TITLE = "Espace commerçants";

// One message for a wrong password AND for an account that is not allowed: the page must not tell who is on the list.
export const REFUSED_TEXT = "Identifiants incorrects ou accès non autorisé.";

// The login form. `message`: an error text (already plain text), or null.
export function renderEspaceLogin({ message = null } = {}, { htmlPage, errorMessage, escapeHtml }) {
  return htmlPage(
    TITLE,
    `<h1>${TITLE}</h1>
  <p>Connectez-vous avec votre compte Cyclos.</p>
  ${message ? errorMessage(escapeHtml(message)) : ""}
  <form method="post" action="/espace/connexion">
    <p><label>Identifiant : <input type="text" name="login" required autofocus autocomplete="username"></label></p>
    <p><label>Mot de passe : <input type="password" name="password" required autocomplete="current-password"></label></p>
    <p><button type="submit">Se connecter</button></p>
  </form>`,
    { toolName: TITLE },
  );
}

// The page of a connected merchant. `releveUrl`: address of the statement, or null (then "Bientôt disponible", no link).
export function renderEspaceHome({ csrfToken, releveUrl = null }, { htmlPage, escapeHtml }) {
  const releve = releveUrl
    ? `<li><a class="espace-lien" href="${escapeHtml(releveUrl)}">Relevé de transactions</a></li>`
    : `<li><span class="espace-lien espace-bientot">Relevé de transactions <span class="espace-bientot-texte">Bientôt disponible</span></span></li>`;
  return htmlPage(
    TITLE,
    `<h1>${TITLE}</h1>
  <p>Que souhaitez-vous faire ?</p>
  <ul class="espace-liens">
    <li><a class="espace-lien" href="/caisse">Notifications de caisse</a></li>
    ${releve}
  </ul>
  <p class="espace-note">Pour ouvrir les notifications de caisse, vous devrez vous connecter une seconde fois.</p>
  <form method="post" action="/espace/deconnexion">
    <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
    <button type="submit">Se déconnecter</button>
  </form>`,
    { toolName: TITLE },
  );
}
