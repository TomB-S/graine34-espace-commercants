// HTML of the merchants' area (/espace): pure functions, state in, text out. The entrance of the merchants: a login form,
// then, once the account has been checked and allowed, two entries (cash register notifications and statement of transactions).
//
// Same rules as the cash register page: no inline script, no inline style (the CSP forbids them), every value that is not a
// constant goes through escapeHtml. The helpers of server.js are given by the caller (importing server.js from here would be a
// circular import).

export const TITLE = "Espace commerçants";

// The only script of the login pages: the eye button next to the password field (made by the script, not by this HTML).
export const PASSWORD_SCRIPT = "/password-toggle.js";

// One message for a wrong password AND for an account that is not allowed: the page must not tell who is on the list.
export const REFUSED_TEXT = "Identifiants incorrects ou accès non autorisé.";

// The login form. `message`: an error text (already plain text), or null.
export function renderEspaceLogin({ message = null } = {}, { htmlPage, errorMessage, escapeHtml }) {
  return htmlPage(
    TITLE,
    `<h1>${TITLE}</h1>
  <p>Connectez-vous avec votre compte.</p>
  ${message ? errorMessage(escapeHtml(message)) : ""}
  <form method="post" action="/espace/connexion">
    <p><label>Identifiant : <input type="text" name="login" required autofocus autocomplete="username"></label></p>
    <p><label for="password">Mot de passe :</label>
      <input type="password" id="password" name="password" required autocomplete="current-password"></p>
    <p><button type="submit">Se connecter</button></p>
  </form>`,
    { toolName: TITLE, scripts: [PASSWORD_SCRIPT] },
  );
}

// The page of a connected merchant: two entries. The cash register notifications are a POST form that looks like a link, so that the
// cash register opens without a second login; the statement is a link to /espace/releve, which uses the same session.
export function renderEspaceHome({ csrfToken }, { htmlPage, escapeHtml }) {
  return htmlPage(
    TITLE,
    `<h1>${TITLE}</h1>
  <p>Que souhaitez-vous faire ?</p>
  <ul class="espace-liens">
    <li>
      <form class="espace-lien-form" method="post" action="/espace/caisse">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
        <button type="submit" class="espace-lien">Notifications de caisse</button>
      </form>
    </li>
    <li><a class="espace-lien" href="/espace/releve">Relevé de transactions</a></li>
  </ul>
  <form method="post" action="/espace/deconnexion">
    <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
    <button type="submit">Se déconnecter</button>
  </form>`,
    { toolName: TITLE },
  );
}
