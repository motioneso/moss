/* global window */
import { TOURNAMENT_COMPETITIONS } from "./competitions.mjs";
import { clear, h, svg } from "./dom.mjs";
import { formatDate, formatTime, localDay } from "./locale.mjs";
import { crest, formPips, liveDot } from "./parts.mjs";
import { teamBarColor } from "./team-colors.mjs";

export const SETTINGS_PATH = "/settings?section=modules&module=sports";

const resultWord = (label) => (label === "W" ? "won" : label === "L" ? "lost" : "drew");

/** A standing line is hidden when it is nonsense, belongs to a knockout bracket, or is last season's. */
function standingIsSane(card) {
  if (!card.standing) return false;
  if (TOURNAMENT_COMPETITIONS.has(card.competitionKey)) return false;
  if (/·\s*(0 pts|0-0)$/.test(card.standing)) return false;
  return !card.standing.startsWith("#0") && !/·\s*-\d/.test(card.standing);
}

const IN_SEASON_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

function inSeason(card, now) {
  if (card.status === "live" || card.status === "today") return true;
  const last = card.lastMatchAt ? new Date(card.lastMatchAt).getTime() : null;
  if (last !== null && now - last <= IN_SEASON_WINDOW_MS) return true;
  const next = card.nextMatch ? new Date(card.nextMatch.startsAt).getTime() : null;
  return next !== null && next - now <= IN_SEASON_WINDOW_MS;
}

const tickerPriority = (card, now) => (card.status === "live" ? 0 : inSeason(card, now) ? 1 : 2);
const newsRecency = (card) =>
  card.stories[0] ? new Date(card.stories[0].publishedAt).getTime() : Number.NEGATIVE_INFINITY;

/** Live first, then teams whose season is in motion, then the rest. Fresher news wins within a tier. */
export function orderFollowedCards(cards, now) {
  return [...cards].sort(
    (a, b) => tickerPriority(a, now) - tickerPriority(b, now) || newsRecency(b) - newsRecency(a)
  );
}

function daysUntilLocal(startsAt, locale, now) {
  const keyToUTC = (key) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round(
    (keyToUTC(localDay(startsAt, locale)) - keyToUTC(localDay(now, locale))) / 86_400_000
  );
}

export function nextMatchParts(next, locale, now = new Date()) {
  const at = next.startsAt;
  const time = formatTime(at, locale);
  const days = daysUntilLocal(at, locale, now);
  const date =
    days < 7
      ? formatDate(at, locale, { weekday: "short" })
      : formatDate(at, locale, { month: "short", day: "numeric" });
  return {
    opponent: `${next.homeAway === "home" ? "vs" : "at"} ${next.opponentName}`,
    when: `${date} · ${time}`
  };
}

/** True when the fixture starts on the viewer's local calendar day. */
export function nextMatchIsToday(next, locale, now = new Date()) {
  return localDay(next.startsAt, locale) === localDay(now, locale);
}

const chevron = (d) =>
  svg(
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
    d
  );

const settingsLink = (ctx, label) =>
  h(
    "a",
    {
      class: "jds-btn jds-btn--link",
      href: SETTINGS_PATH,
      onClick: (e) => {
        e.preventDefault();
        ctx.navigate(SETTINGS_PATH);
      }
    },
    label
  );

/** The Followed strip. Scrolls sideways, drags with a mouse, and shows arrows only when there is more to reach. */
export function sportsTicker(followed, ctx) {
  if (followed.length === 0) return null;
  const ordered = orderFollowedCards(followed, Date.now());
  const scroll = h(
    "div",
    { class: "sp-ticker__scroll", tabindex: "0", role: "region", "aria-label": "Followed teams" },
    ordered.map((card) => tickerTeam(card, ctx))
  );
  const left = h(
    "button",
    {
      type: "button",
      class: "jds-iconbtn jds-iconbtn--sm",
      "aria-label": "Scroll left",
      onClick: () => nudge(-1)
    },
    chevron("M15 18l-6-6 6-6")
  );
  const right = h(
    "button",
    {
      type: "button",
      class: "jds-iconbtn jds-iconbtn--sm",
      "aria-label": "Scroll right",
      onClick: () => nudge(1)
    },
    chevron("M9 18l6-6-6-6")
  );

  function edges() {
    left.hidden = scroll.scrollLeft <= 1;
    right.hidden = scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 1;
  }
  function nudge(direction) {
    scroll.scrollBy({ left: direction * Math.round(scroll.clientWidth * 0.8), behavior: "smooth" });
  }

  let drag = null;
  scroll.addEventListener("scroll", edges);
  scroll.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return;
    drag = { startX: event.clientX, startLeft: scroll.scrollLeft, moved: false };
  });
  scroll.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    scroll.setPointerCapture(event.pointerId);
    scroll.scrollLeft = drag.startLeft - dx;
  });
  const end = (event) => {
    if (scroll.hasPointerCapture(event.pointerId)) scroll.releasePointerCapture(event.pointerId);
    window.setTimeout(() => (drag = null), 0);
  };
  scroll.addEventListener("pointerup", end);
  scroll.addEventListener("pointerleave", end);
  // A drag that ends over a story link must not also open it.
  scroll.addEventListener(
    "click",
    (event) => {
      if (drag?.moved) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  const onResize = () => {
    if (!scroll.isConnected) {
      window.removeEventListener("resize", onResize);
      return;
    }
    edges();
  };
  window.addEventListener("resize", onResize);
  window.setTimeout(edges, 0);
  return h(
    "section",
    { class: "sp-ticker", "aria-label": "Followed" },
    h(
      "div",
      { class: "sp-ticker__head" },
      h(
        "h2",
        { class: "jds-eyebrow jds-eyebrow--strong jds-eyebrow--accent sp-ticker__label" },
        "Followed"
      ),
      settingsLink(ctx, "Manage")
    ),
    h("div", { class: "sp-ticker__row" }, left, scroll, right)
  );
}

const storyKicker = (story, fallback) => {
  const label = story.publisherLabel || fallback;
  return label ? h("span", { class: "sp-tk__kicker" }, label) : null;
};

function teamAccent(card) {
  const color = teamBarColor(card.competitionKey, card.teamKey);
  return color ? { "--team-accent": color.bg } : undefined;
}

const storyLink = (story) =>
  h(
    "a",
    { class: "sp-tk__storylink", href: story.url, target: "_blank", rel: "noreferrer" },
    story.title,
    story.publisherDomain === "espn.com" || !story.publisherLabel
      ? null
      : ` · ${story.publisherLabel}`
  );

function leadMedia(lead) {
  if (!lead?.imageUrl) return null;
  const img = h("img", { class: "sp-tk__media", src: lead.imageUrl, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.remove());
  return img;
}

function resultBlock(card) {
  const rm = card.resultMatch;
  const own = { name: card.name, crestUrl: card.crestUrl, scorers: rm.ownScorers };
  const opp = { name: rm.opponentName, crestUrl: rm.opponentCrestUrl, scorers: rm.opponentScorers };
  const home = rm.homeAway === "home" ? own : opp;
  const away = rm.homeAway === "away" ? own : opp;
  const hasScorers = Boolean(home.scorers || away.scorers);
  const scorers = (side, cls) =>
    hasScorers
      ? h(
          "ul",
          { class: `sp-tk__scorers sp-tk__scorers--${cls}` },
          (side.scorers ?? []).map((s) => h("li", {}, h("span", {}, s)))
        )
      : null;
  return h(
    "div",
    { class: "sp-tk__result" },
    scorers(home, "home"),
    crest({ name: home.name, crestUrl: home.crestUrl, size: "sm" }),
    h("span", { class: "sp-tk__score" }, `${rm.homeScore}–${rm.awayScore}`),
    crest({ name: away.name, crestUrl: away.crestUrl, size: "sm" }),
    scorers(away, "away"),
    h("span", { class: "sp-sronly" }, `${home.name} vs ${away.name}, ${resultWord(rm.resultLabel)}`)
  );
}

function nextGameLine(next, ctx) {
  const { opponent, when } = nextMatchParts(next, ctx.locale);
  const isToday = nextMatchIsToday(next, ctx.locale);
  return h(
    "div",
    { class: "sp-tk__next" },
    h("span", { class: "sp-tk__nextlabel" }, "Next game"),
    h("strong", { class: "sp-tk__nextmain" }, opponent),
    h(
      "span",
      { class: "sp-tk__nextwhen" },
      isToday ? `Today · ${formatTime(next.startsAt, ctx.locale)}` : when
    )
  );
}

const liveTag = () => h("span", { class: "sp-tk__live" }, liveDot(), "Live");

/** A followed-team card. Used by the Followed strip and the Today tonight screen. */
export function tickerTeam(card, ctx) {
  const showNews =
    card.status === "news" ||
    card.status === "live" ||
    (card.status === "today" && card.todayGameState !== "final");
  const stories = card.stories;
  const lead = stories[0] ?? null;
  const secondary = showNews ? stories.slice(1, 3) : stories.slice(0, 2);
  const col = h("div", { class: "sp-tk__col" });
  if (showNews) {
    col.append(
      lead
        ? h(
            "div",
            { class: "sp-tk__lead sp-fbhost" },
            storyKicker(lead, card.competitionLabel),
            h(
              "a",
              { class: "sp-tk__newstx", href: lead.url, target: "_blank", rel: "noreferrer" },
              lead.title
            )
          )
        : h("span", { class: "sp-tk__newstx sp-tk__newstx--empty" }, "No recent news")
    );
  } else if (card.resultMatch) {
    col.append(resultBlock(card));
  }
  if (secondary.length > 0)
    col.append(
      h(
        "ul",
        { class: "sp-tk__stories" },
        secondary.map((s) => h("li", { class: "sp-fbhost" }, storyLink(s)))
      )
    );

  return h(
    "article",
    { class: "sp-tk", style: teamAccent(card) },
    h(
      "header",
      { class: "sp-tk__head" },
      h(
        "span",
        { class: "sp-tk__mark" },
        crest({ name: card.name, crestUrl: card.crestUrl, size: "md" })
      ),
      h(
        "div",
        { class: "sp-tk__ident" },
        h(
          "div",
          { class: "sp-tk__hd" },
          h("span", { class: "sp-tk__name" }, card.name),
          card.status === "live" ? liveTag() : null
        ),
        standingIsSane(card) ? h("span", { class: "sp-tk__standing" }, card.standing) : null
      ),
      formPips(card.form, card.formDetail, ctx.locale)
    ),
    h("div", { class: "sp-tk__body" }, showNews ? leadMedia(lead) : null, col),
    card.status === "live"
      ? h(
          "div",
          { class: "sp-tk__next sp-tk__next--live" },
          h("span", { class: "sp-tk__nextlabel" }, liveDot(), "Live now"),
          h("strong", { class: "sp-tk__nextmain" }, card.primary),
          card.liveStatusText ? h("span", { class: "sp-tk__nextwhen" }, card.liveStatusText) : null
        )
      : card.nextMatch
        ? nextGameLine(card.nextMatch, ctx)
        : null
  );
}

/** A followed whole-league card with its lead story and recent results. */
export function tickerLeague(card) {
  const stories = card.stories;
  const lead = stories[0] ?? null;
  const secondary = stories.slice(1, 3);
  const col = h(
    "div",
    { class: "sp-tk__col" },
    lead
      ? h(
          "div",
          { class: "sp-tk__lead sp-fbhost" },
          storyKicker(lead, card.competitionLabel),
          h(
            "a",
            { class: "sp-tk__newstx", href: lead.url, target: "_blank", rel: "noreferrer" },
            lead.title
          )
        )
      : h("span", { class: "sp-tk__newstx sp-tk__newstx--empty" }, "No recent news"),
    secondary.length > 0
      ? h(
          "ul",
          { class: "sp-tk__stories" },
          secondary.map((s) => h("li", { class: "sp-fbhost" }, storyLink(s)))
        )
      : null
  );
  return h(
    "article",
    { class: "sp-tk sp-tk--league" },
    h(
      "header",
      { class: "sp-tk__head" },
      h(
        "span",
        { class: "sp-tk__mark" },
        crest({ name: card.competitionLabel, crestUrl: card.logoUrl, size: "md" })
      ),
      h(
        "div",
        { class: "sp-tk__ident" },
        h(
          "div",
          { class: "sp-tk__hd" },
          h("span", { class: "sp-tk__name" }, card.competitionLabel),
          card.status === "live" ? liveTag() : null
        ),
        h(
          "span",
          { class: "sp-tk__standing" },
          card.kind === "tournament" ? "Tournament" : "League"
        )
      )
    ),
    h("div", { class: "sp-tk__body" }, leadMedia(lead), col),
    card.results.length > 0
      ? h(
          "div",
          { class: "sp-tk__results" },
          h("span", { class: "sp-tk__scoreshead" }, "Recent results"),
          h(
            "ul",
            { class: "sp-tk__scores" },
            card.results.map((r) =>
              h(
                "li",
                { class: "sp-tk__scorerow" },
                h("span", { class: "sp-tk__scoreline" }, r.line),
                h(
                  "span",
                  {
                    class: `sp-tk__scorechip${r.state === "live" ? " sp-tk__scorechip--live" : ""}`
                  },
                  r.state === "live" ? [liveDot(), r.detail] : r.detail
                )
              )
            )
          )
        )
      : null
  );
}

export { clear };
