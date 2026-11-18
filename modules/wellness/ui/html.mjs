// Small helpers and icons shared by the Wellness views.
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const svg = (inner, size = 16, width = 2) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const icons = {
  pill: () =>
    svg(
      '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>'
    ),
  pulse: () => svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  check: (size = 14) => svg('<polyline points="20 6 9 17 4 12"/>', size, 2.6),
  sunrise: () =>
    svg(
      '<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
      13
    ),
  moon: () => svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', 13),
  flame: (size = 13) =>
    svg(
      '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
      size
    ),
  plus: () => svg('<path d="M12 5v14M5 12h14"/>', 13, 2.2),
  pencil: () => svg('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>', 13),
  sliders: () =>
    svg(
      '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
      14
    ),
  clipboard: () =>
    svg(
      '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>'
    ),
  chevron: () => svg('<path d="m9 18 6-6-6-6"/>', 14),
  note: () =>
    svg(
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
      13
    ),
  help: () =>
    svg(
      '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
      14
    ),
  trash: () =>
    svg(
      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
      14
    ),
  x: () => svg('<path d="M18 6 6 18M6 6l12 12"/>', 14),
  trend: () =>
    svg(
      '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
      14
    ),
  search: () => svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 14)
};

export const signed = (n) => `${n > 0 ? "+" : ""}${n}`;

export const sectionHead = (number, title, meta = "") =>
  `<div class="jds-section-head"><span class="jds-section-head__number">${number}</span><h2 class="jds-section-head__title">${esc(title)}</h2>${meta ? `<span class="jds-section-head__meta">${meta}</span>` : ""}</div>`;

export const button = (
  label,
  { act, variant = "secondary", size = "sm", disabled = false, extra = "" } = {}
) =>
  `<button type="button" class="jds-btn jds-btn--${variant}${size !== "md" ? ` jds-btn--${size}` : ""}" data-act="${act}"${disabled ? " disabled" : ""}${extra}>${label}</button>`;

export function dialogHtml({
  title,
  desc = "",
  className = "",
  body,
  footer = "",
  closeLabel,
  closeDisabled = false
}) {
  return `<div class="jds-dialog-scrim" data-scrim><div class="jds-dialog ${className}" tabindex="-1" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="jds-dialog__head"><div class="jds-dialog__heading"><div class="jds-dialog__title">${esc(title)}</div>
      ${closeLabel ? `<button type="button" class="jds-iconbtn" aria-label="${esc(closeLabel)}" data-act="modal-close"${closeDisabled ? " disabled" : ""}>${icons.x()}</button>` : ""}</div>
      ${desc ? `<div class="jds-dialog__desc">${esc(desc)}</div>` : ""}</div>
    <div class="jds-dialog__body">${body}</div>${footer ? `<div class="jds-dialog__foot">${footer}</div>` : ""}</div></div>`;
}

export const radioCards = (name, label, options, value) =>
  `<div class="jds-radio-cards" role="radiogroup" aria-label="${esc(label)}">${options
    .map(
      (o) =>
        `<label class="jds-radio-card"><input type="radio" name="${esc(name)}" value="${esc(o.value)}"${value === o.value ? " checked" : ""}><span class="jds-radio-card__label">${esc(o.label)}</span>${o.description ? `<span class="jds-radio-card__description">${esc(o.description)}</span>` : ""}</label>`
    )
    .join("")}</div>`;
