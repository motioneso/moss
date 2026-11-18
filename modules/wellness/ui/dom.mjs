/** Builds elements with textContent only, so text from the server never becomes markup. */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else if (key in node && key !== "list" && key !== "type" && key !== "form") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Icon markup is fixed text in this file, never data from the server. */
export function icon(paths, { size = 16, stroke = 2 } = {}) {
  const span = document.createElement("span");
  span.className = "wl-ic";
  span.style.display = "inline-flex";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return span;
}

export const PATHS = {
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  cloudRain:
    '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>',
  notebookPen:
    '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="m21.378 3.626-1.004-1.004a2.121 2.121 0 0 0-3 0l-5.37 5.374 2 2 5.37-5.374"/>',
  pill: '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
};

export function sectionHead(number, title, meta) {
  return h(
    "div",
    { class: "jds-section-head" },
    h("span", { class: "jds-section-head__number" }, number),
    h("h2", { class: "jds-section-head__title" }, title),
    meta ? h("span", { class: "jds-section-head__meta" }, meta) : null
  );
}

export function button(label, { variant = "primary", size = "md", iconPaths, ...rest } = {}) {
  const classes = ["jds-btn", `jds-btn--${variant}`, size !== "md" ? `jds-btn--${size}` : null];
  return h(
    "button",
    { type: "button", class: classes.filter(Boolean).join(" "), ...rest },
    iconPaths ? h("span", { class: "jds-btn__icon" }, icon(iconPaths, { size: 15 })) : null,
    label
  );
}

export const linkButton = (label, onclick, extra = null) =>
  h("button", { type: "button", class: "jds-btn jds-btn--link", onclick }, label, extra);
