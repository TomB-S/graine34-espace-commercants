// === WHAT THIS FILE CHECKS ===
// The filters page (/espace/releve) organised by what the merchant thinks: its title, the order of its blocks (shortcuts, a day between
// two hours, a whole month, a folded menu for several days), the defaults set by the server in Paris time, the folded menu (closed by
// default, opened by the server after an error of the free range, never by a script), the typed values kept after an error, the error
// placed by its block, the labels, and the security policies, which are the same as before. All names and secrets are fictitious.
import "./support/env-propre.js";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { appTest } from "./support/harness.js";
import { options, connected, historyCalls } from "./support/releve-support.js";

const CSP_SANS_SCRIPT = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const CSP_TICKET = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const parisToday = () => DateTime.now().setZone("Europe/Paris").toFormat("yyyy-MM-dd");
const DAY = { jour: "2026-01-10", de: "11:00", a: "14:00" };
const at = (html, text) => html.indexOf(text);
const getHtml = async (b, path = "/espace/releve") => (await b.request(path)).text();

// Intention: the title and the blocks come in the order of the merchant's thinking, and the folded menu is the last one.
appTest("filtres : titre et ordre des blocs", options(), async (app) => {
  const { b } = await connected(app);
  const html = await getHtml(b);
  assert.match(html, /<title>Choisir la période<\/title>/);
  assert.match(html, /<h1>Choisir la période<\/h1>/);
  assert.ok(!html.includes("Choisir la plage horaire"));
  // updated: the "Retour à l'espace" button is now the first thing of the page (under the header), and no longer the last.
  const order = [
    "Retour à l'espace",
    '<h1>Choisir la période</h1>',
    'class="raccourcis"',
    '<h2 id="titre-jour">Une journée ou une soirée</h2>',
    '<h2 id="titre-mensuel">Un mois complet</h2>',
    "<summary>Autre période (plusieurs jours)</summary>",
  ].map((text) => at(html, text));
  assert.ok(order.every((i) => i >= 0), order.join());
  assert.deepEqual([...order].sort((x, y) => x - y), order, "the blocks are in this order");
  for (const text of ["Aujourd'hui", "Hier", "6 dernières heures"]) assert.ok(html.includes(`>${text}</button>`), text); // updated: buttons, not links
  assert.ok(!html.includes("Relevé mensuel"));
});

// Intention: the day block: a native date field and two native time fields, each with its label, the help text tied to the hours, the
// button; the server sets today (Paris time), 00:00 and 23:59.
appTest("filtres : bloc « Une journée ou une soirée » (champs natifs, libellés, aide, valeurs par défaut en heure de Paris)", options(), async (app) => {
  const { b } = await connected(app);
  const before = parisToday();
  const html = await getHtml(b);
  const after = parisToday();
  const block = html.split('class="bloc-periode releve-jour"')[1].split("</form>")[0];
  const today = block.match(/<label for="jour">Jour<\/label>\s*<input type="date" id="jour" name="jour" value="(\d{4}-\d\d-\d\d)" autocomplete="off" required>/); // updated: autocomplete off
  assert.ok(today, "label + date field");
  assert.ok([before, after].includes(today[1]), `today in Paris: ${today[1]}`);
  assert.match(block, /<label for="de">De<\/label>\s*<input type="time" id="de" name="de" value="00:00" autocomplete="off" required>/); // updated: autocomplete off, no help text any more
  assert.match(block, /<label for="a">À<\/label>\s*<input type="time" id="a" name="a" value="23:59" autocomplete="off" required>/); // updated: autocomplete off, no help text any more
  assert.match(block, /<h2 id="titre-jour">Une journée ou une soirée<\/h2>\s*<p>Choisissez le jour, puis l'heure de début et l'heure de fin\.<\/p>/);
  assert.match(block, /<p class="aide-jour">Votre soirée finit après minuit \? Indiquez par exemple de 18:00 à 02:00 : le relevé s'arrêtera à 02:00 le lendemain\.<\/p>/);
  assert.ok(block.indexOf('name="a"') < block.indexOf("aide-jour"), "the sentence is under the two hour fields");
  assert.ok(!block.includes('type="checkbox"') && !block.includes("lendemain\"") && !block.includes("Le service se termine"), "no box any more");
  assert.match(block, /<button type="submit">Voir le relevé<\/button>/);
  assert.match(block, /name="csrf" value="[0-9a-f]{64}"/);
  assert.match(html, /<form method="post" action="\/espace\/releve\/ticket" class="bloc-periode releve-jour" aria-labelledby="titre-jour">/);
});

// Intention: the default day is the day in PARIS: just after 23:00 UTC the page already says the next day (checked on the pure
// function; the page uses it).
appTest("filtres : le jour par défaut suit l'heure de Paris, pas celle du serveur", options(), async () => {
  const { dayDefaults } = await import("../src/releve-calcul.js");
  assert.equal(dayDefaults(DateTime.fromISO("2026-06-30T22:30:00Z").setZone("Europe/Paris")).jour, "2026-07-01");
  assert.equal(dayDefaults(DateTime.fromISO("2026-12-31T23:30:00Z").setZone("Europe/Paris")).jour, "2027-01-01");
});

// Intention: the month block keeps its way of working (previous month preselected, "Voir le mois"), now titled "Un mois complet".
appTest("filtres : bloc « Un mois complet » inchangé dans son fonctionnement", options(), async (app) => {
  const { b } = await connected(app);
  const block = (await getHtml(b)).split('class="bloc-periode releve-mensuel"')[1].split("</form>")[0];
  assert.match(block, /<h2 id="titre-mensuel">Un mois complet<\/h2>/);
  assert.match(block, /<select id="mois" name="mois" required>/);
  assert.match(block, /<select id="annee" name="annee" required>/);
  assert.equal([...block.matchAll(/<option value="\d+" selected>/g)].length, 2, "one month and one year preselected");
  assert.match(block, /<button type="submit">Voir le mois<\/button>/);
});

// Intention: the several-days menu is a native details/summary, folded by default, still holding the old form (two datetime fields).
appTest("filtres : menu « Autre période » replié par défaut, ancien formulaire dedans", options(), async (app) => {
  const { b } = await connected(app);
  const html = await getHtml(b);
  assert.match(html, /<details class="bloc-periode autre-periode">\s*<summary>Autre période \(plusieurs jours\)<\/summary>/);
  assert.ok(!/<details[^>]*\bopen\b/.test(html), "folded");
  const menu = html.split("<details")[1].split("</details>")[0];
  assert.match(menu, /<label for="start">Début<\/label>\s*<input type="datetime-local" id="start" name="start" value="\d{4}-\d\d-\d\dT\d\d:\d\d" required>/);
  assert.match(menu, /<label for="end">Fin<\/label>\s*<input type="datetime-local" id="end" name="end" value="\d{4}-\d\d-\d\dT\d\d:\d\d" required>/);
  assert.match(menu, /<form method="post" action="\/espace\/releve\/ticket">/);
  assert.match(menu, /name="csrf" value="[0-9a-f]{64}"/);
  // updated: the shortcuts no longer fill these fields nor open the menu; an old ?preset= link shows the same folded page.
  for (const preset of ["hier", "aujourdhui", "6h", "nimportequoi"]) {
    const old = await getHtml(b, `/espace/releve?preset=${preset}`);
    assert.ok(!/<details[^>]*\bopen\b/.test(old), preset);
    assert.match(old, /name="start" value="[\d-]+T00:00"/, "the usual default of the free range, whatever the link");
  }
});

// Intention: no script and no inline style on the page; every field has a label tied to it.
appTest("filtres : sans script, sans style en ligne, chaque champ a son libellé", options(), async (app) => {
  const { b } = await connected(app);
  const html = await getHtml(b);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/\sstyle=/i.test(html));
  assert.ok(!/\son[a-z]+=/i.test(html), "no inline event handler");
  const fields = [...html.matchAll(/<(?:input|select)\b(?![^>]*type="hidden")[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fields, ["jour", "de", "a", "mois", "annee", "start", "end"]);
  for (const id of fields) assert.match(html, new RegExp(`<label for="${id}">`), id);
});

// Intention: an error of the day block: 400, the typed values kept (and escaped), the message in the day block, the folded menu stays
// folded, the other blocks keep their usual values.
appTest("filtres : erreur du bloc jour -> valeurs conservées, message près du bloc, menu replié", options(), async (app) => {
  const { b, csrf } = await connected(app);
  const res = await b.ticket({ csrf, jour: "2026-02-30", de: "18:00", a: "18:00" });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("content-security-policy"), CSP_SANS_SCRIPT);
  const html = await res.text();
  const day = html.split('class="bloc-periode releve-jour"')[1].split("</form>")[0];
  assert.match(day, /Erreur :<\/strong> Le jour choisi n'existe pas dans le calendrier\./);
  assert.equal([...html.matchAll(/class="erreur"/g)].length, 1, "one message only");
  assert.match(day, /name="jour" value="2026-02-30"/);
  assert.match(day, /name="de" value="18:00"/);
  assert.match(day, /name="a" value="18:00"/);
  assert.ok(!/<details[^>]*\bopen\b/.test(html), "the menu stays folded");
  // What was typed is escaped, and kept as typed even when it is not a valid value.
  const hostile = await (await b.ticket({ csrf, jour: '"><b>x', de: "18:00", a: "19:00" })).text();
  assert.ok(!hostile.includes('"><b>'));
  assert.ok(hostile.includes('value="&quot;&gt;&lt;b&gt;x"'));
});

// Intention: an error of the month block: the message is in the month block and the month and year chosen stay selected.
appTest("filtres : erreur du bloc mois -> message près du bloc, choix conservé", options(), async (app) => {
  const { b, csrf } = await connected(app);
  const year = DateTime.now().setZone("Europe/Paris").year;
  const res = await b.ticket({ csrf, mois: "13", annee: String(year - 1) });
  assert.equal(res.status, 400);
  const html = await res.text();
  const month = html.split('class="bloc-periode releve-mensuel"')[1].split("</form>")[0];
  assert.match(month, /Erreur :<\/strong> Mois invalide/);
  assert.match(month, new RegExp(`<option value="${year - 1}" selected>`));
  assert.ok(!/<details[^>]*\bopen\b/.test(html));
  const future = await b.ticket({ csrf, mois: "12", annee: String(year) });
  if (future.status === 400) assert.match(await future.text(), /<option value="12" selected>/);
});

// Intention: an error of the free range opens the menu (attribute set by the server), keeps both typed values, and puts the message
// inside the menu, not at the top of the page; the day block keeps its defaults.
appTest("filtres : erreur de la plage libre -> menu ouvert, valeurs conservées, message dans le menu", options(), async (app) => {
  const { b, csrf } = await connected(app);
  const res = await b.ticket({ csrf, start: "2026-01-10T18:00", end: "2026-01-10T09:00" });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("content-security-policy"), CSP_SANS_SCRIPT);
  const html = await res.text();
  assert.match(html, /<details class="bloc-periode autre-periode" open>/);
  const menu = html.split("<details")[1].split("</details>")[0];
  assert.match(menu, /Erreur :<\/strong> La fin doit être après le début\./);
  assert.match(menu, /name="start" value="2026-01-10T18:00"/);
  assert.match(menu, /name="end" value="2026-01-10T09:00"/);
  assert.equal([...html.matchAll(/class="erreur"/g)].length, 1);
  assert.ok(!html.split("<details")[0].includes("Erreur"), "no message above the menu");
  assert.match(html, /name="de" value="00:00"/);
  assert.match(html, /name="a" value="23:59"/);
  assert.equal(historyCalls(app).length, 0);
});

// Intention: the old behaviours are unchanged: the free range, the month and the shortcuts give the same tickets as before, and the
// security policies are exactly the same (no script on the filters, the ticket adds script-src 'self' only, whatever the mode).
appTest("filtres : anciens modes inchangés, politiques de sécurité inchangées", options(), async (app) => {
  const { b, csrf } = await connected(app);
  const filters = await b.request("/espace/releve");
  assert.equal(filters.headers.get("content-security-policy"), CSP_SANS_SCRIPT);
  const free = await b.ticket({ csrf, start: "2026-01-10T00:00", end: "2026-01-10T23:59" });
  const day = await b.ticket({ csrf, ...DAY });
  const month = await b.ticket({ csrf, mois: "1", annee: String(DateTime.now().setZone("Europe/Paris").year - 1) });
  for (const res of [free, day, month]) {
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), CSP_TICKET);
  }
  assert.match(await free.text(), /<h1>Ticket de fin de service<\/h1>/);
  assert.match(await day.text(), /<h1>Ticket de fin de service<\/h1>/);
  assert.match(await month.text(), /<h1>Relevé du mois de janvier \d{4}<\/h1>/);
  const pdf = await b.request("/espace/releve/ticket.pdf", { method: "POST", form: { csrf, ...DAY }, headers: { Origin: b.base } });
  assert.equal(pdf.headers.get("content-security-policy"), CSP_SANS_SCRIPT);
});

// Intention: the defaults of the day block (today in Paris, 00:00, 23:59, no box) are the same on every arrival, also through a
// shortcut or an old ?preset= link, and nothing typed during an earlier visit is put back by the server; the browser is told not to
// bring old values back either (autocomplete off on these three fields).
appTest("filtres : valeurs par défaut du bloc jour à chaque arrivée (raccourcis, anciens liens), autocomplete désactivé", options(), async (app) => {
  const { b, csrf } = await connected(app);
  await b.ticket({ csrf, jour: "2026-01-10", de: "18:00", a: "02:00" }); // a visit that typed other values
  for (const path of ["/espace/releve", "/espace/releve?preset=aujourdhui", "/espace/releve?preset=hier", "/espace/releve?preset=6h", "/espace/releve?preset=nimportequoi", "/espace/releve?jour=2026-01-10&de=18:00&lendemain=1"]) {
    const before = parisToday();
    const html = await getHtml(b, path);
    const after = parisToday();
    const day = html.split('class="bloc-periode releve-jour"')[1].split("</form>")[0];
    const jour = day.match(/name="jour" value="([\d-]+)"/)[1];
    assert.ok([before, after].includes(jour), `${path}: ${jour}`);
    assert.match(day, /name="de" value="00:00"/, path);
    assert.match(day, /name="a" value="23:59"/, path);
    assert.ok(!day.includes("checkbox"), `${path}: no box`);
    for (const name of ["jour", "de", "a"]) {
      assert.match(day, new RegExp(`<input [^>]*name="${name}"[^>]*autocomplete="off"`), `${path}: ${name}`);
    }
  }
});

// Intention: after an error, the typed hours are kept in the day block, whichever order they are in, and the message is by that block.
appTest("filtres : heures conservées après une erreur du bloc jour", options(), async (app) => {
  const { b, csrf } = await connected(app);
  const res = await b.ticket({ csrf, jour: "2026-01-10", de: "18:00", a: "25:00", lendemain: "1" });
  assert.equal(res.status, 400);
  const day = (await res.text()).split('class="bloc-periode releve-jour"')[1].split("</form>")[0];
  assert.match(day, /n'existe pas/);
  assert.match(day, /name="de" value="18:00"/);
  assert.match(day, /name="a" value="25:00"/);
  assert.ok(!day.includes("checkbox"));
});

// Intention: the old help sentence of the page "Si « À » est avant « De »…" stays gone; the new fixed sentence is in the page and in
// the answers that show the filters again, and no box is left in the source of the page.
appTest("filtres : ancienne phrase d'aide absente, nouvelle phrase présente, case absente du source", options(), async (app) => {
  const { readFile } = await import("node:fs/promises");
  const { b, csrf } = await connected(app);
  const refused = await (await b.ticket({ csrf, jour: "2026-02-30", de: "18:00", a: "02:00" })).text();
  for (const html of [await getHtml(b), refused]) {
    assert.ok(!html.includes("Si « À »") && !html.includes("jusqu'au lendemain"));
    assert.ok(html.includes("Votre soirée finit après minuit ? Indiquez par exemple de 18:00 à 02:00 : le relevé s'arrêtera à 02:00 le lendemain."));
    assert.ok(html.includes("Choisissez le jour, puis l'heure de début et l'heure de fin."));
    assert.ok(!html.includes('type="checkbox"'));
  }
  const source = await readFile(new URL("../src/releve-page.js", import.meta.url), "utf8");
  assert.ok(!source.includes("Si « À »") && !source.includes("checkbox") && !source.includes("name=\"lendemain\""));
});

// Intention: the several-days menu looks clickable without any script: a native summary with the exact title, folded by default,
// open (chevron down) after an error of its own range, nothing inline added, and the style sheet draws the chevron (right when
// folded, down for details[open]), hides the browser's own markers and shows a keyboard focus.
appTest("filtres : le menu « Autre période » est un summary natif avec chevron en CSS, sans style ni script en ligne", options(), async (app) => {
  const { b, csrf } = await connected(app);
  const folded = await getHtml(b);
  assert.match(folded, /<summary>Autre période \(plusieurs jours\)<\/summary>/, "native summary, exact title");
  assert.equal([...folded.matchAll(/<summary/g)].length, 1);
  assert.ok(!/<details[^>]*\bopen\b/.test(folded), "folded by default");
  const open = await (await b.ticket({ csrf, start: "2026-01-10T18:00", end: "2026-01-10T09:00" })).text();
  assert.match(open, /<details class="bloc-periode autre-periode" open>\s*<summary>Autre période \(plusieurs jours\)<\/summary>/, "open after an error of its range");
  for (const html of [folded, open]) {
    assert.ok(!/<script/i.test(html) && !/\sstyle=/i.test(html) && !/\son[a-z]+=/i.test(html), "nothing inline");
    assert.ok(!/<summary[^>]*\s(?:class|style|aria-hidden)=/.test(html), "the chevron is not in the HTML (decorative, drawn by the style sheet)");
  }
  const css = await (await b.request("/style.css")).text();
  const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  assert.match(rule(".autre-periode summary"), /cursor:\s*pointer/);
  assert.match(rule(".autre-periode summary"), /color:\s*var\(--vert-principal\)/);
  assert.match(rule(".autre-periode summary"), /list-style:\s*none/);
  assert.match(rule(".autre-periode summary::-webkit-details-marker"), /display:\s*none/);
  assert.match(rule(".autre-periode summary::before"), /content:\s*""/);
  assert.match(rule(".autre-periode summary::before"), /border-right:[^;]*;[\s\S]*border-bottom:/);
  assert.match(rule(".autre-periode summary::before"), /rotate\(-45deg\)/, "pointing right when folded");
  assert.match(rule("details[open].autre-periode > summary::before"), /rotate\(45deg\)/, "pointing down when open");
  assert.match(rule(".autre-periode summary:hover"), /underline/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid/, "the shared keyboard focus");
  assert.ok(!/url\(/.test(rule(".autre-periode summary::before")), "no image");
});
