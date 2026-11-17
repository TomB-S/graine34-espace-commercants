// === WHAT THIS FILE CHECKS ===
// UNIT tests of the two pure functions of server.js that the cash register page relies on, without a server or a network:
// `escapeHtml` (security: a text coming from Cyclos can never inject code into a page) and `formatAmount` (amounts shown the French way,
// done on strings, never through floating point). Copied from the unit tests of mission 2A.
import { test } from "node:test";
import assert from "node:assert/strict";
// First, before server.js: removes the terminal's environment variables (see env-propre.js).
import "./support/env-propre.js";
import { escapeHtml, formatAmount } from "../src/server.js";

// Intention (security): texts coming from Cyclos (names, descriptions) are inserted into a page. If they contained
// <script>, an attacker could have code run on the merchant's side (XSS flaw). `escapeHtml` replaces < > & " with
// entities (&lt; ...) so that the browser DISPLAYS them instead of interpreting them. The test also checks that we do not escape twice.
test("escapeHtml : & < > \" échappés, & une seule fois", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("Tom & Jerry"), "Tom &amp; Jerry");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  assert.equal(escapeHtml(`" onfocus="x`), "&quot; onfocus=&quot;x");
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml("Café é ñ"), "Café é ñ");
});

// Intention: amounts display the French way (decimal comma, narrow no-break space between thousands:
// \u202f is the code of that space). A badly formatted amount on a ticket causes confusion.
test("formatAmount : format français, espace fine insécable entre les milliers", () => {
  assert.equal(formatAmount("1234.5"), "1\u202f234,50");
  assert.equal(formatAmount("1234567.89"), "1\u202f234\u202f567,89");
  assert.equal(formatAmount("12"), "12,00");
  assert.equal(formatAmount("0"), "0,00");
  assert.equal(formatAmount("999.99"), "999,99");
  assert.equal(formatAmount("1000"), "1\u202f000,00");
});

// Intention: the "+" is only added to positive amounts when requested, and zero never has a sign (no "-0,00").
test("formatAmount : signes", () => {
  assert.equal(formatAmount("-12.3"), "-12,30");
  assert.equal(formatAmount("12.3", 2, { signed: true }), "+12,30");
  assert.equal(formatAmount("-12.3", 2, { signed: true }), "-12,30");
  assert.equal(formatAmount("0.00", 2, { signed: true }), "0,00");
  assert.equal(formatAmount("-0.00"), "0,00");
  assert.equal(formatAmount("-0.00", 2, { signed: true }), "0,00");
});

// Intention: some currencies have no cents (0 decimals); and an unreadable value is returned as is
// rather than turned into a false figure.
test("formatAmount : nombre de décimales de la monnaie, valeur illisible rendue telle quelle", () => {
  assert.equal(formatAmount("1500", 0), "1\u202f500");
  assert.equal(formatAmount("1.5", 3), "1,500");
  assert.equal(formatAmount("abc"), "abc");
  assert.equal(formatAmount(""), "");
  assert.equal(formatAmount("1e5"), "1e5");
});
