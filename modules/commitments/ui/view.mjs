export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/** Calendar arithmetic in the browser's local zone, including daylight saving changes. */
export function snoozeUntil(choice, now, date) {
  const local = new Date(now);
  if (choice === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("Pick a future date.");
    const [year, month, day] = date.split("-").map(Number);
    local.setFullYear(year, month - 1, day);
    if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day)
      throw new Error("Pick a valid date.");
  } else if (choice === "tomorrow" || choice === "week") {
    local.setDate(local.getDate() + (choice === "tomorrow" ? 1 : 7));
  } else throw new Error("Choose when to review this again.");
  local.setHours(0, 0, 0, 0);
  if (local.getTime() <= new Date(now).getTime()) throw new Error("Pick a future date.");
  return local.toISOString();
}

export function dueLabel(value, locale) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? ""
    : `Due ${date.toLocaleDateString(locale, { month: "short", day: "numeric" })}`;
}

const icon = (path, size = 15) =>
  `<svg aria-hidden="true" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" viewBox="0 0 24 24">${path}</svg>`;
const clock = icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>');
const sourceIcons = {
  email: icon('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>', 13),
  chat: icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>', 13)
};
const names = { email: "Email", chat: "Chat", notes: "Notes" };

function rowHtml(row, busy, picker) {
  const id = esc(row.id);
  const disabled = busy ? " disabled" : "";
  const sources = [...new Set((row.evidence ?? []).map((s) => s.sourceKind))].filter(
    (s) => names[s]
  );
  const meta = [
    row.counterpartyLabel ? `To ${row.counterpartyLabel}` : "",
    dueLabel(row.dueLocalDate)
  ]
    .filter(Boolean)
    .map((s) => `<span class="jds-task__source">${esc(s)}</span>`)
    .join("");
  return `<div class="jds-task commitments-row" data-candidate="${id}"${busy === row.id ? ' aria-busy="true"' : ""}>
    <span class="jds-task__check">${clock}</span>
    <div class="jds-task__main"><div class="jds-task__title">${esc(row.title)}</div>
      <div class="jds-task__meta">${meta}${sources.map((s) => `<span class="jds-task__source">${sourceIcons[s] ?? ""}${names[s]}</span>`).join("")}</div></div>
    <div class="commitments-actions">
      <button type="button" class="jds-btn jds-btn--secondary jds-btn--sm" data-act="accepted"${disabled}>Accept</button>
      <div class="jds-menu"><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-menu-trigger aria-haspopup="menu" aria-expanded="false"${disabled}>Snooze</button>
        <div class="jds-menu__list" role="menu" aria-label="Snooze" hidden>
          <button type="button" role="menuitem" data-act="tomorrow">Tomorrow</button>
          <button type="button" role="menuitem" data-act="week">Next week</button>
          <button type="button" role="menuitem" data-act="pick">Pick a date…</button></div></div>
      <button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="rejected"${disabled}>Reject</button></div>
    ${
      picker === row.id
        ? `<form class="commitments-date" data-date-form><label class="jds-label" for="snooze-date">Snooze until</label>
      <input class="jds-input" id="snooze-date" type="date" required${disabled} />
      <button class="jds-btn jds-btn--secondary jds-btn--sm"${disabled}>Snooze</button>
      <button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="cancel"${disabled}>Cancel</button></form>`
        : ""
    }</div>`;
}

export function sectionHtml({ phase, rows = [], busy = "", error = "", notice = "", picker = "" }) {
  if (phase === "ready" && rows.length === 0 && !error) return "";
  const head = `<div class="jds-brief__head"><span class="jds-brief__kicker">Commitments</span>${phase === "ready" ? `<span class="jds-brief__updated">${rows.length} to review</span>` : ""}</div>
    <h2 class="jds-brief__title" id="commitments-title">Things you said you would do</h2>`;
  const status =
    phase === "loading" ? '<p class="jds-caption" role="status">Loading commitments…</p>' : "";
  const failure = error
    ? `<div class="commitments-feedback" role="alert"><p class="jds-hint jds-hint--error">${esc(error)}</p><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="retry">Try again</button></div>`
    : "";
  return `<section class="jds-brief commitments-section" aria-labelledby="commitments-title"${phase === "loading" ? ' aria-busy="true"' : ""}>${head}${status}${failure}${notice ? `<p class="jds-caption" role="status">${esc(notice)}</p>` : ""}<div class="loose">${rows.map((r) => rowHtml(r, busy, picker)).join("")}</div></section>`;
}
