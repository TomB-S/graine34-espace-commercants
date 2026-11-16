// What the script does to the page: the only file that builds elements. It receives a `document` (so that the tests give it a
// small stand-in) and the data of GET /caisse/data. Every text, above all the ones that come from Cyclos (payer, description,
// number), is put with textContent or as a text node: never HTML built from a string.
//
// The page arrives complete from the server (fallback without script). The first update replaces its content by the
// same structure, with the same class names, so that style.css is the only stylesheet. Afterwards:
// - the big ticket is updated in place while it is the same payment (no blink, the fade of the "new" background is not replayed);
// - the list and the banner are rebuilt only when their content changed;
// - the date line is worked out again with the age (refreshAges), without touching anything else.
import { TEXTS } from "./caisse-texts.js";
import { dateLine } from "./date-line.js";
import { pollFooterText } from "./refresh-logic.js";

const LIVE = new Set(["live", "fallback"]);

export function createCaisseView(document, { pollSeconds, nowMs, onSoundToggle = () => {}, onNotificationToggle = () => {}, onRefresh = () => {} }) {
  const zone = (name) => document.getElementById(`caisse-zone-${name}`);
  const zones = { direct: zone("direct"), state: zone("etat"), content: zone("contenu"), sound: zone("son"), notification: zone("notif"), refresh: zone("actualiser") };
  const footer = document.getElementById("caisse-actualisation");

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  let last = null; // last data shown
  let offline = false;
  const signatures = { state: null, direct: null, list: null, empty: null };
  let holders = null; // { big, list, empty }: stable blocks of the content zone
  let big = null; // { section, keys, parts, at, label } big ticket on screen

  // ---- banner and header badge ----

  function renderBanner() {
    const banner = offline ? { level: "warning", text: TEXTS.offline } : (last?.banner ?? null);
    const signature = JSON.stringify(banner);
    if (signature === signatures.state) return;
    signatures.state = signature;
    if (!banner) {
      zones.state.replaceChildren();
      return;
    }
    if (banner.level === "info") {
      const line = make("p", "caisse-etat", banner.text);
      line.setAttribute("role", "status");
      zones.state.replaceChildren(line);
      return;
    }
    const paragraph = make("p", `caisse-bandeau ${banner.level === "error" ? "erreur" : "avertissement"}`);
    paragraph.setAttribute("role", "status");
    const icon = make("span", "icone", "⚠");
    icon.setAttribute("aria-hidden", "true");
    paragraph.append(icon, ` ${banner.text}`);
    zones.state.replaceChildren(paragraph);
  }

  function renderBadge() {
    const show = !offline && last !== null && LIVE.has(last.status);
    if (show === signatures.direct) return;
    signatures.direct = show;
    if (!show) {
      zones.direct.replaceChildren();
      return;
    }
    const badge = make("span", "caisse-direct");
    const dot = make("span", "caisse-direct-point");
    dot.setAttribute("aria-hidden", "true");
    badge.append(dot, TEXTS.live);
    zones.direct.replaceChildren(badge);
  }

  // ---- content ----

  function ensureHolders() {
    if (holders) return;
    holders = { big: make("div"), list: make("div"), empty: make("div") };
    zones.content.replaceChildren(holders.big, holders.list, holders.empty);
  }

  function buildBig() {
    const section = make("section", "caisse-gros");
    section.setAttribute("aria-label", TEXTS.lastPayment);
    const parts = {
      mark: make("p", "caisse-nouveau", TEXTS.newMark),
      payer: make("p", "caisse-gros-payeur"),
      amount: make("p", "caisse-gros-montant"),
      date: make("p", "caisse-gros-heure"),
      description: make("p", "caisse-gros-description"),
      number: make("p", "caisse-gros-numero"),
    };
    section.append(parts.mark, parts.payer, parts.amount, parts.date, parts.description, parts.number);
    return { section, parts, keys: new Set(), at: 0, label: "" };
  }

  function fillBig(ticket) {
    const { parts } = big;
    parts.mark.hidden = !ticket.isNew;
    parts.payer.textContent = ticket.payer;
    parts.amount.className = ticket.amountReady ? "caisse-gros-montant" : "caisse-gros-attente";
    parts.amount.textContent = ticket.amount;
    big.at = ticket.at;
    big.label = ticket.dateLabel;
    parts.date.textContent = dateLine(ticket.dateLabel, ticket.at, nowMs());
    parts.description.hidden = !ticket.description;
    parts.description.textContent = ticket.description ? `${TEXTS.descriptionLabel}${ticket.description}` : "";
    parts.number.hidden = !ticket.number;
    parts.number.textContent = ticket.number ? `${TEXTS.numberLabel}${ticket.number}` : "";
    big.keys = new Set(ticket.keys);
  }

  function renderBig(top, isFresh) {
    // The same payment keeps its element (a ticket first known by its notification gains a key, never loses one).
    if (big && top.keys.some((key) => big.keys.has(key))) {
      fillBig(top);
      return;
    }
    big = buildBig();
    if (isFresh) big.section.className = "caisse-gros caisse-gros-neuf";
    fillBig(top);
    holders.big.replaceChildren(big.section);
  }

  function buildRow(ticket) {
    const row = make("li", "caisse-ligne");
    const payer = make("span", "caisse-payeur");
    payer.append(ticket.payer);
    if (ticket.isNew) payer.append(" ", make("span", "caisse-nouveau-petit", TEXTS.newMark));
    const who = make("span", "caisse-qui");
    who.append(payer);
    if (ticket.description) who.append(make("span", "caisse-description", ticket.description));
    row.append(make("span", "caisse-heure", ticket.time), who, make("span", "caisse-montant", ticket.amount));
    return row;
  }

  function renderList(others) {
    const signature = JSON.stringify(others);
    if (signature === signatures.list) return;
    signatures.list = signature;
    if (others.length === 0) {
      holders.list.replaceChildren();
      return;
    }
    const heading = make("h2", undefined, TEXTS.previous);
    const rows = make("ol", "caisse-precedents");
    rows.append(...others.map(buildRow));
    holders.list.replaceChildren(heading, rows);
  }

  function renderEmpty(show) {
    if (show === signatures.empty) return;
    signatures.empty = show;
    if (!show) {
      holders.empty.replaceChildren();
      return;
    }
    const box = make("div", "caisse-vide");
    box.append(make("p", "caisse-vide-titre", TEXTS.emptyTitle), make("p", undefined, TEXTS.emptyHelp));
    holders.empty.replaceChildren(box);
  }

  // A line made of a button and, always visible, a state in words (the sound, the notifications). `label` comes from
  // soundLabel() or notificationLabel(): { text, buttonText (null = no button), active }. Built at the first call, then updated
  // in place. No script, no line: the zone stays empty in the page rendered by the server.
  function controlLine(zoneNode, prefix, onClick) {
    let box = null;
    let signature = null;
    return (label) => {
      if (!zoneNode) return;
      const next = JSON.stringify(label);
      if (next === signature) return;
      signature = next;
      if (!box) {
        const line = make("p", prefix);
        const button = make("button");
        button.setAttribute("type", "button");
        button.addEventListener("click", () => onClick());
        const status = make("span", `${prefix}-etat`);
        status.setAttribute("role", "status");
        line.append(button, status);
        zoneNode.replaceChildren(line);
        box = { line, button, status };
      }
      box.status.textContent = label.text;
      box.button.hidden = label.buttonText === null;
      box.button.textContent = label.buttonText ?? "";
      box.line.className = label.active ? `${prefix} ${prefix}-actif` : prefix;
    };
  }
  const renderSound = controlLine(zones.sound, "caisse-son", onSoundToggle);
  const renderNotification = controlLine(zones.notification, "caisse-notif", onNotificationToggle);

  // The "Actualiser" button, built at the first call: `state` is { text, disabled } from refreshState(). While it is disabled the browser
  // takes the focus away from it, so the focus is given back when it is enabled again (keyboard users keep their place).
  let refreshButton = null;
  let refreshSignature = null;
  let refreshHadFocus = false;
  function renderRefresh(state) {
    if (!zones.refresh) return;
    const next = JSON.stringify(state);
    if (next === refreshSignature) return;
    refreshSignature = next;
    if (!refreshButton) {
      const line = make("p", "caisse-actualiser");
      refreshButton = make("button");
      refreshButton.setAttribute("type", "button");
      refreshButton.addEventListener("click", () => onRefresh());
      line.append(refreshButton);
      zones.refresh.replaceChildren(line);
    }
    if (state.disabled) refreshHadFocus = document.activeElement === refreshButton;
    refreshButton.textContent = state.text;
    refreshButton.disabled = state.disabled;
    if (!state.disabled && refreshHadFocus) {
      refreshHadFocus = false;
      refreshButton.focus?.();
    }
  }

  return {
    updateSound: renderSound,
    updateRefresh: renderRefresh,
    updateNotifications: renderNotification,

    // New data. `freshTickets`: the tickets the detector found new in this very update (they get the fading background).
    update(data, freshTickets = []) {
      last = data;
      offline = false;
      ensureHolders();
      const [top, ...others] = data.tickets;
      if (top) {
        renderBig(top, freshTickets.includes(top));
        renderList(others);
        renderEmpty(false);
      } else {
        big = null;
        holders.big.replaceChildren();
        renderList([]);
        renderEmpty(LIVE.has(data.status));
      }
      renderBanner();
      renderBadge();
      if (footer) footer.textContent = pollFooterText(pollSeconds);
    },

    // The server cannot be reached: the display stays as it is, a banner says so.
    setOffline(value) {
      if (offline === value) return;
      offline = value;
      renderBanner();
      renderBadge();
    },

    // "il y a x min" worked out again, nothing else touched.
    refreshAges() {
      if (big) big.parts.date.textContent = dateLine(big.label, big.at, nowMs());
    },
  };
}
