// Pure helpers and markup for the News screen and the Today widget. No DOM access here, so
// every function can run under node:test.

export const CAROUSEL_CAP = 5;
const MAJORS_CAP = 2;
const STANDARDS_CAP = 6;
const BRIEFS_CAP = 10;
const RAIL_ITEMS_CAP = 12;
export const WIDGET_CAP = 4;
export const SETTINGS_PATH = "/settings?section=modules&module=news";

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const safeUrl = (url) => (/^https?:\/\//i.test(String(url ?? "")) ? String(url) : "#");

/* ------------------------------------------------------------- Story ordering */

export function featureEligible(headline) {
  return Boolean(headline.imageUrl) && (headline.summary ?? "").length > 0;
}

// Round-robin over the source groups so one source cannot own the top of the page.
export function interleaveGroups(groups) {
  const out = [];
  const deepest = groups.reduce((max, group) => Math.max(max, group.headlines.length), 0);
  for (let i = 0; i < deepest; i += 1) {
    for (const group of groups) {
      if (group.headlines[i]) out.push(group.headlines[i]);
    }
  }
  return out;
}

// A topic chip carries a key ("us") while a story carries labels ("U.S."), so a filter
// matches either one, ignoring case.
export function matchesTopic(headline, filter, labelFor = (key) => key) {
  if (filter === null || filter === undefined) return true;
  const wanted = new Set([filter, labelFor(filter)].map((value) => String(value).toLowerCase()));
  const candidates = [...(headline.topicLabels ?? []), headline.topicKey, headline.topicLabel];
  return candidates.some((value) => value != null && wanted.has(String(value).toLowerCase()));
}

export function composeMosaic(pool) {
  const feature = pool.find(featureEligible) ?? null;
  const rest = pool.filter((headline) => headline !== feature);
  const majorIds = new Set(
    rest
      .filter((headline) => headline.imageUrl)
      .slice(0, MAJORS_CAP)
      .map((headline) => headline.id)
  );
  const flow = rest.filter((headline) => !majorIds.has(headline.id));
  const standards = flow.slice(0, STANDARDS_CAP);
  const mosaicIds = new Set([...majorIds, ...standards.map((headline) => headline.id)]);
  return {
    feature,
    mosaic: rest.filter((headline) => mosaicIds.has(headline.id)),
    majorIds,
    briefs: flow.slice(STANDARDS_CAP, STANDARDS_CAP + BRIEFS_CAP)
  };
}

// Drops dismissed stories everywhere and tops the carousel back up from the ranked list.
export function withoutStories(data, dismissed) {
  if (dismissed.size === 0) return data;
  const keep = (headline) => !dismissed.has(headline.id);
  const topStories = data.topStories.filter(keep);
  const rankedStories = data.rankedStories?.filter(keep);
  if (topStories.length < CAROUSEL_CAP && rankedStories) {
    const present = new Set(topStories.map((headline) => headline.id));
    for (const candidate of rankedStories) {
      if (topStories.length >= CAROUSEL_CAP) break;
      if (present.has(candidate.id)) continue;
      topStories.push(candidate);
      present.add(candidate.id);
    }
  }
  return {
    ...data,
    topStories,
    rankedStories,
    sourceGroups: data.sourceGroups
      .map((group) => ({ ...group, headlines: group.headlines.filter(keep) }))
      .filter((group) => group.headlines.length > 0)
  };
}

export function kicker(headline) {
  const topics = headline.topicLabels?.length
    ? headline.topicLabels
    : headline.topicLabel
      ? [headline.topicLabel]
      : [];
  return topics.length > 0
    ? `${headline.sourceLabel} · ${topics.join(" · ")}`
    : headline.sourceLabel;
}

/* ----------------------------------------------------------------- Pieces */

const svg = (inner, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  left: svg('<path d="m15 18-6-6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  more: svg(
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    15
  ),
  up: svg(
    '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
    13
  ),
  down: svg(
    '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
    13
  ),
  paper: svg(
    '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/>',
    28
  )
};

// External links carry data-ext so the screen can hand them to the host to open.
const extLink = (headline, className, inner, extra = "") =>
  `<a class="${className}" href="${esc(safeUrl(headline.url))}" data-ext="1" rel="noreferrer"${extra}>${inner}</a>`;

const buttonLink = (headline, inner, extra = "") =>
  extLink(headline, "jds-btn jds-btn--link", inner, extra);

// Pictures load through the host, so every img starts empty and the screen fills it in.
const imgTag = (headline, className) =>
  `<img class="${className}" data-img="${esc(headline.imageUrl)}" alt="">`;

export function emptyState({ icon, title, sub, actions }) {
  return (
    `<div class="jds-empty">` +
    (icon ? `<span class="jds-empty__mark">${icon}</span>` : "") +
    `<div class="jds-empty__title">${title}</div>` +
    (sub ? `<div class="jds-empty__sub">${esc(sub)}</div>` : "") +
    (actions ? `<div class="jds-empty__actions">${actions}</div>` : "") +
    `</div>`
  );
}

export function note(text, { variant = "practical", role = "status", id = "" } = {}) {
  return `<div class="jds-note jds-note--${variant}"><span role="${role}"${id}>${esc(text)}</span></div>`;
}

/* --------------------------------------------------------------- Masthead */

export function masthead({ activeTopics, filter, labelFor }) {
  const chips = (key, label, active) =>
    `<button type="button" class="jds-btn jds-btn--chip jds-btn--sm${active ? " jds-btn--active" : ""}" data-filter="${esc(key ?? "")}" aria-pressed="${active}">${esc(label)}</button>`;
  const body =
    activeTopics.length > 0
      ? `<nav class="nw-mast__nav" aria-label="Filter by topic">${chips(null, "All", filter === null)}${activeTopics
          .map((key) => chips(key, labelFor(key), filter === key))
          .join("")}</nav>`
      : `<p class="nw-mast__plate">Front pages from your sources</p>`;
  return (
    `<header class="nw-mast"><div class="jds-section-head">` +
    `<h1 class="jds-section-head__title">Your front page</h1></div>${body}</header>`
  );
}

/* --------------------------------------------------------------- Carousel */

export function carousel(headlines, active, feedbackHtml) {
  const slides = headlines.slice(0, CAROUSEL_CAP);
  const count = slides.length;
  if (count === 0) return "";
  const current = Math.min(active, count - 1);
  const slide = (headline, i) => {
    const on = i === current;
    const tab = on ? "" : ' tabindex="-1"';
    return (
      `<article class="nw-carousel__slide${on ? " nw-carousel__slide--active" : ""}" role="group" aria-roledescription="slide" aria-hidden="${!on}">` +
      `<div class="nw-hero nw-fbhost">` +
      (headline.imageUrl
        ? imgTag(headline, "nw-hero__photo")
        : `<div class="nw-hero__photo nw-hero__photo--empty" aria-hidden="true"></div>`) +
      `<div class="nw-hero__body"><p class="nw-hero__kicker"><span class="nw-hero__kicker-desk">Top story</span>` +
      `<span class="nw-hero__kicker-src">${esc(kicker(headline))}</span></p>` +
      `<h2 class="nw-hero__headline">${extLink(headline, "nw-hero__link", esc(headline.title), tab)}</h2>` +
      (headline.summary ? `<p class="nw-hero__dek">${esc(headline.summary)}</p>` : "") +
      buttonLink(headline, `Continue reading<span aria-hidden="true"> →</span>`, tab) +
      `</div>${on ? feedbackHtml(headline) : ""}</div></article>`
    );
  };
  const controls =
    count > 1
      ? `<div class="nw-carousel__ctl">` +
        `<button type="button" class="jds-iconbtn" aria-label="Previous story" data-slide="prev">${ICONS.left}</button>` +
        `<div class="nw-carousel__dots">${slides
          .map(
            (_, i) =>
              `<button type="button" class="nw-carousel__dot" aria-label="Story ${i + 1} of ${count}"${i === current ? ' aria-current="true"' : ""} data-slide="${i}"></button>`
          )
          .join("")}</div>` +
        `<button type="button" class="jds-iconbtn" aria-label="Next story" data-slide="next">${ICONS.right}</button></div>`
      : "";
  return (
    `<section class="nw-carousel" aria-label="Top stories" aria-roledescription="carousel">` +
    `<div class="nw-carousel__stage">${slides.map(slide).join("")}</div>${controls}</section>`
  );
}

/* ----------------------------------------------------------------- Mosaic */

export function mosaic(plan, feedbackHtml) {
  if (!plan.feature && plan.mosaic.length === 0) return "";
  const feature = plan.feature
    ? `<article class="nw-feature nw-fbhost">` +
      (plan.feature.imageUrl ? imgTag(plan.feature, "nw-feature__img") : "") +
      `<div class="nw-feature__body"><p class="nw-feature__kicker">${esc(kicker(plan.feature))}</p>` +
      `<h3 class="nw-feature__title">${esc(plan.feature.title)}</h3>` +
      (plan.feature.summary
        ? `<p class="nw-feature__blurb">${esc(plan.feature.summary)}</p>`
        : "") +
      buttonLink(plan.feature, "Continue reading →") +
      `</div>${feedbackHtml(plan.feature)}</article>`
    : "";
  const card = (headline) => {
    const major = plan.majorIds.has(headline.id);
    const classes = ["nw-mosaic__art", "nw-fbhost"];
    if (major) classes.push("nw-mosaic__art--major");
    if (!major && !headline.imageUrl) classes.push("nw-mosaic__art--textonly");
    return (
      `<article class="${classes.join(" ")}">` +
      (headline.imageUrl ? imgTag(headline, "nw-mosaic__img") : "") +
      `<p class="nw-mosaic__artkicker">${esc(kicker(headline))}</p>` +
      `<h4 class="nw-mosaic__title">${esc(headline.title)}</h4>` +
      (headline.summary ? `<p class="nw-mosaic__blurb">${esc(headline.summary)}</p>` : "") +
      buttonLink(headline, "Continue reading →") +
      `${feedbackHtml(headline)}</article>`
    );
  };
  return (
    `<section class="nw-band" aria-label="Today's stories">${feature}` +
    `<div class="nw-mosaic">${plan.mosaic.map(card).join("")}</div></section>`
  );
}

export function briefs(list, feedbackHtml) {
  if (list.length === 0) return "";
  return (
    `<div class="nw-briefs"><p class="nw-briefs__label">In brief</p><ul class="nw-briefs__list">` +
    list
      .map(
        (headline) =>
          `<li class="nw-briefs__item nw-fbhost">` +
          extLink(
            headline,
            "nw-briefs__link",
            `<span class="nw-briefs__tag">${esc(headline.sourceLabel)}</span>${esc(headline.title)}`
          ) +
          `${feedbackHtml(headline)}</li>`
      )
      .join("") +
    `</ul></div>`
  );
}

export function sourceRail(groups, feedbackHtml) {
  if (groups.length === 0) return "";
  return (
    `<section aria-label="From your sources"><div class="nw-rail__head"><p class="nw-kicker">From your sources</p>` +
    `<a class="jds-btn jds-btn--link jds-btn--sm" href="${SETTINGS_PATH}" data-nav="${SETTINGS_PATH}">Manage</a></div>` +
    groups
      .map(
        (group) =>
          `<div class="nw-rail__group"><a class="nw-rail__src" href="${esc(safeUrl(group.homepageUrl))}" data-ext="1" rel="noreferrer">${esc(group.sourceLabel)}</a>` +
          `<ul class="nw-rail__list">${group.headlines
            .slice(0, RAIL_ITEMS_CAP)
            .map(
              (headline) =>
                `<li class="nw-rail__item nw-fbhost">${extLink(headline, "nw-rail__link", esc(headline.title))}${feedbackHtml(headline)}</li>`
            )
            .join("")}</ul></div>`
      )
      .join("") +
    `</section>`
  );
}

/* ------------------------------------------------------------ Page states */

export function loadingLine() {
  return `<p class="nw-lede" role="status">Loading news…</p>`;
}

export function failureLine(stale) {
  const text = stale
    ? "Could not refresh news. Showing the last loaded front page."
    : "News is unavailable right now.";
  return `<p class="nw-lede" role="status">${text} <button type="button" class="jds-btn jds-btn--link" data-retry="1">Try again</button></p>`;
}

export const degradedLine = () =>
  `<p class="nw-degraded" role="status">Some sources didn’t respond just now — this front page may be incomplete.</p>`;

export function emptyPage({ data, filter, labelFor }) {
  if (filter !== null) {
    return emptyState({
      title: `<h2>No stories for ${esc(labelFor(filter))}</h2>`,
      sub: data.degraded
        ? "No matching stories in the loaded front page. Some sources are unavailable."
        : "No matching stories in the loaded front page.",
      actions: `<button type="button" class="jds-btn jds-btn--secondary" data-filter="">Show all stories</button>`
    });
  }
  const noSources = data.enabledSources.length === 0;
  return emptyState({
    icon: ICONS.paper,
    title: `<h2>${noSources ? "Choose your sources" : data.degraded ? "News is unavailable" : "Nothing on the wire"}</h2>`,
    sub: noSources
      ? "Pick the publications and topics you care about. This page becomes their combined front page."
      : data.degraded
        ? "Your sources could not be updated. Try again shortly."
        : "Your sources didn't return any stories just now. Check back shortly, or adjust your sources and topics.",
    actions: `<a class="jds-btn jds-btn--secondary" href="${SETTINGS_PATH}" data-nav="${SETTINGS_PATH}">Choose sources</a>`
  });
}

/* Everything the page shows for one loaded overview. */
export function pageHtml({ data, filter, labelFor, slide, feedbackHtml, receipt, failed }) {
  const matches = (headline) => matchesTopic(headline, filter, labelFor);
  const topStories = data.topStories.filter(matches);
  const groups = data.sourceGroups
    .map((group) => ({ ...group, headlines: group.headlines.filter(matches) }))
    .filter((group) => group.headlines.length > 0);
  const carouselIds = new Set(topStories.slice(0, CAROUSEL_CAP).map((h) => h.id));
  const ranked = (data.rankedStories ?? interleaveGroups(groups)).filter(matches);
  const plan = composeMosaic(ranked.filter((h) => !carouselIds.has(h.id)));
  const hasStories = topStories.length > 0 || groups.length > 0 || ranked.length > 0;
  return (
    masthead({ activeTopics: data.activeTopics, filter, labelFor }) +
    receipt +
    (failed ? failureLine(true) : "") +
    (hasStories
      ? carousel(topStories, slide, feedbackHtml) +
        `<div class="nw-grid"><div class="nw-grid__main">${mosaic(plan, feedbackHtml)}</div>` +
        `<aside class="nw-grid__rail">${sourceRail(groups, feedbackHtml)}${briefs(plan.briefs, feedbackHtml)}</aside></div>` +
        (data.degraded ? degradedLine() : "")
      : emptyPage({ data, filter, labelFor }))
  );
}

/* ------------------------------------------------------------ Today widget */

// Marks a favicon tile so a picture that fails to load falls back to the publisher name.
const sourceTag = (headline) =>
  headline.faviconUrl
    ? `<span class="nw-twlist__favicon-tile"><img class="nw-twlist__favicon" data-img="${esc(headline.faviconUrl)}" data-fallback="${esc(headline.sourceLabel)}" alt="${esc(headline.sourceLabel)}" title="${esc(headline.sourceLabel)}" width="14" height="14"></span>`
    : esc(headline.sourceLabel);

export function widgetHtml(data, feedbackHtml, leadArt) {
  const stories = data.topStories.slice(0, WIDGET_CAP);
  const lead = stories[0];
  if (!lead) return "";
  const rest = stories.slice(1);
  const leadFrame = lead.imageUrl
    ? `<img class="nw-twlead__photo" data-img="${esc(lead.imageUrl)}" data-art="1" alt="">`
    : leadArt({
        topic: lead.topicLabel ?? lead.topicKey ?? "",
        headline: lead.title,
        publisher: lead.sourceLabel
      });
  const list =
    rest.length > 0
      ? `<div class="desk-listcol"><ul class="nw-twlist">${rest
          .map(
            (headline) =>
              `<li class="nw-twlist__item"><div class="nw-twlist__row nw-fbhost">` +
              extLink(
                headline,
                "nw-twlist__link",
                `<span class="nw-twlist__tag">${headline.topicLabel ? esc(headline.topicLabel) : sourceTag(headline)}</span>` +
                  `<span class="nw-twlist__title">${esc(headline.title)}</span>` +
                  (headline.summary
                    ? `<span class="nw-twlist__dek">${esc(headline.summary)}</span>`
                    : "")
              ) +
              `${feedbackHtml(headline)}</div></li>`
          )
          .join("")}</ul>` +
        `<div class="jds-note jds-note--pull nw-twnote"><span class="jds-eyebrow jds-eyebrow--strong jds-eyebrow--accent nw-twnote__eyebrow">Your news, in context</span>` +
        `<p class="nw-twnote__text">A few stories worth knowing, with the reporting a click away.</p></div></div>`
      : "";
  return (
    `<section class="jds-brief jds-brief--news" aria-label="News desk">` +
    `<div class="jds-section-head jds-section-head--rule desk-head"><span class="jds-section-head__number">02</span>` +
    `<h2 class="jds-section-head__title desk-title">The wider world</h2><span class="jds-section-head__meta">News desk</span></div>` +
    `<div class="desk-cols"><div class="desk-leadcol"><div class="nw-fbhost">` +
    extLink(
      lead,
      "nw-twlead",
      `<span class="nw-twlead__frame">${leadFrame}</span>` +
        `<span class="nw-twlead__tag"><span class="nw-twlead__tag-evening">${esc(lead.sourceLabel)}</span>` +
        `<span class="nw-twlead__tag-morning">${esc(lead.topicLabel ?? lead.sourceLabel)} / THE LEAD STORY</span></span>` +
        `<span class="nw-twlead__title">${esc(lead.title)}</span>` +
        (lead.summary ? `<span class="nw-twlead__dek">${esc(lead.summary)}</span>` : "") +
        `<span class="nw-twlead__link">Read the story ↗</span>`
    ) +
    `${feedbackHtml(lead)}</div></div>${list}</div></section>`
  );
}
