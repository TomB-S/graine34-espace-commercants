// Who may open the cash register page in the multi-merchant mode: a whitelist read from CAISSE_ALLOWED_USERS (see
// caisse-config.js). A merchant is allowed when his internal Cyclos number is listed OR his e-mail address is listed
// (compared without case and without the spaces around it). Nobody is allowed by default: an empty list refuses everyone,
// and so does an identity that cannot be read with certainty.
//
// Pure functions, no network. The list is read once at start: a change of the setting needs a restart.

const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;

// `allowedUsers`: { ids, emails } as built by readCaisseConfig. Returns { isAllowed({ id, email }) }.
export function createAllowedUsers(allowedUsers) {
  const ids = new Set(allowedUsers?.ids ?? []);
  const emails = new Set((allowedUsers?.emails ?? []).map((email) => String(email).trim().toLowerCase()));
  return {
    // `id`: internal Cyclos number (text), `email`: address if Cyclos gave one. Anything unreadable counts as absent.
    isAllowed({ id, email } = {}) {
      if (typeof id === "string" && PLAIN_ID.test(id) && ids.has(id)) return true;
      if (typeof email === "string" && email.trim() !== "" && emails.has(email.trim().toLowerCase())) return true;
      return false;
    },
    get size() {
      return ids.size + emails.size;
    },
  };
}

// The log line for a refused account: the internal number (not a secret) so that an administrator can add it to the list.
// Never the e-mail address, never the login typed, never anything else about the person.
export function refusedAccountLine(id) {
  const shown = typeof id === "string" && PLAIN_ID.test(id) ? id : "illisible";
  return `compte refusé (absent de CAISSE_ALLOWED_USERS), numéro interne Cyclos : ${shown}`;
}
