// === WHAT THIS FILE CHECKS ===
// The PDF of the end-of-service ticket (POST /espace/releve/ticket.pdf): a real downloadable PDF (headers, dated file name), multi-page
// and numbered, saying EXACTLY what the page says; the warning about a cut list on paper too; letters outside the font replaced by "?";
// the same checks as the page (origin, session, CSRF, dates), one reading at a time, Cyclos failures answered as pages and never as a
// half-sent file. Plus the small pure functions of the PDF (text safe for the font, file name). Most cases come from the original
// statement tool, with the same expectations. The text of a PDF is read by test/support/pdf-text.js. All values are fictitious.
import "./support/env-propre.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { appTest, until } from "./support/harness.js";
import { entry } from "./support/fake-cyclos.js";
import { pdfPages } from "./support/pdf-text.js";
import { pdfText, pdfFilename } from "../src/releve-pdf.js";
import {
  RANGE, NNBSP, options, browser, connected, on, history, summaryOf, amountsOf, historyCalls,
} from "./support/releve-support.js";

const at = (iso) => DateTime.fromISO(iso, { zone: "Europe/Paris" });
const PDF = "/espace/releve/ticket.pdf";

// POSTs the PDF form of the page of the area (Origin of the page by default).
const pdf = (b, form, origin = undefined) => b.request(PDF, { method: "POST", form, headers: { Origin: origin ?? b.base } });
const linesOf = async (res) => pdfPages(Buffer.from(await res.arrayBuffer())).join("\n").split("\n");

// ---------------------------------------------------------------- pure functions

// Intention: the PDF uses a standard font that only knows the "Windows-1252" set (accented Latin letters, €, quotation marks...).
test("pdfText : caractères de Windows-1252 conservés", () => {
  assert.equal(pdfText("Café Crème – « œuvre » 5 € ©"), "Café Crème – « œuvre » 5 € ©");
});

// Intention: special spaces and control characters have no shape in the PDF font; they become a plain space.
test("pdfText : espaces spéciaux, retours à la ligne et contrôles deviennent des espaces", () => {
  assert.equal(pdfText("1 234,50"), "1 234,50");
  assert.equal(pdfText("a b"), "a b");
  assert.equal(pdfText("a\nb\tc\rd\u0000e\u007ff"), "a b c d e f");
});

// Intention: a character the font cannot draw becomes ONE "?", even for an emoji (two units in JavaScript). Known limit, pinned here.
test("pdfText : hors Windows-1252 -> un seul « ? » par caractère, emoji compris", () => {
  assert.equal(pdfText("Привет"), "??????");
  assert.equal(pdfText("日本"), "??");
  assert.equal(pdfText("Merci 😀!"), "Merci ?!");
  assert.equal(pdfText("\u0080\u0081"), "??");
  assert.equal(pdfText("→"), "?");
});

test("pdfText : null, undefined, nombres", () => {
  assert.equal(pdfText(null), "");
  assert.equal(pdfText(undefined), "");
  assert.equal(pdfText(12.5), "12.5");
});

// Intention (security): the file name is built only with digits, hyphens and _, whatever the default language of the system.
test("pdfFilename : chiffres, tirets et _ seulement, même avec une langue par défaut non latine", () => {
  const from = at("2026-11-05T03:57");
  const to = at("2026-11-05T23:59");
  assert.equal(pdfFilename({ from, to }), "ticket-2026-11-05_0357_2026-11-05_2359.pdf");
  const arabic = pdfFilename({ from: from.setLocale("ar"), to: to.setLocale("ar") });
  assert.equal(arabic, "ticket-2026-11-05_0357_2026-11-05_2359.pdf");
  assert.match(arabic, /^[A-Za-z0-9_.-]+$/);
});

// ---------------------------------------------------------------- the download

// Intention: the PDF is a real download (headers, dated file name), multi-page and numbered, and says EXACTLY what the page says.
appTest("pdf : PDF valide, bons en-têtes, nom de fichier, contenu cohérent avec le ticket", options(), async (app) => {
  const entries = history(120);
  const { b, csrf } = await connected(app, entries);
  const page = await (await b.ticket({ csrf, ...RANGE })).text();
  // The page offers the download: a POST form carrying the same two dates and the session CSRF token.
  assert.match(page, /action="\/espace\/releve\/ticket\.pdf"[\s\S]*name="csrf" value="[0-9a-f]{64}"[\s\S]*name="start" value="2026-01-10T00:00"[\s\S]*name="end" value="2026-01-10T23:59"/);
  assert.match(page, /Télécharger le PDF/);

  const res = await pdf(b, { csrf, ...RANGE });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="ticket-2026-01-10_0000_2026-01-10_2359.pdf"');
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get("content-length")), bytes.length);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.match(bytes.subarray(-10).toString(), /%%EOF\s*$/);

  const pages = pdfPages(bytes);
  assert.ok(pages.length >= 2, `120 lignes sur ${pages.length} page(s)`);
  const text = pages.join("\n");
  const lines = text.split("\n");
  assert.ok(lines.includes("Ticket de fin de service"));
  assert.ok(lines.includes("Boutique de Marie"));
  assert.ok(lines.includes("Du 10/01/2026 00:00 au 10/01/2026 23:59"));
  assert.ok(lines.includes("Montants en Graines"));
  for (const [label, value] of summaryOf(page)) {
    const i = lines.indexOf(label);
    assert.ok(i >= 0, label);
    assert.equal(lines[i + 1], value.replaceAll(NNBSP, " "));
  }
  const numbers = lines.filter((l) => /^T\d{5}$/.test(l));
  assert.deepEqual(numbers, entries.map((e) => e.transactionNumber).reverse());
  assert.deepEqual(lines.filter((l) => /^[+-]\d+,\d\d$/.test(l)).slice(-entries.length), amountsOf(page).map((a) => a.replaceAll(NNBSP, " ")));
  pages.forEach((p, i) => assert.ok(p.split("\n").includes(`Page ${i + 1} / ${pages.length}`), `numéro de la page ${i + 1}`));
  assert.equal(lines.filter((l) => l === "N° de transaction").length, pages.length, "en-tête du tableau répété sur chaque page");
  assert.ok(!text.includes("Attention"));
  // One login only, and the PDF is read again from Cyclos with the token of the area.
  assert.equal(app.cyclos.calls("POST", "/auth/session").length, 1);
});

// Intention: the warning about a truncated list is also on paper (otherwise the paper would lie by omission).
appTest("pdf : plafond atteint -> avertissement dans le PDF aussi", options(), async (app) => {
  const { b, csrf } = await connected(app, history(2100));
  const text = (await linesOf(await pdf(b, { csrf, ...RANGE }))).join("\n");
  assert.match(text, /Attention : la liste est limitée aux 2000 transactions les plus récentes/);
});

// Intention: the screen and the PDF say the same about totals that cannot be given ("Non disponible"), warning included.
appTest("pdf : sans indicateurs, liste tronquée -> « Non disponible » et même avertissement que la page", options(), async (app) => {
  const { b, csrf } = await connected(app, history(2001));
  app.cyclos.state.indicators = false;
  const expected = summaryOf(await (await b.ticket({ csrf, ...RANGE })).text());
  assert.deepEqual(expected.map(([, v]) => v), ["Non disponible", "Non disponible", "Non disponible"]);
  const lines = await linesOf(await pdf(b, { csrf, ...RANGE }));
  for (const [label, value] of expected) assert.equal(lines[lines.indexOf(label) + 1], value);
  assert.match(lines.join(" ").replace(/\s+/g, " "), /totaux du résumé ne peuvent pas être calculés au-delà de 2000 transactions/);
});

appTest("pdf : sans transaction", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const text = (await linesOf(await pdf(b, { csrf, ...RANGE }))).join("\n");
  assert.match(text, /Aucune transaction sur cette plage/);
  assert.match(text, /Page 1 \/ 1/);
});

// Intention: the PDF only prints the letters of the standard font; the rest becomes "?". The page keeps everything.
appTest("pdf : caractères hors Windows-1252 remplacés par ?, accents et € conservés ; la page HTML garde tout", options(), async (app) => {
  const e = on(1, { description: "Café 5 € Привет 😀", who: "Zoë" });
  e.relatedAccount = { user: { display: "Дмитрий" } };
  const { b, csrf } = await connected(app, [e], { display: "Chez Élodie – 日本" });
  const html = await (await b.ticket({ csrf, ...RANGE })).text();
  assert.ok(html.includes("Café 5 € Привет 😀") && html.includes("Дмитрий") && html.includes("日本"));
  const lines = await linesOf(await pdf(b, { csrf, ...RANGE }));
  assert.ok(lines.includes("Café 5 € ?????? ?"), lines.join("|"));
  assert.ok(lines.includes("???????"));
  assert.ok(lines.includes("Chez Élodie – ??"));
});

// ---------------------------------------------------------------- same checks as the page

// Intention: no session, foreign origin, bad CSRF token, bad dates: refused as for the page, nothing read from Cyclos, never a PDF.
appTest("pdf : sans session, origine étrangère, CSRF faux, dates invalides -> refusé, Cyclos non appelé", options(), async (app) => {
  const { b, csrf } = await connected(app, history(3));
  const stranger = browser(app);
  const noSession = await pdf(stranger, { csrf, ...RANGE });
  assert.equal(noSession.status, 303);
  assert.equal(noSession.headers.get("location"), "/espace");
  for (const origin of ["https://autre-site.example", "null"]) {
    assert.equal((await pdf(b, { csrf, ...RANGE }, origin)).status, 403, origin);
  }
  assert.equal((await b.request(PDF, { method: "POST", form: { csrf, ...RANGE } })).status, 403, "sans Origin ni Referer");
  for (const bad of [undefined, "", "0".repeat(64), `${csrf}0`]) {
    const res = await pdf(b, { ...(bad === undefined ? {} : { csrf: bad }), ...RANGE });
    assert.equal(res.status, 403, String(bad));
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.equal(res.headers.get("content-disposition"), null);
  }
  for (const dates of [{ start: "hier", end: RANGE.end }, { start: RANGE.end, end: RANGE.start }, { start: "2025-01-01T00:00", end: "2026-01-10T00:00" }, { start: '"><b>x', end: RANGE.end }]) {
    const res = await pdf(b, { csrf, ...dates });
    assert.equal(res.status, 400, JSON.stringify(dates));
    const html = await res.text();
    assert.match(html, /<h1>Choisir la plage horaire<\/h1>/);
    assert.ok(!html.includes('"><b>'));
  }
  assert.equal(app.cyclos.calls("GET", "/self/accounts").length, 0);
});

// Intention: a Cyclos failure at the time of the PDF is answered as a page, never as a "fake PDF" or a half-sent PDF.
appTest("pdf : Cyclos en panne -> 502 en page, aucun PDF ; 401 -> session fermée ; 403 -> refus", options(), async (app) => {
  const { b, csrf } = await connected(app, history(3));
  assert.equal((await pdf(b, { csrf, ...RANGE })).status, 200);
  app.cyclos.force("GET /self/accounts/membre", 500);
  const failed = await pdf(b, { csrf, ...RANGE });
  assert.equal(failed.status, 502);
  assert.match(failed.headers.get("content-type"), /^text\/html/);
  assert.equal(failed.headers.get("content-disposition"), null);
  app.cyclos.state.forced.delete("GET /self/accounts/membre");
  app.cyclos.force("GET /self/accounts", 403);
  assert.equal((await pdf(b, { csrf, ...RANGE })).status, 403);
  app.cyclos.state.forced.delete("GET /self/accounts");
  app.cyclos.expireTokens();
  const closed = await pdf(b, { csrf, ...RANGE });
  assert.equal(closed.status, 303);
  assert.equal(closed.headers.get("location"), "/espace");
});

// Intention: these routes only exist as POST with a CSRF token: an address typed in the browser goes back to the filters.
appTest("pdf : un accès en GET renvoie aux filtres", options(), async (app) => {
  const { b } = await connected(app);
  const res = await b.request(PDF);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/espace/releve");
});

// Intention: the ticket and the PDF share the one-reading-at-a-time rule of the session.
appTest("pdf : refusé (429) pendant qu'une lecture du ticket est en cours pour la même session", options({ releveTimeoutMs: 600 }), async (app) => {
  const { b, csrf } = await connected(app, history(3));
  app.cyclos.force("GET /self/accounts/membre/history", "hang");
  const first = b.ticket({ csrf, ...RANGE });
  await until(() => historyCalls(app).length === 1, "lecture en cours");
  const second = await pdf(b, { csrf, ...RANGE });
  assert.equal(second.status, 429);
  assert.match(second.headers.get("content-type"), /^text\/html/);
  assert.equal((await first).status, 502);
  app.cyclos.state.forced.delete("GET /self/accounts/membre/history");
  assert.equal((await pdf(b, { csrf, ...RANGE })).status, 200, "garde libérée");
});

// Intention: outside the multi-merchant mode the PDF route does not exist either.
appTest("pdf : hors mode multi-commerçants, 404", { cyclosChannel: "main" }, async (app) => {
  const res = await fetch(`${app.base}${PDF}`, { method: "POST", redirect: "manual", headers: { Origin: app.base } });
  assert.equal(res.status, 404);
});
