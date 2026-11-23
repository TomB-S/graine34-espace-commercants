// Small functions shared by the pages: escaping of the text put in HTML, error message, amounts shown the French way.
// Pure: no state, no Node module. server.js re-exports escapeHtml and formatAmount (the tests import them from there).

// Values come from a remote API (or the user): escape them before putting them in HTML.
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// An error message: never conveyed by colour alone (icon + "Erreur :" label).
export function errorMessage(text) {
  return `<p class="erreur" role="alert"><span class="icone" aria-hidden="true">⚠</span> <strong>Erreur :</strong> ${text}</p>`;
}

// The logo of the header, shared by every page. `areaHref`: where the logo leads (the merchants' area, in the multi-merchant mode),
// or null for a plain image (single-merchant mode and the executable: nothing changes there). The link carries a clear accessible name;
// the image keeps its own alternative text.
export function logoMarkup(areaHref = null) {
  const image = `<img src="/logo.png" width="104" height="40" alt="La Graine 34, monnaie locale">`;
  return areaHref
    ? `<span class="logo"><a class="lien-logo" href="${escapeHtml(areaHref)}" aria-label="Accueil de l'espace commerçants">${image}</a></span>`
    : `<span class="logo">${image}</span>`;
}

// Formats a Cyclos amount string ("1234.5") the French way ("1 234,50", with a narrow no-break space between thousands). String
// based: no float rounding.
// `signed` adds "+" to positive amounts; negative ones always keep their "-".
export function formatAmount(value, digits = 2, { signed = false } = {}) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return String(value);
  const [, minus, integer, decimals = ""] = match;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  const number =
    digits > 0 ? `${grouped},${decimals.padEnd(digits, "0")}` : grouped;
  const isZero = /^[0,\u202f]*$/.test(number);
  if (minus && !isZero) return `-${number}`;
  return signed && !isZero ? `+${number}` : number;
}
