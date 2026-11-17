// === WHAT THIS FILE CHECKS ===
// The SSE parser (sse-parser.js), a pure piece of code: text chunks in, events out. No server, no network.
// Cases: chunks cut in the middle of a line or a word, "\r\n" cut between its two characters, comments such as
// ":Initialized", "data" on several lines, an event without data, the remembered "id", the blank line that ends an event,
// and the decoding of the JSON (event name or "type" field). All values are fictitious. Basic notions: test/statique.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser, interpretEvent } from "../src/sse-parser.js";

// Feeds all chunks one after the other and returns every event produced.
function parseAll(chunks) {
  const parser = createSseParser();
  const events = chunks.flatMap((chunk) => parser.feed(chunk));
  return { events, lastEventId: parser.lastEventId };
}

const STREAM =
  ":Initialized\n\n" +
  "id: 11\nevent: accountStatus\ndata: {\"a\":1}\n\n" +
  "id: 12\nevent: newNotification\ndata: {\"n\":\"x\"}\n\n";

// Intention: the comment ":Initialized" is ignored, two events come out in order, the id is attached to each.
test("sse : commentaire ignoré, deux événements dans l'ordre avec leur id", () => {
  const { events, lastEventId } = parseAll([STREAM]);
  assert.deepEqual(events, [
    { event: "accountStatus", data: '{"a":1}', id: "11" },
    { event: "newNotification", data: '{"n":"x"}', id: "12" },
  ]);
  assert.equal(lastEventId, "12");
});

// Intention: whatever the place where the network cuts the stream, the result is the same.
// We cut the same text at EVERY position (and into single characters) and compare.
test("sse : même résultat quel que soit le découpage en morceaux (chaque position, et caractère par caractère)", () => {
  for (const text of [STREAM, STREAM.replaceAll("\n", "\r\n"), STREAM.replaceAll("\n", "\r")]) {
    const whole = parseAll([text]).events;
    assert.equal(whole.length, 2);
    for (let cut = 0; cut <= text.length; cut += 1) {
      assert.deepEqual(parseAll([text.slice(0, cut), text.slice(cut)]).events, whole, `coupé à ${cut}`);
    }
    assert.deepEqual(parseAll([...text]).events, whole, "caractère par caractère");
  }
});

// Intention: "\r\n" cut exactly between "\r" and "\n" counts as ONE line end, not two (a blank line would end the event too early).
test("sse : \\r\\n coupé entre les deux caractères = une seule fin de ligne", () => {
  const { events } = parseAll(["event: accountStatus\r", "\ndata: {}\r", "\n\r", "\n"]);
  assert.deepEqual(events, [{ event: "accountStatus", data: "{}", id: null }]);
});

// Intention: the three kinds of line end are accepted.
test("sse : fins de ligne \\n, \\r\\n et \\r", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    const { events } = parseAll([`event: e${eol}data: d${eol}${eol}`]);
    assert.deepEqual(events, [{ event: "e", data: "d", id: null }], JSON.stringify(eol));
  }
});

// Intention: a comment line is never an event, even in the middle of an event, and a comment alone dispatches nothing.
test("sse : lignes de commentaire ignorées (seules ou au milieu d'un événement)", () => {
  assert.deepEqual(parseAll([":Initialized\n\n", ": ping\n\n"]).events, []);
  const { events } = parseAll(["event: e\n:pause\ndata: d\n\n"]);
  assert.deepEqual(events, [{ event: "e", data: "d", id: null }]);
});

// Intention: several "data:" lines are joined with a line break, an empty "data:" line gives an empty line.
test("sse : plusieurs lignes data sont jointes par un retour à la ligne", () => {
  const { events } = parseAll(["data: ligne1\ndata: ligne2\ndata:\ndata: ligne4\n\n"]);
  assert.deepEqual(events, [{ event: null, data: "ligne1\nligne2\n\nligne4", id: null }]);
});

// Intention: only ONE space after the colon is removed; the colon is optional; the value may contain colons.
test("sse : un seul espace retiré après les deux-points, valeur avec des deux-points", () => {
  assert.deepEqual(parseAll(["data:sans-espace\n\n"]).events[0].data, "sans-espace");
  assert.deepEqual(parseAll(["data:  deux-espaces\n\n"]).events[0].data, " deux-espaces");
  assert.deepEqual(parseAll(["data: a:b:c\n\n"]).events[0].data, "a:b:c");
  assert.deepEqual(parseAll(["data\n\n"]).events, [{ event: null, data: "", id: null }]);
});

// Intention: an event with no data (only an event name, or only an id) is not returned,
// but its id is remembered, as it is the value to send back in Last-Event-ID.
test("sse : événement sans data ignoré, mais son id est mémorisé", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.feed("event: seulement-un-nom\n\n"), []);
  assert.equal(parser.lastEventId, null);
  assert.deepEqual(parser.feed("id: 42\n\n"), []);
  assert.equal(parser.lastEventId, "42");
});

// Intention: the id stays known for the next events that do not repeat it, and is replaced by a new one.
test("sse : l'id est conservé d'un événement à l'autre puis remplacé", () => {
  const parser = createSseParser();
  assert.equal(parser.feed("id: 1\ndata: a\n\n")[0].id, "1");
  assert.equal(parser.feed("data: b\n\n")[0].id, "1");
  assert.equal(parser.feed("id: 2\ndata: c\n\n")[0].id, "2");
  assert.equal(parser.lastEventId, "2");
});

// Intention: an id with a NUL character is ignored (SSE rule); an unknown field ("retry") is ignored.
test("sse : id avec caractère nul et champs inconnus ignorés", () => {
  const parser = createSseParser();
  parser.feed("id: ab\0c\ndata: a\n\n");
  assert.equal(parser.lastEventId, null);
  assert.deepEqual(parser.feed("retry: 3000\nautre: x\ndata: b\n\n"), [{ event: null, data: "b", id: null }]);
});

// Intention: an event that is not finished (no blank line yet) is not returned, and is completed by the next chunk.
test("sse : événement non terminé retenu jusqu'à la ligne vide", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.feed("event: e\ndata: d\n"), []);
  assert.deepEqual(parser.feed("\n"), [{ event: "e", data: "d", id: null }]);
});

// Intention: the optional byte order mark at the very start does not spoil the first field.
test("sse : marque d'ordre des octets au début ignorée", () => {
  assert.deepEqual(parseAll(["﻿event: e\ndata: d\n\n"]).events, [{ event: "e", data: "d", id: null }]);
});

// Intention: multi-byte characters are never broken: the parser receives TEXT (the caller decodes with TextDecoder in stream mode).
test("sse : accents et caractères non latins conservés", () => {
  const { events } = parseAll(["data: é à ü 日本 ✓\n", "\n"]);
  assert.equal(events[0].data, "é à ü 日本 ✓");
});

// Intention: a stream without any line end must not grow the memory without limit.
test("sse : ligne démesurée sans fin de ligne abandonnée, la suite est lue normalement", () => {
  const parser = createSseParser();
  for (let i = 0; i < 6; i += 1) assert.deepEqual(parser.feed("x".repeat(100_000)), []);
  // The end of the long line is thrown away; the next complete event is read.
  assert.deepEqual(parser.feed("fin de la ligne trop longue\ndata: ok\n\n"), [{ event: null, data: "ok", id: null }]);
});

test("sse : événement démesuré (trop de lignes data) abandonné, le suivant est lu", () => {
  const parser = createSseParser();
  const line = `data: ${"y".repeat(100_000)}\n`;
  assert.deepEqual(parser.feed(line.repeat(12) + "\n"), []);
  assert.deepEqual(parser.feed("data: suivant\n\n"), [{ event: null, data: "suivant", id: null }]);
});

// ---- interpretEvent: which kind of event, and is the JSON readable ----

// Intention: the kind is the SSE event name.
test("interpretEvent : le genre vient du nom de l'événement SSE", () => {
  for (const kind of ["newNotification", "accountStatus"]) {
    const result = interpretEvent({ event: kind, data: '{"x":1}', id: null });
    assert.equal(result.kind, kind);
    assert.equal(result.name, kind);
    assert.deepEqual(result.data, { x: 1 });
    assert.equal(result.invalid, false);
  }
});

// Intention: the stream may carry no event name and put the kind in the "type" field of the data (to be confirmed with push-smoke.js).
test("interpretEvent : à défaut de nom, le genre vient du champ type des données", () => {
  const result = interpretEvent({ event: null, data: '{"type":"newNotification","notification":{}}', id: null });
  assert.equal(result.kind, "newNotification");
  assert.equal(result.invalid, false);
});

// Intention: the SSE name wins over the data, and any other kind is ignored (kind null), whatever the place.
test("interpretEvent : nom SSE prioritaire, tout autre genre ignoré", () => {
  assert.equal(interpretEvent({ event: "accountStatus", data: '{"type":"newNotification"}' }).kind, "accountStatus");
  assert.equal(interpretEvent({ event: "autreChose", data: "{}" }).kind, null);
  assert.equal(interpretEvent({ event: null, data: '{"type":"paymentReceived"}' }).kind, null);
  assert.equal(interpretEvent({ event: null, data: "{}" }).kind, null);
});

// Intention: unreadable JSON, or JSON that is not an object, gives "invalid", and the name (and only the name) can be logged.
test("interpretEvent : JSON illisible ou non objet = invalide, seul le nom est exposé", () => {
  for (const data of ["pas du json {", "", "42", '"texte"', "null", "[1,2]"]) {
    const result = interpretEvent({ event: "newNotification", data });
    assert.equal(result.invalid, true, JSON.stringify(data));
    assert.equal(result.kind, null);
    assert.equal(result.data, null);
    assert.equal(result.name, "newNotification");
  }
});

// Intention: an odd event name is never returned as is (it could carry anything into the log).
test("interpretEvent : un nom d'événement étrange n'est pas renvoyé tel quel", () => {
  const odd = "MARQUEUR FICTIF 0,00";
  const result = interpretEvent({ event: odd, data: "{}" });
  assert.equal(result.name, "(sans nom)");
  assert.ok(!JSON.stringify(result).includes("MARQUEUR"));
});
