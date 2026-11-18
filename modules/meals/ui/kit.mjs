import { esc } from "./format.mjs";

/** Small markup helpers for the shared Park Press components. */
export const chevron =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m6 9 6 6 6-6"/></svg>';
const cross =
  '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const tick =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12 5 5 9-10"/></svg>';

export function btn(label, act, opts = {}) {
  const { variant = "primary", sm = false, disabled = false, data = "", id = "" } = opts;
  return `<button type="button" class="jds-btn jds-btn--${variant}${sm ? " jds-btn--sm" : ""}" data-act="${act}"${id ? ` id="${id}"` : ""}${data ? ` ${data}` : ""}${disabled ? " disabled" : ""}>${label}</button>`;
}

export const caption = (text, attrs = "") => `<p class="jds-caption"${attrs}>${text}</p>`;

export const badge = (text, { tone = "", outline = false } = {}) =>
  `<span class="jds-badge ${outline ? "jds-badge--outline" : `jds-badge--${tone || "neutral"}`}">${text}</span>`;

export function indicator(status, label, live = false) {
  return `<span class="jds-indicator jds-indicator--${status}${live ? " jds-indicator--live" : ""}"><span class="jds-indicator__dot"></span><span>${label}</span></span>`;
}

export function sectionHead(title, { number, meta, level = 2 } = {}) {
  return `<div class="jds-section-head jds-section-head--wrap">${
    number ? `<span class="jds-section-head__number">${number}</span>` : ""
  }<h${level} class="jds-section-head__title">${title}</h${level}>${
    meta ? `<span class="jds-section-head__meta">${meta}</span>` : ""
  }</div>`;
}

export function masthead({ eyebrow, title, lede, aside }) {
  return `<header class="jds-masthead jds-masthead--field"><div class="jds-masthead__row"><div class="jds-masthead__main">${
    eyebrow ? `<p class="jds-masthead__eyebrow">${eyebrow}</p>` : ""
  }<h1 class="jds-masthead__title"><span>${title}</span></h1>${
    lede ? `<p class="jds-masthead__lede">${lede}</p>` : ""
  }</div>${aside ? `<div class="jds-masthead__aside">${aside}</div>` : ""}</div></header>`;
}

export function segmented(label, options, value) {
  return `<div class="jds-segmented" role="group" aria-label="${esc(label)}">${options
    .map(
      ([v, text]) =>
        `<button type="button" class="jds-segmented__opt" aria-pressed="${v === value}" data-act="tab" data-tab="${v}">${text}</button>`
    )
    .join("")}</div>`;
}

export function recovery(title, message, action = "", role = "alert") {
  return `<div class="jds-recovery" role="${role}"><div><div class="jds-recovery__title">${title}</div>${
    message ? `<div class="jds-recovery__msg">${message}</div>` : ""
  }${action ? `<div class="jds-recovery__actions">${action}</div>` : ""}</div></div>`;
}

export function empty(title, sub, actions = "") {
  return `<div class="jds-empty"><div class="jds-empty__title">${title}</div>${
    sub ? `<div class="jds-empty__sub">${sub}</div>` : ""
  }${actions ? `<div class="jds-empty__actions">${actions}</div>` : ""}</div>`;
}

export function field(id, label, control) {
  return `<div class="jds-field"><label class="jds-label" for="${id}">${label}</label>${control}</div>`;
}

export function input(id, value, opts = {}) {
  const { type = "text", label = "", placeholder = "", extra = "", cls = "" } = opts;
  return `<input id="${id}" type="${type}" class="jds-input${cls ? ` ${cls}` : ""}" data-in="${id}" value="${esc(value)}"${
    label ? ` aria-label="${esc(label)}"` : ""
  }${placeholder ? ` placeholder="${esc(placeholder)}"` : ""}${extra ? ` ${extra}` : ""} />`;
}

export function select(id, options, value, opts = {}) {
  const { label = "", disabled = false, model = id } = opts;
  return `<span class="jds-selectwrap"><select id="${id}" class="jds-select" data-in="${model}"${
    label ? ` aria-label="${esc(label)}"` : ""
  }${disabled ? " disabled" : ""}>${options
    .map(
      ([v, text]) =>
        `<option value="${esc(v)}"${String(v) === String(value) ? " selected" : ""}>${esc(text)}</option>`
    )
    .join("")}</select><span class="jds-selectwrap__chev">${chevron}</span></span>`;
}

export function checkbox(label, checked, act, data = "", disabled = false) {
  return `<label class="jds-check jds-checkbox"><input type="checkbox" aria-label="${esc(label)}" data-act="${act}"${
    data ? ` ${data}` : ""
  }${checked ? " checked" : ""}${disabled ? " disabled" : ""} /><span class="jds-check__box" aria-hidden="true">${tick}</span></label>`;
}

export function dialog({ id, title, body, footer, closeAct = "dialog-close" }) {
  return `<div class="jds-dialog-scrim" data-scrim="${closeAct}"><div class="jds-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title" tabindex="-1" id="${id}"><div class="jds-dialog__head"><div class="jds-dialog__heading"><div class="jds-dialog__title" id="${id}-title">${title}</div><button type="button" class="jds-iconbtn" aria-label="Close" data-act="${closeAct}">${cross}</button></div></div><div class="jds-dialog__body">${body}</div>${
    footer ? `<div class="jds-dialog__foot">${footer}</div>` : ""
  }</div></div>`;
}
