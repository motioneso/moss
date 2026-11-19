import { safeHref } from "./markdown.mjs";
import { actionMeta } from "./view.mjs";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const BUTTON = "jds-btn jds-btn--sm";

/** Reply or View, taken from the row's own saved action. Row text is never used as a link. */
function primaryControl(row, busy) {
  const action = row.primaryAction;
  if (action?.kind === "reply" && typeof action.cacheMessageId === "string") {
    return `<button type="button" class="${BUTTON} jds-btn--secondary" data-reply="${esc(action.cacheMessageId)}"${busy}>Reply</button>`;
  }
  const href = action?.kind === "view" ? safeHref(action.href) : null;
  return href
    ? `<a class="${BUTTON} jds-btn--quiet" href="${esc(href)}" target="_blank" rel="noopener noreferrer">View</a>`
    : "";
}

function rowHtml(row, pending, locale) {
  const busy = pending ? " disabled" : "";
  const controls =
    row.status === "suggested"
      ? `${primaryControl(row, busy)}
        <button type="button" class="${BUTTON} jds-btn--secondary" data-act="accept"${busy}>Accept</button>
        <button type="button" class="${BUTTON} jds-btn--quiet" data-act="dismiss"${busy}>Dismiss</button>`
      : row.status === "accepted" || row.status === "dismissed"
        ? `<span class="loose-row__meta">${row.status === "accepted" ? "Accepted" : "Dismissed"}</span>`
        : primaryControl(row, busy);
  return `<div class="loose-row" data-task="${esc(row.taskId)}">
    <div class="loose-row__main">
      <div class="loose-row__title">${esc(row.title)}</div>
      <div class="loose-row__meta">${esc(row.explanation)}</div>
      <div class="loose-row__meta">${esc(actionMeta(row, Date.now(), locale))}</div></div>
    <div class="loose-row__act">${controls}</div></div>`;
}

/** The whole section. Empty text hides the frame. */
export function sectionHtml({ phase, data, busy = "", error = "" }, locale) {
  if (phase === "ready" && data.state === "none" && !error) return "";
  const rows = data?.rows ?? [];
  const waiting = rows.filter((r) => r.status === "suggested").length;
  const head = `<div class="jds-brief__head"><span class="jds-brief__kicker">Needs you</span></div>`;
  if (phase === "loading") {
    return `<section class="jds-brief needs-you" aria-busy="true">${head}<p class="cmd-empty" role="status">Checking what needs you…</p></section>`;
  }
  if (phase === "error") {
    return `<section class="jds-brief needs-you">${head}<div class="needs-you__feedback" role="alert"><p class="jds-hint jds-hint--error">What needs you couldn't load.</p><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="retry">Try again</button></div></section>`;
  }
  const title = `${waiting} ${waiting === 1 ? "needs" : "need"} you`;
  const failure = error
    ? `<div class="needs-you__feedback" role="alert"><p class="jds-hint jds-hint--error">${esc(error)}</p></div>`
    : "";
  const body = rows.length
    ? `<div class="loose">${rows.map((r) => rowHtml(r, busy !== "", locale)).join("")}</div>`
    : `<p class="cmd-empty">You're caught up. Nothing is waiting on you.</p>`;
  return `<section class="jds-brief needs-you" aria-label="Needs you">${head}<div class="jds-brief__title">${esc(title)}</div>${failure}${body}</section>`;
}
