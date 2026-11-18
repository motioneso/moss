import { SOCCER_COMPETITIONS } from "./competitions.mjs";
import { formatDate, formatTime, formatTimeZoneShort, localDay } from "./locale.mjs";
import { isFollowed } from "./ranking.mjs";
import { orderGameSides } from "./board.mjs";

/** Second-group cap. Followed games are uncapped, the rest of the league slate is not. */
export const ELSEWHERE_SCORES_MAX = 4;

/** Tonight band cap, by start time after the followed-first split. */
export const TONIGHT_ROWS_MAX = 6;

export const QUIET_NIGHT_LINE =
  "A quiet night. No games for your followed teams or other featured matchups tonight.";

const POSTPONED_PATTERN = /postpon|ppd|cancel/i;

const startMs = (game) => new Date(game.startsAt).getTime();

/** One game's phase on the viewer's local day. */
export function deriveGamePhase(game, now, locale) {
  if (POSTPONED_PATTERN.test(game.statusDetail ?? "")) return "postponed";
  if (game.state === "live") return "live";
  if (game.state === "final") return "final";
  const start = new Date(game.startsAt);
  if (Number.isNaN(start.getTime())) return "upcoming";
  if (localDay(start, locale) === localDay(now, locale) && start.getTime() > now.getTime()) return "tonight";
  return "upcoming";
}

const sideFollowed = (followed, game, side) => isFollowed(followed, game.competitionKey, side.sourceTeamId);
const gameFollowed = (followed, game) => sideFollowed(followed, game, game.home) || sideFollowed(followed, game, game.away);
const followedSide = (followed, game) => (sideFollowed(followed, game, game.home) ? "home" : sideFollowed(followed, game, game.away) ? "away" : null);

/** Live rows first, then the most recent start. */
const byScoreOrder = (a, b) => (a.game.state !== b.game.state ? (a.game.state === "live" ? -1 : 1) : startMs(b.game) - startMs(a.game));
const followedFirstByStart = (a, b) => (a.followed !== b.followed ? (a.followed ? -1 : 1) : startMs(a.game) - startMs(b.game));

/** Every game in the window, hero games included once. Labels travel with the rows. */
function collectGames(data) {
  const seen = new Set();
  const games = [];
  for (const group of data.scoreboard) {
    for (const game of group.games) {
      if (seen.has(game.id)) continue;
      seen.add(game.id);
      games.push({ game, competitionLabel: group.competitionLabel });
    }
  }
  if (data.hero.mode === "gameday") {
    for (const entry of data.hero.games) {
      if (seen.has(entry.game.id)) continue;
      seen.add(entry.game.id);
      games.push({ game: entry.game, competitionLabel: entry.competitionLabel });
    }
  }
  return games;
}

export function selectScoreRows(data, followed, now, locale) {
  const rows = [];
  for (const { game, competitionLabel } of collectGames(data)) {
    const phase = deriveGamePhase(game, now, locale);
    if (phase !== "final" && phase !== "live") continue;
    rows.push({ game, competitionLabel, followed: gameFollowed(followed, game) });
  }
  return {
    followedRows: rows.filter((r) => r.followed).sort(byScoreOrder),
    elsewhereRows: rows.filter((r) => !r.followed).sort(byScoreOrder).slice(0, ELSEWHERE_SCORES_MAX)
  };
}

export function selectTonightRows(data, followed, now, locale) {
  const tonightRows = [];
  const postponedRows = [];
  for (const { game, competitionLabel } of collectGames(data)) {
    const phase = deriveGamePhase(game, now, locale);
    const row = { game, competitionLabel, followed: gameFollowed(followed, game), followedSide: followedSide(followed, game) };
    if (phase === "tonight") tonightRows.push(row);
    else if (phase === "postponed" && localDay(game.startsAt, locale) === localDay(now, locale)) postponedRows.push(row);
  }
  tonightRows.sort(followedFirstByStart);
  postponedRows.sort(followedFirstByStart);
  return { tonightRows: tonightRows.slice(0, TONIGHT_ROWS_MAX), postponedRows };
}

/** True when a game is live now or finished on the viewer's local day. */
export function hasGameStartedToday(data, now, locale) {
  return collectGames(data).some(({ game }) => {
    const phase = deriveGamePhase(game, now, locale);
    if (phase === "live") return true;
    return phase === "final" && localDay(game.startsAt, locale) === localDay(now, locale);
  });
}

export function followingSummary(teams, leagues) {
  const parts = [teams > 0 ? `${teams} ${teams === 1 ? "team" : "teams"}` : "", leagues > 0 ? `${leagues} ${leagues === 1 ? "league" : "leagues"}` : ""].filter(Boolean);
  return parts.length > 0 ? `Following ${parts.join(" and ")}` : "";
}

export { formatDate, formatTime, formatTimeZoneShort, orderGameSides, SOCCER_COMPETITIONS };
