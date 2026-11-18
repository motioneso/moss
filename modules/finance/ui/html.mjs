// Small markup helpers for the Finance screens, built on the jds-* styles.
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const svg = (inner, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const icons = {
  prev: () => svg('<path d="m15 18-6-6 6-6"/>'),
  next: () => svg('<path d="m9 18 6-6-6-6"/>'),
  cog: () =>
    svg(
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>'
    ),
  chevron: () => svg('<path d="m6 9 6 6 6-6"/>', 14)
};

export const button = (
  label,
  { act, variant = "secondary", size = "sm", disabled = false, extra = "" } = {}
) =>
  `<button type="button" class="jds-btn jds-btn--${variant}${size !== "md" ? ` jds-btn--${size}` : ""}" data-act="${act}"${disabled ? " disabled" : ""}${extra}>${label}</button>`;

export const badge = (label, tone = "neutral") =>
  `<span class="jds-badge jds-badge--${tone}">${esc(label)}</span>`;

export const sectionHead = (title, meta = "", { rule = true } = {}) =>
  `<div class="jds-section-head${rule ? " jds-section-head--rule" : ""}"><h2 class="jds-section-head__title">${esc(title)}</h2>${meta ? `<span class="jds-section-head__meta">${esc(meta)}</span>` : ""}</div>`;

export const eyebrow = (text) =>
  `<span class="jds-eyebrow jds-eyebrow--strong">${esc(text)}</span>`;

export const note = (variant, text) => `<p class="jds-note jds-note--${variant}">${esc(text)}</p>`;

export const emptyState = (title, body = "", actions = "") =>
  `<div class="jds-empty"><div class="jds-empty__title">${esc(title)}</div>${body ? `<div class="jds-empty__sub">${esc(body)}</div>` : ""}${actions ? `<div class="jds-empty__actions">${actions}</div>` : ""}</div>`;

export const loadingLine = (label) => `<p class="jds-hint" role="status">${esc(label)}…</p>`;

export const errorState = (message, retry) =>
  `<div class="jds-card jds-card--sunken" role="alert"><div class="fnm-state">${eyebrow("Something went wrong")}<p>${esc(message)}</p>${retry ?? ""}</div></div>`;

export const stepper = ({ label, prev, next, prevText, nextText }) =>
  `<div class="jds-stepper"><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="${prev}" aria-label="Previous period">${prevText ?? icons.prev()}</button><span class="jds-stepper__label" aria-live="polite">${esc(label)}</span><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="${next}" aria-label="Next period">${nextText ?? icons.next()}</button></div>`;

export const segmented = (label, options, value) =>
  `<div class="jds-segmented" role="group" aria-label="${esc(label)}">${options
    .map(
      (o) =>
        `<button type="button" class="jds-segmented__opt" data-act="${o.act}"${o.data ?? ""} aria-pressed="${o.value === value}">${o.label}</button>`
    )
    .join("")}</div>`;

export const masthead = ({ eyebrowText, title, aside = "", field = true }) =>
  `<header class="jds-masthead${field ? " jds-masthead--field" : ""}"><div class="jds-masthead__row"><div class="jds-masthead__main"><p class="jds-masthead__eyebrow">${esc(eyebrowText)}</p><h1 class="jds-masthead__title">${title}</h1></div>${aside ? `<div class="jds-masthead__aside">${aside}</div>` : ""}</div></header>`;

export const statTile = ({ label, value, act, warn = false, extra = "" }) =>
  `<button type="button" class="jds-stat-tile${warn ? " jds-stat-tile--warn" : ""}" data-act="${act}"${extra}><div class="jds-stat-tile__label">${esc(label)}<span class="jds-stat-tile__go" aria-hidden="true">›</span></div><div class="jds-stat-tile__value">${esc(value)}</div></button>`;

export function dialogHtml({ title, body, footer = "", closeLabel = "Close" }) {
  return `<div class="jds-dialog-scrim" data-scrim><div class="jds-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="jds-dialog__head"><div class="jds-dialog__heading"><div class="jds-dialog__title">${esc(title)}</div><button type="button" class="jds-iconbtn" aria-label="${esc(closeLabel)}" data-act="dialog-close">×</button></div></div><div class="jds-dialog__body">${body}</div>${footer ? `<div class="jds-dialog__foot">${footer}</div>` : ""}</div></div>`;
}

/** A random operation id. randomUUID needs https, and the app also loads over plain http. */
export function newOperationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
