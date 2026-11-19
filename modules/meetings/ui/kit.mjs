import { esc } from "./format.mjs";

/** Small markup helpers for the shared Park Press components. */
export const chevron =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m6 9 6 6 6-6"/></svg>';

export function btn(label, act, opts = {}) {
  const {
    variant = "primary",
    sm = false,
    disabled = false,
    data = "",
    id = "",
    type = "button"
  } = opts;
  return `<button type="${type}" class="jds-btn jds-btn--${variant}${sm ? " jds-btn--sm" : ""}" data-act="${act}"${id ? ` id="${id}"` : ""}${data ? ` ${data}` : ""}${disabled ? " disabled" : ""}>${label}</button>`;
}

export const hint = (text, extra = "") => `<p class="jds-hint"${extra}>${text}</p>`;
export const status = (text) => `<p role="status" class="jds-hint">${text}</p>`;
export const alertHint = (text) => `<p role="alert" class="jds-hint jds-hint--error">${text}</p>`;
export const note = (text) => `<div class="jds-note jds-note--practical">${text}</div>`;
export const eyebrow = (text) => `<p class="jds-eyebrow jds-eyebrow--strong">${text}</p>`;

export function sectionHead(title, { number, rule = true, meta } = {}) {
  return `<div class="jds-section-head${rule ? " jds-section-head--rule" : ""}">${
    number ? `<span class="jds-section-head__number">${number}</span>` : ""
  }<h2 class="jds-section-head__title">${title}</h2>${
    meta ? `<span class="jds-section-head__meta">${meta}</span>` : ""
  }</div>`;
}

export function field(id, label, control, extra = "") {
  return `<div class="jds-field"><label class="jds-label" for="${id}">${label}</label>${control}${extra}</div>`;
}

export function input(id, value, opts = {}) {
  const {
    type = "text",
    max,
    placeholder = "",
    label = "",
    model = id,
    described = "",
    disabled = false
  } = opts;
  return `<input id="${id}" type="${type}" class="jds-input meetings-input" data-in="${model}" value="${esc(value)}"${
    max ? ` maxlength="${max}"` : ""
  }${placeholder ? ` placeholder="${esc(placeholder)}"` : ""}${label ? ` aria-label="${esc(label)}"` : ""}${
    described ? ` aria-describedby="${described}"` : ""
  }${disabled ? " disabled" : ""} />`;
}

export function textarea(id, value, opts = {}) {
  const {
    rows,
    max,
    placeholder = "",
    label = "",
    readonly = false,
    cls = "",
    model = id,
    disabled = false
  } = opts;
  return `<textarea id="${id}" class="jds-textarea meetings-input${cls ? ` ${cls}` : ""}" data-in="${model}"${
    rows ? ` rows="${rows}"` : ""
  }${max ? ` maxlength="${max}"` : ""}${placeholder ? ` placeholder="${esc(placeholder)}"` : ""}${
    label ? ` aria-label="${esc(label)}"` : ""
  }${readonly ? " readonly" : ""}${disabled ? " disabled" : ""}>${esc(value)}</textarea>`;
}

export function select(id, options, value, opts = {}) {
  const { model = id, disabled = false } = opts;
  return `<span class="jds-selectwrap"><select id="${id}" class="jds-select" data-in="${model}"${
    disabled ? " disabled" : ""
  }>${options
    .map(
      ([v, label]) =>
        `<option value="${esc(v)}"${String(v) === String(value) ? " selected" : ""}>${esc(label)}</option>`
    )
    .join("")}</select><span class="jds-selectwrap__chev">${chevron}</span></span>`;
}

export function empty(title, sub, actions = "") {
  return `<div class="jds-empty"><p class="jds-empty__title">${title}</p>${
    sub ? `<p class="jds-empty__sub">${sub}</p>` : ""
  }${actions ? `<div class="jds-empty__actions">${actions}</div>` : ""}</div>`;
}

/** A popup menu. Open state lives in the caller's state, so it survives a redraw. */
export function menu(id, triggerLabel, triggerContent, items, open, { chip = false } = {}) {
  const trigger = `<button type="button" id="${id}-trigger" class="${
    chip ? `jds-btn jds-btn--chip${open ? " jds-btn--active" : ""}` : "jds-menu__trigger"
  }" aria-label="${esc(triggerLabel)}" aria-expanded="${open}" aria-haspopup="menu"${
    open ? ` aria-controls="${id}-list"` : ""
  } data-act="menu-toggle" data-menu="${id}">${triggerContent}${chip ? chevron : ""}</button>`;
  const list = open
    ? `<div id="${id}-list" class="jds-menu__list" role="menu" aria-label="${esc(triggerLabel)}">${items
        .map(
          (i) =>
            `<button type="button" role="${i.checked === undefined ? "menuitem" : "menuitemcheckbox"}"${
              i.checked === undefined ? "" : ` aria-checked="${i.checked}"`
            } tabindex="-1" data-act="${i.act}" data-menu="${id}"${i.data ? ` ${i.data}` : ""}${
              i.disabled ? " disabled" : ""
            }>${i.label}</button>`
        )
        .join("")}</div>`
    : "";
  return `<div class="jds-menu${chip ? " jds-menu--chip" : ""}" data-menu-root="${id}">${trigger}${list}</div>`;
}
