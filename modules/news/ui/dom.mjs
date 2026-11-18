/* global document, Node */

/** Builds an element. Props starting with "on" become listeners; null and false children are skipped. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      el.className = value;
    } else if (key === "value") {
      el.value = String(value);
    } else if (key === "href" && !/^\//.test(String(value))) {
      continue;
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replaces an element's children, skipping empty values so they never print as text. */
export function fill(el, ...children) {
  // Keep the caret in a text box that is rebuilt while someone types in it.
  const active = document.activeElement;
  const keep = active && active.id && el.contains(active) ? active : null;
  const start = keep?.selectionStart ?? null;
  const end = keep?.selectionEnd ?? null;
  el.replaceChildren(
    ...children
      .flat(Infinity)
      .filter((c) => c !== null && c !== undefined && c !== false)
      .map((c) => (c instanceof Node ? c : document.createTextNode(String(c))))
  );
  if (keep && keep !== document.activeElement) {
    const again = document.getElementById(keep.id);
    if (again && el.contains(again)) {
      again.focus();
      if (start !== null && again.setSelectionRange) again.setSelectionRange(start, end);
    }
  }
  return el;
}

export function button(label, { variant = "primary", size = "md", ...rest } = {}) {
  const cls = ["jds-btn", `jds-btn--${variant}`, size !== "md" ? `jds-btn--${size}` : null]
    .filter(Boolean)
    .join(" ");
  return h("button", { type: "button", ...rest, class: cls }, label);
}

/** Tones follow the shared sheet. The old "pine" tone is "forest" there. */
export function badge(label, tone = "neutral", { dot = false } = {}) {
  return h(
    "span",
    { class: `jds-badge jds-badge--${tone === "pine" ? "forest" : tone}` },
    dot ? h("span", { class: "jds-badge__dot" }) : null,
    label
  );
}

const SVG = "http://www.w3.org/2000/svg";

/** Fixed icon paths only, never data from the server. */
export function icon(paths, size = 16) {
  const el = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true"
  }))
    el.setAttribute(k, String(v));
  el.innerHTML = paths;
  return el;
}

export const PATHS = {
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  newspaper:
    '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>'
};

/** A quiet information line with the small info icon. */
export function note(...children) {
  return h("p", { class: "set2-note" }, icon(PATHS.info, 13), h("span", {}, ...children));
}

export function pending(el, on) {
  el.disabled = on;
  return el;
}
