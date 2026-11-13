// Server-Sent Events parser, with no I/O: text chunks in, events out.
//
// Follows the SSE rules the cash register needs:
// - chunks may end anywhere (in the middle of a word, between "\r" and "\n");
// - line ends are "\n", "\r\n" or "\r";
// - a line starting with ":" is a comment (such as ":Initialized") and is ignored;
// - fields: "event", "data" (several lines are joined with "\n"), "id"; the
//   other fields (such as "retry") are ignored;
// - a blank line ends the event; an event without data is not returned, but
//   its "id" is still remembered.
//
// interpretEvent() then decodes the JSON and tells which kind of event it is.
// It never trusts the event name alone: the kind can be the SSE event name or
// the "type" field of the data (the real shape is checked with push-smoke.js).

// Safety bounds against a broken stream that never sends a line end.
const MAX_LINE_CHARS = 256 * 1024;
const MAX_EVENT_CHARS = 1024 * 1024;

export function createSseParser() {
  let buffer = ""; // text received but not yet cut into lines
  let skipLineFeed = false; // the last line ended with "\r": swallow a "\n" that comes next
  let atStart = true; // for the optional byte order mark
  let discardLine = false; // the current line was too long: ignore it up to its end
  let eventName = "";
  let dataLines = [];
  let dataChars = 0;
  let tooBig = false;
  let lastEventId = null;
  let pendingId = null;

  function resetEvent() {
    eventName = "";
    dataLines = [];
    dataChars = 0;
    tooBig = false;
  }

  function readLine(line, out) {
    if (line === "") {
      // End of event. The id is kept even when there is no data.
      if (pendingId !== null) lastEventId = pendingId;
      if (dataLines.length > 0 && !tooBig) {
        out.push({ event: eventName || null, data: dataLines.join("\n"), id: lastEventId });
      }
      resetEvent();
      return;
    }
    if (line.startsWith(":")) return; // comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataChars += value.length + 1;
      if (dataChars > MAX_EVENT_CHARS) {
        tooBig = true;
        dataLines = [];
      } else if (!tooBig) {
        dataLines.push(value);
      }
    } else if (field === "id" && !value.includes("\0")) {
      pendingId = value;
    }
  }

  return {
    // Feeds a chunk of text, returns the events completed by it (often none).
    feed(chunk) {
      const out = [];
      buffer += chunk;
      if (atStart && buffer.length > 0) {
        if (buffer.startsWith("﻿")) buffer = buffer.slice(1);
        atStart = false;
      }
      for (;;) {
        if (skipLineFeed && buffer.length > 0) {
          if (buffer[0] === "\n") buffer = buffer.slice(1);
          skipLineFeed = false;
        }
        const end = buffer.search(/[\r\n]/);
        if (end === -1) {
          if (buffer.length > MAX_LINE_CHARS) {
            buffer = "";
            discardLine = true;
          }
          return out;
        }
        const line = buffer.slice(0, end);
        const terminator = buffer[end];
        buffer = buffer.slice(end + 1);
        if (terminator === "\r") {
          if (buffer.startsWith("\n")) buffer = buffer.slice(1);
          else if (buffer === "") skipLineFeed = true;
        }
        if (discardLine) {
          discardLine = false;
        } else {
          readLine(line, out);
        }
      }
    },
    // Value for the Last-Event-ID header when reconnecting, or null.
    get lastEventId() {
      return lastEventId;
    },
  };
}

const KINDS = new Set(["newNotification", "accountStatus"]);
// Event names are only logged when they look like a plain name.
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;

// Decodes one event returned by the parser.
// Returns { kind, name, data }:
// - kind: "newNotification", "accountStatus" or null (anything else: ignore it);
// - name: the SSE event name when it is a plain name, otherwise a placeholder
//   (safe to write in the log);
// - data: the decoded JSON object (null when unreadable);
// - invalid: true when the data is not a JSON object (the caller logs the name only).
export function interpretEvent(event) {
  const name = typeof event?.event === "string" && PLAIN_NAME.test(event.event) ? event.event : null;
  let data;
  try {
    data = JSON.parse(event?.data ?? "");
  } catch {
    return { kind: null, name: name ?? "(sans nom)", data: null, invalid: true };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { kind: null, name: name ?? "(sans nom)", data: null, invalid: true };
  }
  let kind = null;
  if (KINDS.has(event.event)) kind = event.event;
  else if (typeof data.type === "string" && KINDS.has(data.type)) kind = data.type;
  return { kind, name: name ?? (kind ? `(${kind} dans les données)` : "(sans nom)"), data, invalid: false };
}
