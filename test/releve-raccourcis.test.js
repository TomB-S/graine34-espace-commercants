// === WHAT THIS FILE CHECKS ===
// The three shortcuts of the filters page (Aujourd'hui, Hier, 6 dernières heures) as buttons of a POST form: one click gives the ticket
// with the same bounds as before, an unknown shortcut is a 400 without any call to Cyclos, the protections of every POST, a PDF that
// covers the same period as the ticket shown, old ?preset= links that prefill nothing, and the other modes and the policies unchanged.
// All names and secrets are fictitious.
import "./support/env-propre.js";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { appTest } from "./support/harness.js";
import { pdfPages } from "./support/pdf-text.js";
import { options, connected, historyCalls } from "./support/releve-support.js";

const ZONE = "Europe/Paris";
const CSP_SANS_SCRIPT = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const CSP_TICKET = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const PDF = "/espace/releve/ticket.pdf";
const pdf = (b, form) => b.request(PDF, { method: "POST", form, headers: { Origin: b.base } });
const bounds = (app) => historyCalls(app)[0].query.getAll("datePeriod").map((d) => DateTime.fromISO(d).setZone(ZONE));
const periode = (html) => html.match(/<p class="periode">(.*?)<\/p>/)[1];

// Intention: "Aujourd'hui" gives the ticket from today 00:00 (Paris) up to now, with the exact dates and hours in the period.
appTest("raccourci : Aujourd'hui -> le ticket, de 00:00 jusqu'à maintenant", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const before = Date.now();
  const res = await b.ticket({ csrf, raccourci: "aujourdhui" });
  const after = Date.now();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-security-policy"), CSP_TICKET);
  const html = await res.text();
  assert.match(html, /<h1>Ticket de fin de service<\/h1>/);
  const [from, until] = bounds(app);
  assert.equal(from.toMillis(), DateTime.fromMillis(before, { zone: ZONE }).startOf("day").toMillis());
  assert.ok(until.toMillis() >= before && until.toMillis() <= after, "the end is now");
  assert.match(periode(html), /^Du \d\d\/\d\d\/\d{4} 00:00 au \d\d\/\d\d\/\d{4} \d\d:\d\d$/);
});

// Intention: "Hier" is yesterday from 00:00 to 23:59 included (Cyclos gets the last millisecond of that minute).
appTest("raccourci : Hier -> hier de 00:00 à 23:59 incluse", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const res = await b.ticket({ csrf, raccourci: "hier" });
  assert.equal(res.status, 200);
  const [from, until] = bounds(app);
  const day = from.startOf("day");
  assert.equal(from.toMillis(), day.toMillis());
  assert.equal(until.toMillis(), day.set({ hour: 23, minute: 59 }).plus({ minutes: 1 }).minus({ milliseconds: 1 }).toMillis());
  const text = periode(await res.text());
  assert.equal(text, `Du ${day.toFormat("dd/MM/yyyy")} 00:00 au ${day.toFormat("dd/MM/yyyy")} 23:59`);
  assert.equal(day.plus({ days: 1 }).startOf("day").toMillis(), DateTime.now().setZone(ZONE).startOf("day").toMillis(), "it is yesterday");
});

// Intention: "6 dernières heures" reads from six hours ago (to the minute) up to now.
appTest("raccourci : 6 dernières heures -> de maintenant moins 6 h jusqu'à maintenant", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const before = Date.now();
  const res = await b.ticket({ csrf, raccourci: "6h" });
  const after = Date.now();
  assert.equal(res.status, 200);
  const [from, until] = bounds(app);
  assert.ok(until.toMillis() >= before && until.toMillis() <= after);
  const gap = until.toMillis() - from.toMillis();
  // The start is the minute of "now" minus 6 hours, the end is now itself: 6 hours plus the seconds already elapsed in the minute.
  assert.ok(gap >= 6 * 3_600_000 && gap < 6 * 3_600_000 + 60_000, `${gap} ms`);
  assert.match(periode(await res.text()), /^Du \d\d\/\d\d\/\d{4} \d\d:\d\d au \d\d\/\d\d\/\d{4} \d\d:\d\d$/);
});

// Intention: any other value is a 400 in French with the filters page, and Cyclos is not called; a known name still works after.
appTest("raccourci : raccourci inconnu -> 400 en français, Cyclos non appelé", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  for (const value of ["", "demain", "6H", "hier ", "aujourd'hui", "../x", '"><b>x']) {
    const res = await b.ticket({ csrf, raccourci: value });
    assert.equal(res.status, 400, JSON.stringify(value));
    const html = await res.text();
    assert.match(html, /Raccourci inconnu/);
    assert.match(html, /<h1>Choisir la période<\/h1>/);
    assert.ok(!html.includes('"><b>'));
    assert.ok(!/<details[^>]*\bopen\b/.test(html), "the menu stays folded");
  }
  assert.equal(historyCalls(app).length, 0);
  assert.equal((await b.ticket({ csrf, raccourci: "hier" })).status, 200);
});

// Intention: the shortcut keeps the protections of every POST: security token, origin, session; Cyclos is not called.
appTest("raccourci : jeton CSRF, origine et session exigés, Cyclos non appelé", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  assert.equal((await b.ticket({ raccourci: "hier" })).status, 403, "no token");
  assert.equal((await b.ticket({ csrf: "0".repeat(64), raccourci: "hier" })).status, 403, "wrong token");
  assert.equal((await b.ticket({ csrf, raccourci: "hier" }, { origin: "https://autre.example" })).status, 403, "foreign origin");
  assert.equal((await b.ticket({ csrf, raccourci: "hier" }, { origin: null })).status, 403, "no origin");
  assert.equal(historyCalls(app).length, 0);
  const { browser } = await import("./support/releve-support.js");
  const stranger = browser(app);
  const res = await stranger.ticket({ csrf, raccourci: "hier" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/espace");
  assert.equal(historyCalls(app).length, 0);
});

// Intention: the PDF of a shortcut covers EXACTLY the period of the ticket shown: the form of the page carries the bounds of the
// ticket (the two dates, to the minute), not the name of the shortcut, so that a download made later does not read "now" again.
appTest("raccourci : le PDF reprend les bornes exactes du ticket affiché", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  for (const raccourci of ["hier", "6h", "aujourdhui"]) {
    const html = await (await b.ticket({ csrf, raccourci })).text();
    const form = html.split('class="telechargement"')[1].split("</form>")[0];
    assert.ok(!form.includes("raccourci"), "the name of the shortcut is not asked again");
    const start = form.match(/name="start" value="([^"]+)"/)[1];
    const end = form.match(/name="end" value="([^"]+)"/)[1];
    const text = periode(html);
    const stamp = (v) => `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)} ${v.slice(11)}`;
    assert.equal(text, `Du ${stamp(start)} au ${stamp(end)}`, raccourci);
    const res = await pdf(b, { csrf, start, end });
    assert.equal(res.status, 200);
    const lines = pdfPages(Buffer.from(await res.arrayBuffer())).join("\n").split("\n");
    assert.ok(lines.includes(text), `the PDF says ${text}`);
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="ticket-\d{4}-\d\d-\d\d_\d{4}_\d{4}-\d\d-\d\d_\d{4}\.pdf"$/);
  }
  // The PDF route also accepts the shortcut itself, with the same rules as the ticket.
  assert.equal((await pdf(b, { csrf, raccourci: "hier" })).status, 200);
  const calls = historyCalls(app).length;
  assert.equal((await pdf(b, { csrf, raccourci: "demain" })).status, 400);
  assert.equal(historyCalls(app).length, calls);
});

// Intention: the page has no ?preset= link any more, and an old link shows the page with its default values, the menu folded, no error.
appTest("raccourci : la page n'a plus de liens ?preset=, les anciens liens ne préremplissent rien", options(), async (app) => {
  const { b } = await connected(app, []);
  const plain = await (await b.request("/espace/releve")).text();
  assert.ok(!plain.includes("preset"));
  assert.ok(!/<a [^>]*href="[^"]*\?/.test(plain), "no link with a query string");
  assert.deepEqual([...plain.matchAll(/<button type="submit" name="raccourci" value="([^"]+)">(.*?)<\/button>/g)].map((m) => [m[1], m[2]]),
    [["aujourdhui", "Aujourd'hui"], ["hier", "Hier"], ["6h", "6 dernières heures"]]);
  const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))[1];
  for (const preset of ["hier", "6h", "aujourdhui", "nimportequoi"]) {
    const res = await b.request(`/espace/releve?preset=${preset}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!/<details[^>]*\bopen\b/.test(html), preset);
    assert.ok(!html.includes('class="erreur"'), preset);
    // Same values as without the query (the minutes of the end move with the clock, so only the date part is compared).
    for (const name of ["start", "end", "jour", "de", "a"]) assert.equal(field(html, name).slice(0, 10), field(plain, name).slice(0, 10), `${preset} ${name}`);
  }
  assert.equal(historyCalls(app).length, 0);
});

// Intention: the shortcut buttons are in a form with the session's token, as real buttons (keyboard), without script or inline style.
appTest("raccourci : formulaire avec jeton, vrais boutons, sans script ni style en ligne", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  const html = await (await b.request("/espace/releve")).text();
  const block = html.split('class="raccourcis"')[1].split("</div>")[0];
  assert.match(block, /<form method="post" action="\/espace\/releve\/ticket"/);
  assert.equal(block.match(/name="csrf" value="([0-9a-f]+)"/)[1], csrf);
  assert.ok(!/<p[^>]*class="raccourcis"/.test(html), "a div, not a p");
  assert.ok(!/<script|\sstyle=|\sonclick=/i.test(html));
});

// Intention: the other modes are untouched (day, month, free range), and an error of the free range still opens its menu, only then.
appTest("raccourci : les autres modes et les politiques de sécurité inchangés", options(), async (app) => {
  const { b, csrf } = await connected(app, []);
  assert.equal((await b.request("/espace/releve")).headers.get("content-security-policy"), CSP_SANS_SCRIPT);
  const day = await b.ticket({ csrf, jour: "2026-01-10", de: "11:00", a: "14:00" });
  const month = await b.ticket({ csrf, mois: "1", annee: String(DateTime.now().setZone(ZONE).year - 1) });
  const free = await b.ticket({ csrf, start: "2026-01-10T00:00", end: "2026-01-10T23:59" });
  for (const res of [day, month, free]) {
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-security-policy"), CSP_TICKET);
  }
  assert.match(periode(await day.text()), /^Du 10\/01\/2026 11:00 au 10\/01\/2026 14:00$/);
  assert.match(periode(await free.text()), /^Du 10\/01\/2026 00:00 au 10\/01\/2026 23:59$/);
  // Priority when several modes arrive together: month, then day, then shortcut.
  assert.match(await (await b.ticket({ csrf, mois: "13", annee: "2026", jour: "2026-01-10", de: "11:00", a: "14:00", raccourci: "hier" })).text(), /Mois invalide|Année invalide/);
  assert.equal((await b.ticket({ csrf, jour: "2026-02-30", de: "11:00", a: "14:00", raccourci: "hier" })).status, 400);
  assert.equal((await b.ticket({ csrf, raccourci: "hier", start: "x", end: "y" })).status, 200, "the shortcut comes before the free range");
  const bad = await b.ticket({ csrf, start: "2026-01-10T18:00", end: "2026-01-10T09:00" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /<details class="bloc-periode autre-periode" open>/);
});
