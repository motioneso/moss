import { SOCCER_COMPETITIONS } from "./competitions.mjs";
import { clear, h, svg } from "./dom.mjs";
import { formatTime } from "./locale.mjs";
import { crest, liveDot } from "./parts.mjs";
import { autoAdvance, rotationControl } from "./rotation.mjs";
import { teamBarColor } from "./team-colors.mjs";

const GAMEDAY_HERO_LEAD_MS = 15 * 60 * 1000;
const GAMEDAY_ADVANCE_MS = 9000;
const LEAD_MIN_PHOTO_WIDTH = 800;

const stillInWindow = (game) =>
  game.state === "live" ||
  (game.state === "pre" && new Date(game.startsAt).getTime() - Date.now() <= GAMEDAY_HERO_LEAD_MS);

/** A wide photo leads the carousel when one exists. The rest of the order is untouched. */
export function leadWidePhotoFirst(headlines) {
  const index = headlines.findIndex(
    (headline) => (headline.imageWidth ?? 0) >= LEAD_MIN_PHOTO_WIDTH
  );
  if (index <= 0) return headlines;
  return [headlines[index], ...headlines.filter((_, position) => position !== index)];
}

/** Games outside the window (more than 15 minutes before kickoff, or over) leave the hero. */
export function demoteEarlyGameday(data) {
  const hero = data.hero;
  if (hero.mode !== "gameday") return hero;
  const games = hero.games.filter((entry) => stillInWindow(entry.game));
  if (games.length > 0) return { mode: "gameday", games };
  return { mode: "story", headline: leadWidePhotoFirst(data.topStories)[0] ?? null };
}

export function hasLiveGame(data) {
  if (!data) return false;
  if (data.hero.mode === "gameday" && data.hero.games.some((e) => e.game.state === "live"))
    return true;
  if (data.followed.some((card) => card.status === "live")) return true;
  return data.scoreboard.some((group) => group.games.some((game) => game.state === "live"));
}

/** A story about this very game (preview, recap, highlights) that can sit under the score bar. */
export function findFeaturedStory(game, overview) {
  const keys = new Set([game.home.teamKey, game.away.teamKey]);
  const names = [game.home.shortName, game.away.shortName].map((n) => n.toLowerCase());
  const aboutThisGame = (headline) => {
    if (headline.competitionKey !== game.competitionKey || headline.teamKeys.length > 6)
      return false;
    const tagged = headline.teamKeys.filter((key) => keys.has(key)).length;
    const named = names.filter((name) => headline.title.toLowerCase().includes(name)).length;
    return Math.max(tagged, named) >= 2;
  };
  const candidates = [
    ...overview.topStories,
    ...overview.leagueNews.flatMap((g) => g.headlines)
  ].filter(aboutThisGame);
  const wide = (headline) => (headline.imageWidth ?? 0) >= LEAD_MIN_PHOTO_WIDTH;
  return (
    candidates.find((x) => wide(x) && x.summary) ??
    candidates.find(wide) ??
    candidates.find((x) => x.imageUrl && x.summary) ??
    candidates.find((x) => x.imageUrl) ??
    candidates[0] ??
    null
  );
}

const eventTitle = (game) => {
  const lead = game.state === "live" ? "Live" : game.state === "final" ? "Final" : "Today";
  const matchup = SOCCER_COMPETITIONS.has(game.competitionKey)
    ? `${game.home.shortName} v ${game.away.shortName}`
    : `${game.away.shortName} at ${game.home.shortName}`;
  return `${lead}: ${matchup}`;
};

/** The masthead line that names the game on show. Empty when no game is on. */
export function pageHeader(game) {
  if (!game) return null;
  return h("header", { class: "sp-mast" }, h("p", { class: "sp-mast__event" }, eventTitle(game)));
}

function scoreBarSide(side, competitionKey, edge) {
  const color = teamBarColor(competitionKey, side.teamKey);
  const el = h("div", {
    role: "group",
    "aria-label": side.name,
    class: `sp-scorebar__side${edge === "r" ? " sp-scorebar__side--r" : ""}`,
    style: color ? { background: color.bg, color: color.fg } : undefined
  });
  if (side.crestUrl) {
    const mark = h("img", {
      class: "sp-scorebar__watermark",
      src: side.crestUrl,
      alt: "",
      "aria-hidden": "true",
      loading: "lazy"
    });
    mark.addEventListener("error", () => mark.remove());
    el.append(mark);
  }
  el.append(
    h("span", { class: "sp-scorebar__score" }, String(side.score ?? "")),
    h(
      "span",
      { class: "sp-scorebar__team", title: side.name },
      h("span", { class: "sp-scorebar__team-full" }, side.name),
      h("span", { class: "sp-scorebar__team-abbr", "aria-hidden": "true" }, side.shortName)
    ),
    crest({ name: side.name, shortName: side.shortName, crestUrl: side.crestUrl, size: "md" })
  );
  return el;
}

function featuredStoryBand(story) {
  const photo = story.imageUrl
    ? h("img", { class: "sp-scorebar__photo", src: story.imageUrl, alt: "", loading: "lazy" })
    : null;
  photo?.addEventListener("error", () => photo.remove());
  return h(
    "div",
    { class: "sp-fbhost" },
    h(
      "a",
      { class: "sp-scorebar__story", href: story.url, target: "_blank", rel: "noreferrer" },
      photo,
      h(
        "span",
        { class: "sp-scorebar__storycopy" },
        h("span", { class: "sp-scorebar__storytitle" }, story.title),
        h("span", { class: "sp-scorebar__storydek" }, story.publisherLabel),
        story.summary ? h("span", { class: "sp-scorebar__storydek" }, story.summary) : null
      )
    )
  );
}

function featuredGameBar(entry, story, ctx) {
  const { game, competitionLabel } = entry;
  const soccer = SOCCER_COMPETITIONS.has(game.competitionKey);
  const left = soccer ? game.home : game.away;
  const right = soccer ? game.away : game.home;
  const clock = game.state === "pre" ? formatTime(game.startsAt, ctx.locale) : game.statusDetail;
  const live = game.state === "live";
  return h(
    "section",
    {
      class: "sp-scorebar",
      "aria-label": "Featured game",
      "aria-live": live ? "polite" : null,
      "aria-atomic": live ? "true" : null
    },
    h(
      "div",
      { class: "sp-scorebar__bar" },
      scoreBarSide(left, game.competitionKey, "l"),
      h(
        "div",
        { class: "sp-scorebar__mid" },
        live ? liveDot() : null,
        h("span", { class: "sp-scorebar__clock" }, clock)
      ),
      scoreBarSide(right, game.competitionKey, "r")
    ),
    h(
      "div",
      { class: "sp-scorebar__foot" },
      h("span", { class: "sp-scorebar__comp" }, competitionLabel)
    ),
    story ? featuredStoryBand(story) : null
  );
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

/**
 * The gameday hero. One score bar for a single game, a tabbed carousel when several are on.
 * The slide on show is tracked by game id so a refresh that reorders or drops games never swaps what is being read.
 * Switching slides updates the existing elements in place, so hover, focus and the timer survive.
 */
export function gamedayHero({ games, activeId, onActive, overview, ctx }) {
  const count = games.length;
  let activeIndex = Math.max(
    games.findIndex((e) => e.game.id === activeId),
    0
  );
  if (count === 1)
    return featuredGameBar(games[0], findFeaturedStory(games[0].game, overview), ctx);

  const root = h("section", { "aria-label": "Today's games", "aria-roledescription": "carousel" });
  const ctl = h("div", { class: "sp-gameday__ctl" });
  const select = (index) => {
    activeIndex = (index + count) % count;
    paint();
    onActive?.(games[activeIndex].game);
  };
  const rotation = autoAdvance({
    root,
    count: () => count,
    advance: () => select(activeIndex + 1),
    intervalMs: GAMEDAY_ADVANCE_MS,
    onChange: () => paintControls()
  });

  const slides = games.map((entry) =>
    h(
      "div",
      {
        class: "sp-gameday__slide",
        id: `sp-gameday-${entry.game.id}`,
        role: "tabpanel",
        "aria-labelledby": `sp-gameday-tab-${entry.game.id}`
      },
      featuredGameBar(entry, findFeaturedStory(entry.game, overview), ctx)
    )
  );
  const stage = h("div", { class: "sp-gameday__stage" }, slides);

  const tabs = games.map((entry, index) => {
    const { game } = entry;
    const soccer = SOCCER_COMPETITIONS.has(game.competitionKey);
    const [l, r] = soccer ? [game.home, game.away] : [game.away, game.home];
    return h(
      "button",
      {
        type: "button",
        role: "tab",
        id: `sp-gameday-tab-${game.id}`,
        "aria-controls": `sp-gameday-${game.id}`,
        class: "sp-gameday__tab",
        onClick: () => select(index),
        onKeydown: (event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            select(index + (event.key === "ArrowRight" ? 1 : -1));
            tabs[activeIndex].focus();
          }
        }
      },
      game.state === "live" ? liveDot() : null,
      h("span", {}, `${l.shortName} ${soccer ? "v" : "at"} ${r.shortName}`),
      game.state !== "pre"
        ? h("span", { class: "sp-gameday__tabscore" }, `${l.score ?? 0}\u2013${r.score ?? 0}`)
        : null
    );
  });

  function paint() {
    slides.forEach((slide, i) => {
      const on = i === activeIndex;
      slide.setAttribute("data-active", on ? "true" : "false");
      if (on) {
        slide.removeAttribute("aria-hidden");
        slide.inert = false;
      } else {
        slide.setAttribute("aria-hidden", "true");
        slide.inert = true;
      }
    });
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", i === activeIndex ? "true" : "false");
      if (i === activeIndex) tab.removeAttribute("tabindex");
      else tab.setAttribute("tabindex", "-1");
    });
  }

  function paintControls() {
    clear(ctl).append(
      ...[rotationControl(rotation)].flat().filter(Boolean),
      h("div", { class: "sp-gameday__tabs", role: "tablist", "aria-label": "Today's games" }, tabs),
      h(
        "button",
        {
          type: "button",
          class: "jds-iconbtn jds-iconbtn--sm",
          "aria-label": "Previous game",
          onClick: () => select(activeIndex - 1)
        },
        chevron("M15 18l-6-6 6-6")
      ),
      h(
        "button",
        {
          type: "button",
          class: "jds-iconbtn jds-iconbtn--sm",
          "aria-label": "Next game",
          onClick: () => select(activeIndex + 1)
        },
        chevron("M9 18l6-6-6-6")
      )
    );
  }

  root.append(stage, ctl);
  paint();
  paintControls();
  root.stop = () => rotation.stop();
  root.activeGame = () => games[activeIndex].game;
  return root;
}
