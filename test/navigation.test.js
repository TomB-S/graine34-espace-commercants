// === WHAT THIS FILE CHECKS ===
// Navigation of the statement: the "Retour à l'espace" button at the top of the filters page, the "Changer de période" button at the top
// of the ticket (day, month and shortcut), the logo of the header that leads to the merchants' area in the multi-merchant mode (pages of
// the area, of the cash register and of the statement) and stays a plain image in the single-merchant mode and in the executable, the
// links hidden on paper, nothing inline, and the security policies unchanged. All names and secrets are fictitious.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { appTest, EXPECTED_CSP } from "./support/harness.js";
import { CAISSE_OPTIONS } from "./support/options.js";
import { options, connected, browser } from "./support/releve-support.js";
import { logoMarkup } from "../src/format.js";
import { readCaisseConfig } from "../src/caisse-config.js";
import { readFile } from "node:fs/promises";

const CSP_SANS_SCRIPT = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const CSP_TICKET = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const PLAIN_LOGO = '<span class="logo"><img src="/logo.png" width="104" height="40" alt="La Graine 34, monnaie locale"></span>';
const LINKED_LOGO = '<span class="logo"><a class="lien-logo" href="/espace" aria-label="Accueil de l\'espace commerçants"><img src="/logo.png" width="104" height="40" alt="La Graine 34, monnaie locale"></a></span>';
const nothingInline = (html, label) => {
  assert.ok(!/<style/i.test(html) && !/\sstyle=/i.test(html) && !/\son[a-z]+=/i.test(html), `${label}: no inline style or handler`);
  assert.ok(!/<script(?![^>]* src=)/i.test(html), `${label}: no inline script`);
};

// ---------------------------------------------------------------- the markup of the logo

// Intention: the shared piece of markup: a link with a clear accessible name around the image, which keeps its alternative text; with no
// address it is exactly the plain image of before.
test("logo : lien avec nom accessible clair, image avec son texte alternatif ; sans adresse, l'image seule d'avant", () => {
  assert.equal(logoMarkup("/espace"), LINKED_LOGO);
  assert.equal(logoMarkup(null), PLAIN_LOGO);
  assert.equal(logoMarkup(), PLAIN_LOGO);
});

// Intention: the executable stays single-merchant (the multi-merchant flag is ignored there), so its logo is the plain image.
test("logo : dans l'exécutable le mode multi est ignoré, donc pas de lien", () => {
  const config = readCaisseConfig({ CAISSE_MULTI_MERCHANT: "true" }, { enabled: true, credentialsFromLogin: true });
  assert.equal(config.multiMerchantIgnored, true);
  assert.ok(!config.multiMerchant);
});

// ---------------------------------------------------------------- buttons at the top of the pages

// Intention: the filters page opens with a "Retour à l'espace" button to /espace, between the header and the title, and has no second
// link to the area at the bottom; keyboard focus is the one of every link (a real link, no tabindex).
appTest("navigation : bouton « Retour à l'espace » en haut des filtres", options(), async (app) => {
  const { b } = await connected(app, []);
  const html = await (await b.request("/espace/releve")).text();
  const button = '<p class="retour"><a class="lien-retour" href="/espace">Retour à l\'espace</a></p>';
  assert.ok(html.includes(button));
  assert.ok(html.indexOf('<header class="entete">') < html.indexOf(button) && html.indexOf(button) < html.indexOf("<h1>Choisir la période</h1>"));
  assert.equal([...html.matchAll(/Retour à l'espace/g)].length, 1, "one link to the area, at the top");
  assert.ok(!/tabindex/.test(html));
  nothingInline(html, "filters");
});

// Intention: every ticket (a day, a month, a shortcut, two dates) has a "Changer de période" button at the top, to the filters, before the
// ticket itself; the link at the bottom is still there for a long ticket.
appTest("navigation : bouton « Changer de période » en haut du ticket (jour, mois, raccourci, dates)", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const year = DateTime.now().setZone("Europe/Paris").year - 1;
  const forms = {
    jour: { jour: "2026-01-10", de: "11:00", a: "14:00" },
    mois: { mois: "1", annee: String(year) },
    raccourci: { raccourci: "hier" },
    dates: { start: "2026-01-10T00:00", end: "2026-01-10T23:59" },
  };
  const button = '<p class="retour"><a class="lien-retour" href="/espace/releve">Changer de période</a></p>';
  for (const [mode, form] of Object.entries(forms)) {
    const res = await b.ticket({ csrf, ...form });
    assert.equal(res.status, 200, mode);
    assert.equal(res.headers.get("content-security-policy"), CSP_TICKET, mode);
    const html = await res.text();
    assert.ok(html.includes(button), mode);
    assert.ok(html.indexOf(button) < html.indexOf('<main class="ticket">'), `${mode}: before the ticket`);
    assert.equal([...html.matchAll(/>Changer de période</g)].length, 2, `${mode}: top and bottom`);
    nothingInline(html, mode);
  }
});

// ---------------------------------------------------------------- the logo in the multi-merchant mode

// Intention: in the multi-merchant mode the logo leads to the area on every page that belongs to it: the login and the home of the area,
// the filters and the ticket of the statement, the cash register; a simple GET link: no session or policy is touched.
appTest("navigation : le logo est un lien vers /espace sur les pages de l'espace, du relevé et de la caisse", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const stranger = browser(app);
  const pages = {
    "espace (connexion)": await stranger.request("/espace"),
    "espace (accueil)": await b.request("/espace"),
    "relevé (filtres)": await b.request("/espace/releve"),
    "relevé (ticket)": await b.ticket({ csrf, raccourci: "hier" }),
  };
  assert.equal((await b.request("/espace/caisse", { method: "POST", form: { csrf }, headers: { Origin: app.base } })).status, 303);
  pages["caisse"] = await b.request("/caisse");
  for (const [name, res] of Object.entries(pages)) {
    assert.equal(res.status, 200, name);
    const html = await res.text();
    assert.ok(html.includes(LINKED_LOGO), `${name}: logo link`);
    assert.equal([...html.matchAll(/<img /g)].length, 1, `${name}: one image, the logo`);
    assert.ok(!html.includes(PLAIN_LOGO), name);
    nothingInline(html.replace(/<script type="module" src="[^"]+"><\/script>/g, ""), name);
    assert.ok(!/tabindex/.test(html), name);
  }
  assert.equal(pages["caisse"].headers.get("content-security-policy"), EXPECTED_CSP);
  assert.equal(pages["relevé (filtres)"].headers.get("content-security-policy"), CSP_SANS_SCRIPT);
  assert.equal(pages["espace (accueil)"].headers.get("content-security-policy"), EXPECTED_CSP);
  // Let the listening of the cash register come up before closing it (closing one that is still starting waits for a long timeout).
  for (let i = 0; i < 100 && (await (await b.request("/caisse/data")).json()).status !== "live"; i += 1) await new Promise((r) => setTimeout(r, 20));
  // Close the cash register again.
  const caisseCsrf = (await (await b.request("/caisse")).text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  assert.equal((await b.request("/deconnexion", { method: "POST", form: { csrf: caisseCsrf }, headers: { Origin: app.base } })).status, 303);
  // Following the link works with the same session and asks nothing more.
  const home = await b.request("/espace");
  assert.equal(home.status, 200);
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 1);
  const areaCsrf = (await (await b.request("/espace")).text()).match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  await b.request("/espace/deconnexion", { method: "POST", form: { csrf: areaCsrf }, headers: { Origin: app.base } });
});

// ---------------------------------------------------------------- the logo in the single-merchant mode

// Intention: in the single-merchant mode (the one of the executable) the logo is the plain image of before, on the login page and on the
// cash register: nothing is linked, nothing changes there.
appTest("navigation : mode simple, le logo reste l'image seule d'avant", CAISSE_OPTIONS, async (app) => {
  const login = await (await app.request("/")).text();
  assert.ok(login.includes(PLAIN_LOGO));
  assert.ok(!login.includes("lien-logo") && !login.includes("/espace"));
  assert.equal((await app.login()).status, 303);
  const caisse = await (await app.request("/caisse")).text();
  assert.ok(caisse.includes(PLAIN_LOGO));
  assert.ok(!caisse.includes("lien-logo") && !caisse.includes('href="/espace"'));
  assert.equal((await app.request("/espace")).status, 404, "the area does not exist in this mode");
});

// ---------------------------------------------------------------- style sheet

// Intention: on paper, the back buttons are hidden, and the logo link, though every link is hidden on paper, stays a block holding the
// logo: the printed header (logo and tool name) does not change. On screen the link has no underline and a visible focus on the banner.
appTest("navigation : style — boutons masqués à l'impression, logo imprimé comme avant, focus visible", options(), async () => {
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  const printBlocks = css.split("@media print").slice(1).join("\n");
  assert.match(printBlocks, /a,\s*button,\s*form,\s*\.actions,\s*\.retour,\s*\.raccourcis \{\s*display: none !important;/);
  assert.match(printBlocks, /a\.lien-logo \{\s*display: block !important;/, "the logo link is not hidden on paper");
  const screen = css.split("@media print")[0];
  assert.match(screen, /\.logo a \{[^}]*text-decoration:\s*none/);
  assert.match(screen, /\.logo a:focus-visible \{[^}]*outline:\s*3px solid var\(--blanc\)/);
  assert.match(screen, /a\.lien-retour \{[^}]*min-height:\s*var\(--tactile\)/);
  assert.match(screen, /a\.lien-retour::before \{[^}]*content:\s*""/, "decorative arrow, nothing to read");
  assert.ok(!/url\(/.test(screen.match(/a\.lien-retour::before \{[^}]*\}/)[0]), "no image");
});
