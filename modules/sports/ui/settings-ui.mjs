import { h, svg, button } from "./dom.mjs";

const CHEVRON_RIGHT = "m9 18 6-6-6-6";
const CHEVRON_DOWN = "m6 9 6 6 6-6";
const INFO_RING = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z";

export function chevron(open) {
  return svg(
    {
      viewBox: "0 0 24 24",
      width: 16,
      height: 16,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true"
    },
    open ? CHEVRON_DOWN : CHEVRON_RIGHT
  );
}

/** A quiet note with the small info mark, like the notes on the other settings panes. */
export function note(...children) {
  const mark = svg(
    {
      viewBox: "0 0 24 24",
      width: 13,
      height: 13,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "aria-hidden": "true"
    },
    INFO_RING,
    "M12 16v-4",
    "M12 8h.01"
  );
  return h("p", { class: "set2-note" }, mark, h("span", {}, ...children));
}

export function badge(label, tone = "neutral", pill = false) {
  return h(
    "span",
    { class: `jds-badge jds-badge--${tone}${pill ? " jds-badge--pill" : ""}` },
    label
  );
}

export function sectionHead(title, titleId) {
  return h(
    "div",
    { class: "jds-section-head" },
    h("h3", { class: "jds-section-head__title", id: titleId }, title)
  );
}

export function disclosure({ className, expanded, controls, onClick, id }, ...children) {
  return h(
    "button",
    {
      type: "button",
      id,
      class: `jds-disclosure ${className ?? ""}`.trim(),
      "aria-expanded": String(expanded),
      "aria-controls": controls,
      onClick
    },
    ...children
  );
}

/** A checkbox with the shared box mark. `input` is returned so callers can set indeterminate. */
export function check({ label, ariaLabel, checked, disabled, onChange, id, className }) {
  const input = h("input", { type: "checkbox", id, "aria-label": ariaLabel });
  input.checked = Boolean(checked);
  input.disabled = Boolean(disabled);
  input.addEventListener("change", () => onChange(input.checked));
  const box = h(
    "span",
    { class: "jds-check__box" },
    svg(
      {
        viewBox: "0 0 24 24",
        width: 13,
        height: 13,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 3,
        "aria-hidden": "true"
      },
      "M20 6 9 17l-5-5"
    )
  );
  const el = h(
    "label",
    { class: `jds-check ${className ?? ""}`.trim(), for: id },
    input,
    box,
    label === undefined ? null : label
  );
  return { el, input };
}

export { button };
