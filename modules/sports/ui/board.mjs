/* global window */
import { LEAGUE_LOGOS, SOCCER_COMPETITIONS } from "./competitions.mjs";
import { h, svg } from "./dom.mjs";
import { formatTime } from "./locale.mjs";
import { crest, liveDot } from "./parts.mjs";
import { isFollowed } from "./ranking.mjs";

const NEAR_GAME_WINDOW_MS = 12 * 60 * 60 * 1000;
const STATE_ORDER = { live: 0, final: 1, pre: 2 };
const byLiveness = (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state];
const startMs = (game) => new Date(game.startsAt).getTime();

/** The slate worth showing for a league: live games and games near now, or whichever side of now is closer. */
export function nearNow(games) {
  const sorted = [...games].sort(byLiveness);
  const now = Date.now();
  if (sorted.some((g) => g.state === "live")) {
    return sorted.filter((g) => g.state === "live" || Math.abs(startMs(g) - now) <= NEAR_GAME_WINDOW_MS);
  }
  const finals = sorted.filter((g) => g.state === "final");
  const pres = sorted.filter((g) => g.state === "pre");
  if (finals.length === 0 || pres.length === 0) return sorted;
  const sincePrev = now - Math.max(...finals.map(startMs));
  const untilNext = Math.min(...pres.map(startMs)) - now;
  return sincePrev <= untilNext ? finals : pres;
}

/** Soccer reads home first, every other competition visitor first. */
export const orderGameSides = (game, soccer) => (soccer ? [game.home, game.away] : [game.away, game.home]);

function winnerKey(game) {
  if (game.state !== "final") return null;
  const home = Number(game.home.score);
  const away = Number(game.away.score);
  if (!Number.isFinite(home) || !Number.isFinite(away) || home === away) return null;
  return home > away ? game.home.teamKey : game.away.teamKey;
}

function leagueMark(competitionKey) {
  const src = LEAGUE_LOGOS[competitionKey];
  if (!src) return null;
  const img = h("img", { class: "sp-around__logo", src, alt: "", width: 16, height: 16, loading: "lazy" });
  img.addEventListener("error", () => img.remove());
  return img;
}

function boardSide(side, pre, dim, followed) {
  const cls = ["sp-board__side", dim ? "sp-board__side--dim" : null, followed ? "sp-board__side--you" : null].filter(Boolean).join(" ");
  return h(
    "div",
    { class: cls },
    crest({ name: side.name, crestUrl: side.crestUrl, size: "sm" }),
    h("span", { class: "sp-board__team", title: side.name }, side.shortName),
    pre ? null : h("span", { class: "sp-board__score" }, String(side.score ?? "–"))
  );
}

function boardGame(game, soccer, locale, competitionKey, followed) {
  const [first, second] = orderGameSides(game, soccer);
  const pre = game.state === "pre";
  const winner = winnerKey(game);
  return h(
    "div",
    { class: "sp-board__game" },
    h("p", { class: "sp-board__gstatus" }, game.state === "live" ? liveDot() : null, pre ? formatTime(game.startsAt, locale) : game.statusDetail),
    boardSide(first, pre, winner !== null && winner !== first.teamKey, isFollowed(followed, competitionKey, first.sourceTeamId)),
    boardSide(second, pre, winner !== null && winner !== second.teamKey, isFollowed(followed, competitionKey, second.sourceTeamId))
  );
}

const chevron = (d) => svg({ viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, d);

/** Scores around the leagues, one wrapped column flow with a league nameplate between leagues. */
export function aroundLeaguesBoard(groups, followed, ctx) {
  if (groups.length === 0) return null;
  const scroll = h("div", { class: "sp-board__scroll sp-board__scroll--more", tabindex: "0", role: "region", "aria-label": "All scores, scrollable" });
  const left = h("button", { type: "button", class: "sp-board__nav", "aria-label": "Scroll left", onClick: () => nudge(-1) }, chevron("M15 18l-6-6 6-6"));
  const right = h("button", { type: "button", class: "sp-board__nav", "aria-label": "Scroll right", onClick: () => nudge(1) }, chevron("M9 18l6-6-6-6"));
  function edges() {
    const atStart = scroll.scrollLeft <= 1;
    const atEnd = scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 1;
    left.hidden = atStart;
    right.hidden = atEnd;
    scroll.classList.toggle("sp-board__scroll--more", !atEnd);
  }
  function nudge(direction) {
    scroll.scrollBy({ left: direction * Math.round(scroll.clientWidth * 0.8), behavior: "smooth" });
  }
  for (const group of groups) {
    const [firstGame, ...rest] = nearNow(group.games);
    const soccer = SOCCER_COMPETITIONS.has(group.competitionKey);
    scroll.append(
      h("div", { class: "sp-board__lead" }, h("span", { class: "sp-board__league" }, leagueMark(group.competitionKey), group.competitionLabel), firstGame ? boardGame(firstGame, soccer, ctx.locale, group.competitionKey, followed) : null),
      ...rest.map((game) => boardGame(game, soccer, ctx.locale, group.competitionKey, followed))
    );
  }
  scroll.addEventListener("scroll", edges);
  window.addEventListener("resize", edges);
  window.setTimeout(edges, 0);
  return h(
    "section",
    { class: "sp-board", "aria-label": "Scores around the leagues" },
    h("div", { class: "sp-board__hd" }, h("p", { class: "sp-col__kicker" }, "Around the leagues"), h("div", { class: "sp-board__navs" }, left, right)),
    h("div", { class: "sp-board__body" }, scroll)
  );
}
