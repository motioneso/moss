/* global window, document */
import { button, clear, h } from "./dom.mjs";
import { crest, liveDot } from "./parts.mjs";
import { followedTeamIndex, isFollowed } from "./ranking.mjs";
import { hasLiveGame } from "./gameday.mjs";
import { orderFollowedCards, tickerLeague, tickerTeam } from "./ticker.mjs";
import {
  QUIET_NIGHT_LINE,
  SOCCER_COMPETITIONS,
  followingSummary,
  formatDate,
  formatTime,
  formatTimeZoneShort,
  hasGameStartedToday,
  orderGameSides,
  selectScoreRows,
  selectTonightRows
} from "./today-desk.mjs";

const LIVE_REFETCH_INTERVAL_MS = 60000;
const DATE_LINE = { weekday: "long", month: "long", day: "numeric" };

function scoreSide(side, mine) {
  return h(
    "div",
    { class: mine ? "sp-board__side sp-board__side--you" : "sp-board__side" },
    crest({ name: side.name, crestUrl: side.crestUrl, size: "sm" }),
    h("span", { class: "sp-board__team", title: side.name }, side.shortName),
    h("span", { class: "sp-board__score" }, side.score ?? "–")
  );
}

function scoreRow(row, followed) {
  const [first, second] = orderGameSides(row.game, SOCCER_COMPETITIONS.has(row.game.competitionKey));
  const key = row.game.competitionKey;
  return h(
    "li",
    { class: "sp-scores__row" },
    h("div", { class: "sp-scores__sides" }, scoreSide(first, isFollowed(followed, key, first.sourceTeamId)), scoreSide(second, isFollowed(followed, key, second.sourceTeamId))),
    h(
      "div",
      { class: "sp-scores__status" },
      row.game.state === "live" ? liveDot() : null,
      h("span", { class: "sp-scores__statusline", "aria-label": row.competitionLabel }, row.game.statusDetail),
      h("span", { class: "sp-scores__recap" }, row.game.recap ?? "")
    )
  );
}

function tonightRow(row, locale) {
  const { game } = row;
  const matchup = SOCCER_COMPETITIONS.has(game.competitionKey) ? `${game.home.shortName} vs. ${game.away.shortName}` : `${game.away.shortName} at ${game.home.shortName}`;
  const postponed = game.statusDetail != null && /postpon|ppd|cancel/i.test(game.statusDetail);
  const note = row.followed && row.followedSide ? (row.followedSide === "home" ? "Home" : "Away") : (game.recap ?? "");
  return h(
    "li",
    { class: "sp-tonight__row" },
    h("span", { class: "sp-tonight__kicker" }, `${row.followed ? "Following" : "Worth watching"} · ${row.competitionLabel}`),
    h("span", { class: "sp-tonight__matchup" }, matchup),
    h("span", { class: "sp-tonight__time" }, postponed ? "Postponed" : formatTime(game.startsAt, locale)),
    h("span", { class: "sp-tonight__note" }, note)
  );
}

function recapStories(data) {
  const fromCards = data.followed.flatMap((card) =>
    card.stories.map((story) => ({ url: story.url, imageUrl: story.imageUrl, competitionLabel: card.competitionLabel, publisherLabel: story.publisherLabel, title: story.title, summary: null }))
  );
  const all = [...data.topStories, ...fromCards];
  return all.filter((story, index) => all.findIndex((other) => other.url === story.url) === index);
}

function leadStory(lead) {
  const link = h("a", { class: "sp-lead", href: lead.url, target: "_blank", rel: "noreferrer" });
  if (lead.imageUrl) {
    const photo = h("img", { class: "sp-lead__photo", src: lead.imageUrl, alt: "", loading: "lazy" });
    photo.addEventListener("error", () => photo.remove());
    link.append(photo);
  }
  link.append(
    h("span", { class: "sp-lead__tag" }, `★ FOLLOWING / ${lead.competitionLabel}`),
    h("span", { class: "sp-lead__title" }, lead.title),
    lead.summary ? h("span", { class: "sp-lead__dek" }, lead.summary) : null,
    h("span", { class: "sp-lead__link" }, "The story behind the score ↗")
  );
  return h("div", { class: "sp-fbhost" }, link);
}

function briefList(briefs) {
  return h(
    "ul",
    { class: "sp-brief" },
    briefs.map((story) =>
      h(
        "li",
        { class: "sp-brief__item" },
        h(
          "div",
          { class: "sp-brief__row sp-fbhost" },
          h(
            "a",
            { class: "sp-brief__link", href: story.url, target: "_blank", rel: "noreferrer" },
            h("span", { class: "sp-brief__tag" }, `${story.competitionLabel} · ${story.publisherLabel}`),
            h("span", { class: "sp-brief__title" }, story.title)
          )
        )
      )
    )
  );
}

/** Builds the desk for one overview response. Returns null when there is nothing worth showing. */
export function buildDesk(data, ctx, now = new Date()) {
  const { locale } = ctx;
  const followed = followedTeamIndex(data.followedTeams ?? []);
  const leagueCards = data.followedLeagueCards ?? [];
  const teamCards = orderFollowedCards(data.followed, now.getTime()).slice(0, 4);
  const stories = recapStories(data);
  const lead = stories.find((s) => s.imageUrl !== null) ?? stories[0] ?? null;
  const briefs = stories.filter((s) => s !== lead).slice(0, 3);
  const { followedRows, elsewhereRows } = selectScoreRows(data, followed, now, locale);
  const { tonightRows, postponedRows } = selectTonightRows(data, followed, now, locale);
  const hasScores = followedRows.length > 0 || elsewhereRows.length > 0;
  const hasTonight = tonightRows.length > 0 || postponedRows.length > 0;
  const startedToday = hasGameStartedToday(data, now, locale);

  if (!hasScores && !hasTonight && data.topStories.length === 0 && teamCards.length === 0 && leagueCards.length === 0) return null;

  const cardsLabel = teamCards.length > 0 && leagueCards.length > 0 ? "Your teams & leagues" : leagueCards.length > 0 ? "Your leagues" : "Your teams";
  const followingLine = followingSummary(data.followed.length, data.followedLeagues.length);
  const dateLine = formatDate(now, locale, DATE_LINE);
  const zone = formatTimeZoneShort(now, locale);

  const desk = h(
    "section",
    { class: "jds-brief jds-brief--sports", "aria-label": "Sports desk" },
    h(
      "div",
      { class: "jds-section-head jds-section-head--rule desk-head" },
      h("span", { class: "jds-section-head__number" }, "03"),
      h("h2", { class: "jds-section-head__title desk-title" }, "From the sidelines"),
      h("span", { class: "jds-section-head__meta" }, "Sports desk")
    )
  );

  if (hasScores) {
    desk.append(
      h(
        "div",
        { class: "desk-scores", "aria-label": "Scores" },
        h("div", { class: "desk-scores__head" }, h("div", { class: "jds-brief__title" }, "Last night"), h("span", {}, dateLine)),
        followedRows.length > 0
          ? [h("div", { class: "sp-tksub" }, h("span", { class: "sp-tksub__morning-star" }, "★ "), "Your followed teams"), h("ul", { class: "sp-scores" }, followedRows.map((r) => scoreRow(r, followed)))]
          : null,
        elsewhereRows.length > 0 ? [h("div", { class: "sp-tksub" }, "Elsewhere worth a look"), h("ul", { class: "sp-scores" }, elsewhereRows.map((r) => scoreRow(r, followed)))] : null
      )
    );
  }

  if (lead) {
    desk.append(h("div", { class: "desk-stories", "aria-label": "Top stories" }, leadStory(lead), briefs.length > 0 ? briefList(briefs) : null));
  }

  if (teamCards.length > 0 || leagueCards.length > 0) {
    desk.append(
      h(
        "div",
        { class: "desk-cards" },
        h("div", { class: "desk-cards__head" }, h("div", { class: "sp-tksub" }, cardsLabel), followingLine ? h("span", {}, followingLine) : null),
        h("div", { class: "sp-tkgrid" }, teamCards.map((card) => tickerTeam(card, ctx)), leagueCards.slice(0, 3).map((card) => tickerLeague(card)))
      )
    );
  }

  if (hasTonight || !startedToday) {
    desk.append(
      h(
        "div",
        { class: "desk-tonight" },
        h("div", { class: "desk-tonight__head" }, h("div", { class: "sp-tksub" }, "Tonight"), h("span", {}, `${dateLine}${zone ? ` · ${zone}` : ""}`)),
        hasTonight
          ? h("ul", { class: "sp-tonight" }, tonightRows.map((r) => tonightRow(r, locale)), postponedRows.map((r) => tonightRow(r, locale)))
          : h("p", { class: "sp-tonight__quiet" }, QUIET_NIGHT_LINE)
      )
    );
  }
  return desk;
}

/** Mounts the Sports desk into `root` and refreshes it while a game is live. */
export function mountTodayDesk({ root, api, ctx }) {
  const state = { data: null, error: false };
  let timer = null;
  let gone = false;
  let lastKey = "";

  const retry = () => button("Try again", { variant: "link", onClick: () => load() });

  function render() {
    clear(root);
    const wrap = h("div", { class: "today-wrap" });
    root.append(wrap);
    if (!state.data) {
      wrap.append(
        state.error
          ? h("p", { class: "sp-lede", role: "status" }, "Sports are unavailable right now. ", retry())
          : h("p", { class: "sp-lede", role: "status" }, "Loading your teams…")
      );
      return;
    }
    if (state.error) wrap.append(h("p", { class: "sp-lede", role: "status" }, "Could not refresh sports. Showing the last loaded scores. ", retry()));
    const desk = buildDesk(state.data, ctx);
    wrap.append(desk ?? h("p", { class: "sp-lede", role: "status" }, "Nothing from the sports desk yet. Follow a team or a league and it fills in."));
  }

  async function load() {
    try {
      const next = await api.overview();
      if (gone) return;
      const key = JSON.stringify(next);
      const changed = key !== lastKey || state.error;
      lastKey = key;
      state.data = next;
      state.error = false;
      if (changed) render();
    } catch {
      if (gone) return;
      state.error = true;
      render();
    }
    window.clearTimeout(timer);
    if (!gone && !document.hidden && hasLiveGame(state.data)) timer = window.setTimeout(load, LIVE_REFETCH_INTERVAL_MS);
  }

  const onVisible = () => {
    if (!document.hidden) load();
  };
  document.addEventListener("visibilitychange", onVisible);
  render();
  load();
  return () => {
    gone = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

