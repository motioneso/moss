import { safeHref, renderMarkdown } from "./markdown.mjs";
import {
  actionMeta,
  contributionFor,
  finalsLines,
  formatAge,
  monthDay,
  readGaps,
  receivedLabel,
  sinceLabel,
  sourceLabel,
  tonightLine
} from "./view.mjs";

export const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const REASON_LABEL = { waiting_on_them: "Waiting on them", important: "Important" };
const VISIBLE_LIMIT = 5;

function actionButton(row) {
  const action = row.primaryAction;
  if (action?.kind === "reply" && typeof action.cacheMessageId === "string") {
    return `<button type="button" class="jds-btn jds-btn--sm jds-btn--quiet" data-reply="${esc(action.cacheMessageId)}">Reply</button>`;
  }
  if (action?.kind === "view" && typeof action.href === "string") {
    return linkButton(action.href, "View");
  }
  return "";
}

function linkButton(href, label) {
  if (href.startsWith("/") && !href.startsWith("//")) {
    return `<button type="button" class="jds-btn jds-btn--sm jds-btn--quiet" data-go="${esc(href)}">${label}</button>`;
  }
  const safe = safeHref(href);
  return safe
    ? `<a class="jds-btn jds-btn--sm jds-btn--quiet" href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : "";
}

/** Suggested-task rows. Accepting and dismissing live on Today, so rows here are read only. */
export function actionRowsHtml(rows, now, locale) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const label = `${rows.length} ${rows.length === 1 ? "thing needs" : "things need"} you`;
  return `<section class="jds-brief briefing-actions" aria-label="Needs you">
    <div class="jds-brief__head"><span class="jds-brief__kicker">Needs you</span></div>
    <div class="jds-brief__title">${esc(label)}</div>
    <div class="loose">${rows
      .map(
        (row) => `<div class="loose-row"><div class="loose-row__main">
          <div class="loose-row__title">${esc(row.title ?? "")}</div>
          <div class="loose-row__meta">${esc(row.explanation ?? "")}</div>
          <div class="loose-row__meta">${esc(actionMeta(row, now, locale))}</div></div>
          <div class="loose-row__act">${actionButton(row)}</div></div>`
      )
      .join("")}</div></section>`;
}

/** Email catch-up. Adding a task or dismissing an email lives on Today. */
export function catchUpHtml(catchUp, now, locale, expanded) {
  const entries = Array.isArray(catchUp?.entries) ? catchUp.entries : [];
  if (entries.length === 0) return "";
  const visible = expanded ? entries : entries.slice(0, VISIBLE_LIMIT);
  const hidden = entries.length - visible.length;
  const count = `${entries.length} ${entries.length === 1 ? "email" : "emails"} ${sinceLabel(catchUp.since, now, locale)}`;
  return `<div class="briefing-catchup">
    <div class="briefing-catchup__head"><span class="jds-brief__kicker">Catch-up</span><span class="jds-caption">${esc(count)}</span></div>
    <div class="briefing-catchup__list">${visible
      .map((entry) => {
        const badge = entry.reason
          ? `<span class="jds-badge jds-badge--${entry.reason === "important" ? "amber" : "neutral"}">${esc(REASON_LABEL[entry.reason] ?? entry.reason)}</span>`
          : "";
        const reply =
          typeof entry.cacheMessageId === "string"
            ? `<button type="button" class="jds-btn jds-btn--sm jds-btn--quiet" data-reply="${esc(entry.cacheMessageId)}">Reply</button>`
            : "";
        const open = typeof entry.openHref === "string" ? linkButton(entry.openHref, "Open") : "";
        return `<div class="briefing-catchup__item">
          <div class="briefing-catchup__sender"><span>${esc(entry.senderName ?? "")}</span>${badge}</div>
          <p class="briefing-catchup__excerpt">${esc(entry.summary ?? "")}</p>
          <div class="briefing-catchup__meta"><span class="jds-caption">${esc(receivedLabel(entry.receivedAt, now, locale))}</span>${open}${reply}</div></div>`;
      })
      .join("")}</div>
    <div class="briefing-catchup__foot">
      ${hidden > 0 ? `<button type="button" class="jds-btn jds-btn--sm jds-btn--link" id="catchup-more">Show ${hidden} more</button>` : ""}
      ${catchUp.leftOutCount > 0 ? `<span class="jds-caption">Left out ${catchUp.leftOutCount} newsletters, receipts and notifications.</span>` : ""}
    </div></div>`;
}

function editorial(id, label, eyebrow, headline, photo, paragraphs, tonight, cta) {
  const safePhoto = photo ? safeHref(photo) : null;
  return `<section class="brief-reader__editorial" id="${id}" aria-label="${label}" tabindex="-1">
    <div class="brief-reader__editorial-eyebrow">${eyebrow}</div>
    ${headline ? `<h4 class="brief-reader__editorial-headline">${esc(headline)}</h4>` : ""}
    ${safePhoto ? `<img class="brief-reader__photo" src="${esc(safePhoto)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
    ${paragraphs.map((p) => `<p class="brief-reader__editorial-paragraph">${p}</p>`).join("")}
    ${tonight ? `<h5 class="brief-reader__editorial-subhead">${esc(tonight.heading)}</h5><p class="brief-reader__editorial-paragraph">${esc(tonight.paragraph)}</p>` : ""}
    ${cta ? `<button type="button" class="brief-reader__editorial-cta" data-go="/">${cta}</button>` : ""}
  </section>`;
}

export function newsBlock(news) {
  if (!news) return "";
  const first = news.stories[0];
  return editorial(
    "brief-reader-news",
    "News",
    "NEWS / THE BIG STORIES",
    first?.title ?? null,
    first?.imageUrl ?? null,
    news.stories.slice(0, 2).flatMap((s) => (s.summary ? [esc(s.summary)] : [])),
    null,
    "Read the stories ↗"
  );
}

export function sportsBlock(sports, locale) {
  if (!sports) return "";
  const games = Array.isArray(sports.games) ? sports.games : [];
  const first = sports.stories[0];
  return editorial(
    "brief-reader-sports",
    "Sports",
    "SPORTS / YOUR TEAMS FIRST",
    first?.title ?? games[0]?.headline ?? null,
    first?.imageUrl ?? null,
    finalsLines(games).map(
      (g) =>
        `${esc(g.away)} <strong>${esc(g.awayScore)}</strong>, ${esc(g.home)} <strong>${esc(g.homeScore)}</strong> final.`
    ),
    tonightLine(games, locale),
    "See scores &amp; tonight's games ↗"
  );
}

/** The "What informed this briefing?" list, one honest line per source. */
export function sourcesHtml(freshness, metadata) {
  const gaps = readGaps(metadata);
  if (!freshness && gaps.length === 0) return "";
  const lines = (freshness?.sources ?? []).map((entry) => {
    const contribution = contributionFor(entry.source, metadata);
    return `<li class="brief-reader__source"><span class="brief-reader__source-name">${esc(sourceLabel(entry.source))}</span> <span class="jds-caption">${esc(formatAge(entry, freshness.capturedAt))}${contribution ? ` · ${esc(contribution)}` : ""}</span></li>`;
  });
  const gapLines = gaps.map(
    (gap) =>
      `<p class="brief-reader__gap">${esc(sourceLabel(gap.source))}: No longer available (${esc(gap.reason)}).</p>`
  );
  return `<details class="brief-reader__sources"><summary>What informed this briefing?</summary>
    ${lines.length ? `<ul class="brief-reader__source-list">${lines.join("")}</ul>` : ""}${gapLines.join("")}</details>`;
}

export function earlierHtml(runs, selectedId, locale) {
  if (runs.length < 2) return "";
  return `<details class="brief-reader__earlier"><summary>Earlier reports</summary><ul>${runs
    .map(
      (run) =>
        `<li><button type="button" class="jds-btn jds-btn--quiet" data-run="${esc(run.id)}" ${run.id === selectedId ? "disabled" : ""}>Report from ${esc(monthDay(run.createdAt, locale))}${run.id === selectedId ? " (open)" : ""}</button></li>`
    )
    .join("")}</ul></details>`;
}

export { renderMarkdown };
