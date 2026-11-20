import { safeHref } from "./markdown.mjs";
import { actionMeta, receivedLabel, sinceLabel } from "./view.mjs";

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

const VISIBLE_LIMIT = 5;
const REASON_LABEL = { important: "Important", waiting_on_them: "Waiting on them" };
export const CATCH_UP_FAILED = "That did not save. Try again.";

/** One catch-up email. `mark` is its in-memory handled state, if any. */
function entryHtml(entry, mark, pending, now, locale) {
  const busy = pending ? " disabled" : "";
  const sender = entry.senderName ?? "";
  const badge = entry.reason
    ? `<span class="jds-badge jds-badge--${entry.reason === "important" ? "amber" : "neutral"}">${esc(REASON_LABEL[entry.reason] ?? entry.reason)}</span>`
    : "";
  const href = typeof entry.openHref === "string" ? safeHref(entry.openHref) : null;
  const open = href
    ? `<a class="${BUTTON} jds-btn--quiet" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Open</a>`
    : "";
  const reply =
    typeof entry.cacheMessageId === "string"
      ? `<button type="button" class="${BUTTON} jds-btn--quiet" data-reply="${esc(entry.cacheMessageId)}"${busy}>Reply</button>`
      : "";
  const received = Number.isNaN(Date.parse(entry.receivedAt))
    ? ""
    : `<span class="jds-caption">${esc(receivedLabel(entry.receivedAt, now, locale))}</span>`;
  const handled = mark?.status === "added" || mark?.status === "dismissed";
  const controls = handled
    ? `<span class="jds-caption">${mark.status === "added" ? "Added to your tasks" : "Dismissed"}</span>
       <button type="button" class="${BUTTON} jds-btn--quiet" data-catch="undo"${busy}>Undo</button>`
    : `${open}${reply}
       <button type="button" class="${BUTTON} jds-btn--secondary" data-catch="add"${busy}>Add task</button>
       <button type="button" class="${BUTTON} jds-btn--quiet" data-catch="dismiss" aria-label="Dismiss email from ${esc(sender)}"${busy}>Dismiss</button>`;
  return `<div class="briefing-catchup__item" data-entry="${esc(entry.id)}">
    <div class="briefing-catchup__sender"><span>${esc(sender)}</span>${badge}</div>
    <p class="briefing-catchup__excerpt">${esc(entry.summary ?? "")}</p>
    <div class="briefing-catchup__meta">${received}${controls}</div></div>`;
}

/** The catch-up block. Empty text when no entries remain. */
export function catchUpHtml(
  catchUp,
  { marks = {}, expanded = false, pending = false, failed = "" },
  now,
  locale
) {
  const entries = Array.isArray(catchUp?.entries) ? catchUp.entries : [];
  if (entries.length === 0) return "";
  const shown = expanded ? entries : entries.slice(0, VISIBLE_LIMIT);
  const more = entries.length - shown.length;
  const count = `${entries.length} ${entries.length === 1 ? "email" : "emails"} ${sinceLabel(catchUp.since, now, locale)}`;
  const error = failed ? `<p class="jds-hint jds-hint--error" role="alert">${esc(failed)}</p>` : "";
  return `<div class="briefing-catchup">
    <div class="briefing-catchup__head"><span class="jds-brief__kicker">Catch-up</span><span class="jds-caption">${esc(count)}</span></div>
    ${error}
    <div class="briefing-catchup__list">${shown.map((e) => entryHtml(e, marks[e.id], pending, now, locale)).join("")}</div>
    <div class="briefing-catchup__foot">
      ${more > 0 ? `<button type="button" class="${BUTTON} jds-btn--link" data-catch="more">Show ${more} more</button>` : ""}
      ${catchUp.leftOutCount > 0 ? `<span class="jds-caption">Left out ${catchUp.leftOutCount} newsletters, receipts and notifications.</span>` : ""}
    </div></div>`;
}

/** The whole section. Empty text hides the frame. */
export function sectionHtml(
  { phase, data, busy = "", error = "", catchState = {} },
  locale,
  now = Date.now()
) {
  const catchUp =
    phase === "ready"
      ? catchUpHtml(data.catchUp, { ...catchState, pending: busy !== "" }, now, locale)
      : "";
  if (phase === "ready" && data.state === "none" && !error && !catchUp) return "";
  const rows = data?.rows ?? [];
  const waiting = rows.filter((r) => r.status === "suggested").length;
  const head = `<div class="jds-brief__head"><span class="jds-brief__kicker">Needs you</span></div>`;
  if (phase === "loading") {
    return `<section class="jds-brief needs-you" aria-busy="true">${head}<p class="cmd-empty" role="status">Checking what needs you…</p></section>`;
  }
  if (phase === "error") {
    return `<section class="jds-brief needs-you">${head}<div class="needs-you__feedback" role="alert"><p class="jds-hint jds-hint--error">What needs you couldn't load.</p><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="retry">Try again</button></div></section>`;
  }
  const onlyCatchUp = rows.length === 0 && catchUp !== "";
  const title = `${waiting} ${waiting === 1 ? "needs" : "need"} you`;
  const failure = error
    ? `<div class="needs-you__feedback" role="alert"><p class="jds-hint jds-hint--error">${esc(error)}</p></div>`
    : "";
  const body = rows.length
    ? `<div class="loose">${rows.map((r) => rowHtml(r, busy !== "", locale)).join("")}</div>`
    : catchUp
      ? ""
      : `<p class="cmd-empty">You're caught up. Nothing is waiting on you.</p>`;
  const heading = onlyCatchUp ? "" : `<div class="jds-brief__title">${esc(title)}</div>`;
  return `<section class="jds-brief needs-you" aria-label="Needs you">${head}${heading}${failure}${body}${catchUp}</section>`;
}
