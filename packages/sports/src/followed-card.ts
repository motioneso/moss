import type {
  FollowedFormEntry,
  FollowedLeagueResult,
  FollowedNextMatch,
  FollowedResultMatch,
  FollowedTeamNews,
  GameSide,
  GameSummary
} from "@moss/shared";

import {
  shortNameTarget,
  sideMatchesTarget,
  type TeamMatchTarget
} from "./follow-identity.js";
import { storyRefFields, type StoryRefFor } from "./headline-composition.js";
import type { SourceHeadline, StandingsTable } from "./source/sports-source.js";

/** First non-null/non-undefined value `pick` returns over `items`, in order. Used to search a
 *  primary-first bundle list for name/crest precedence without collapsing to a single bundle. */
export function firstDefined<T, R>(
  items: readonly T[],
  pick: (item: T) => R | null | undefined
): R | undefined {
  for (const item of items) {
    const value = pick(item);
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

// "A", "A and B", "A, B, and C" — the merged card's rationale names every followed competition
// (spec Design: `You follow Liverpool in Premier League and Champions League.`).
export function joinLabels(labels: readonly string[]): string {
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

// A team whose short name collided with another team's (review finding S1, 2026-09-04) gets a
// teamKey built from that short name plus the source's numeric id, but a scoreboard, schedule or
// standings row for the same team still carries the old, shared short name as ITS teamKey (it
// comes from a separate fetch with no visibility into the collision), and an older cached row
// carries no number at all. `TeamMatchTarget` holds both halves so every mix lines up; a bare
// string is still accepted and means "this short name and nothing else".
export type TeamMatchInput = string | TeamMatchTarget;

function sameTeam(
  side: { teamKey: string; sourceTeamId?: string | null },
  teamKey: TeamMatchInput
): boolean {
  return sideMatchesTarget(side, typeof teamKey === "string" ? shortNameTarget(teamKey) : teamKey);
}

export function findTeamGame(
  games: readonly GameSummary[],
  teamKey: TeamMatchInput
): GameSummary | undefined {
  return games.find((g) => sameTeam(g.home, teamKey) || sameTeam(g.away, teamKey));
}

// ESPN's `scoreboard?dates=YYYYMMDD` window can hold two entries for one team: last night's
// final plus today's (or, past Eastern midnight, tomorrow's) game, or both ends of a
// doubleheader. A live game always wins — it is by definition now. Otherwise take the game
// whose start is nearest to now, and only if that start is within NEAR_GAME_WINDOW_MS: a 7 PM
// final at 10 PM qualifies (2h), tomorrow's 4 PM matchup at 10 PM does not (18h) — the card then
// falls back to news status and the Next row (from the schedule dataset) still carries the
// upcoming game. findTeamGame stays for the single-day briefing path, where "any game on
// today's board" is the right question.
const NEAR_GAME_WINDOW_MS = 12 * 60 * 60 * 1000;

export function currentTeamGame(
  games: readonly GameSummary[],
  teamKey: TeamMatchInput,
  now: Date
): GameSummary | undefined {
  const mine = games.filter((g) => sideFor(g, teamKey) !== undefined);
  const live = mine.find((g) => g.state === "live");
  if (live) return live;
  const distance = (g: GameSummary): number =>
    Math.abs(new Date(g.startsAt).getTime() - now.getTime());
  const nearest = [...mine].sort((a, b) => distance(a) - distance(b))[0];
  return nearest && distance(nearest) <= NEAR_GAME_WINDOW_MS ? nearest : undefined;
}

/** The "today game" for a merged card, mirroring `buildHero`'s live > non-live-else-first
 *  priority (#855): a live game anywhere in the group always wins; otherwise the first bundle
 *  (primary-first order) with a qualifying today game keeps it. */
export function currentGameAcrossGroup(
  bundles: readonly { scoreboard: readonly GameSummary[]; teamKey: TeamMatchInput }[],
  now: Date
): { game: GameSummary; teamKey: TeamMatchInput } | undefined {
  let result: { game: GameSummary; teamKey: TeamMatchInput } | undefined;
  for (const bundle of bundles) {
    const game = currentTeamGame(bundle.scoreboard, bundle.teamKey, now);
    if (!game) continue;
    if (!result || (game.state === "live" && result.game.state !== "live")) {
      result = { game, teamKey: bundle.teamKey };
    }
  }
  return result;
}

export function sideFor(game: GameSummary, teamKey: TeamMatchInput): GameSide | undefined {
  if (sameTeam(game.home, teamKey)) return game.home;
  if (sameTeam(game.away, teamKey)) return game.away;
  return undefined;
}

function opponentFor(game: GameSummary, teamKey: TeamMatchInput): GameSide | undefined {
  if (sameTeam(game.home, teamKey)) return game.away;
  if (sameTeam(game.away, teamKey)) return game.home;
  return undefined;
}

export function scheduleSideFor(
  schedule: readonly GameSummary[],
  teamKey: TeamMatchInput
): GameSide | undefined {
  for (const game of schedule) {
    const side = sideFor(game, teamKey);
    if (side) return side;
  }
  return undefined;
}

// Up to three of the club's stories, newest first, from the already-merged league + per-team
// feeds (live feedback mrb0pk1n — "three stories per team… real news for their clubs"). The
// service's teamKeys tagging (per-team ESPN feed + resolveHeadlineTeamKeys) is the one source of
// truth for "about this club". Dedup by url — the same story can arrive from both feeds under
// different ids. Split into filter + toTeamStories (#855) so a merged club's card can pool each
// member competition's own-filtered headlines before the shared sort/dedup/cap/map pipeline.
const TEAM_STORY_LIMIT = 3;

export function filterTeamHeadlines(
  headlines: readonly SourceHeadline[],
  teamKey: string
): SourceHeadline[] {
  return headlines.filter((h) => h.teamKeys.includes(teamKey));
}

// Same javascript:/data: href guard as toPublicHeadline (#857 M2) — inlined here rather than
// imported from sports-service.ts to keep this module free of a back-reference to its caller.
function safeHref(url: string): string {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" ? url : "";
  } catch {
    return "";
  }
}

export function toTeamStories(
  headlines: readonly SourceHeadline[],
  refFor?: StoryRefFor
): FollowedTeamNews[] {
  const seen = new Set<string>();
  return headlines
    .slice()
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)))
    .slice(0, TEAM_STORY_LIMIT)
    .map((h) => ({
      // publishedAt rides along so the ticker can rank idle teams by news freshness (mra54n4h);
      // imageUrl feeds the small thumbnail on the lead story (mra5xnt2).
      title: h.title,
      url: safeHref(h.url),
      publishedAt: h.publishedAt,
      imageUrl: h.imageUrl,
      publisherLabel: h.publisherLabel,
      publisherDomain: h.publisherDomain,
      // Built from the canonical link, not `safeHref` above, so a card story and the same story
      // in top stories share one reference (#2019).
      ...storyRefFields(h.url, refFor)
    }));
}

// Start time of the team's most recent completed game, from the same season schedule that feeds
// the form pips. The ticker treats "played within the last ten days" as in-season and ranks those
// teams ahead of idle ones (live feedback mra54n4h). Null when the schedule holds no finals yet.
// Generalized to `*Across(games: ResolvedGame[])` (#855) so a merged club's card can pool each
// member competition's own schedule under its own literal teamKey.
export interface ResolvedGame {
  readonly game: GameSummary;
  readonly teamKey: TeamMatchInput;
}

export function toResolvedGames(
  schedule: readonly GameSummary[],
  teamKey: TeamMatchInput
): ResolvedGame[] {
  return schedule.map((game) => ({ game, teamKey }));
}

export function lastMatchAcross(games: readonly ResolvedGame[]): string | null {
  let latest: string | null = null;
  for (const { game, teamKey } of games) {
    if (game.state !== "final" || !sideFor(game, teamKey)) continue;
    if (latest === null || game.startsAt > latest) latest = game.startsAt;
  }
  return latest;
}

export function scoreLine(game: GameSummary): string {
  return `${game.away.shortName} ${game.away.score ?? 0} – ${game.home.score ?? 0} ${game.home.shortName}`;
}

// League-card recent-results block (Ben 2026-07-09): the /today followed-league card mirrors the
// team card but has no single team to anchor on, so we show whole-competition games — live first,
// then most-recent finals. `pre`/scheduled games are dropped (the card's job is "what happened",
// the news list carries what's coming). Capped like the story list so the card stays glanceable.
const LEAGUE_RESULT_LIMIT = 3;

export function leagueResults(games: readonly GameSummary[]): FollowedLeagueResult[] {
  return (
    games
      .filter((g) => g.state === "live" || g.state === "final")
      // live before final, then newest kickoff first — the "priority" ordering the ticker cards use.
      .sort((a, b) => {
        if (a.state !== b.state) return a.state === "live" ? -1 : 1;
        return b.startsAt.localeCompare(a.startsAt);
      })
      .slice(0, LEAGUE_RESULT_LIMIT)
      .map((g) => ({
        line: scoreLine(g),
        startsAt: g.startsAt,
        state: g.state as "live" | "final",
        detail: g.statusDetail
      }))
  );
}

function resultOf(side: GameSide, opponent: GameSide): "W" | "D" | "L" {
  if (side.score !== null && opponent.score !== null && side.score === opponent.score) return "D";
  return side.winner ? "W" : "L";
}

export function resultLine(game: GameSummary, teamKey: TeamMatchInput): string {
  const side = sideFor(game, teamKey);
  const opponent = opponentFor(game, teamKey);
  if (!side || !opponent) return matchupLine(game);
  const result = resultOf(side, opponent);
  const preposition = sameTeam(game.home, teamKey) ? "vs" : "at";
  return `${result} ${side.score ?? 0}–${opponent.score ?? 0} ${preposition} ${opponent.shortName}`;
}

export function matchupLine(game: GameSummary): string {
  return `${game.away.shortName} @ ${game.home.shortName} · ${game.statusDetail}`;
}

const FORM_LENGTH = 5;

// Per-pip detail for the hover popup (Ben 2026-07-09 /today follow-cards). Same filter/sort/slice
// as the letters below, so entry i lines up with form pip i. computeFormAcross now derives from
// this — one source of truth keeps the visible letters and the popup in lockstep by construction.
export function computeFormDetailAcross(
  games: readonly ResolvedGame[]
): readonly FollowedFormEntry[] {
  return games
    .filter(({ game, teamKey }) => game.state === "final" && sideFor(game, teamKey))
    .slice()
    .sort((a, b) => a.game.startsAt.localeCompare(b.game.startsAt))
    .slice(-FORM_LENGTH)
    .map(({ game, teamKey }) => {
      const side = sideFor(game, teamKey);
      const opponent = opponentFor(game, teamKey);
      return {
        // `side` is guaranteed by the filter; `opponent` can still be missing on a degraded
        // one-sided fixture — mirror the old "L" fallback so the letters never change.
        result: side && opponent ? resultOf(side, opponent) : "L",
        opponentName: opponent?.name ?? "Opponent",
        homeAway: sameTeam(game.home, teamKey) ? "home" : "away",
        score: `${side?.score ?? 0}–${opponent?.score ?? 0}`,
        playedAt: game.startsAt
      };
    });
}

export function computeFormAcross(games: readonly ResolvedGame[]): readonly ("W" | "D" | "L")[] {
  return computeFormDetailAcross(games).map((entry) => entry.result);
}

// Gameday hero window (live feedback mra4kqpf): live games always qualify; upcoming games only
// inside the final 15 minutes before kickoff. Finished games don't — the recap is a story.
const GAMEDAY_HERO_LEAD_MS = 15 * 60 * 1000;

export function inGamedayWindow(game: GameSummary, now: Date): boolean {
  if (game.state === "live") return true;
  if (game.state !== "pre") return false;
  return new Date(game.startsAt).getTime() - now.getTime() <= GAMEDAY_HERO_LEAD_MS;
}

// The sub-row standing is sport-aware (live feedback mraxrdxr, mraz6m43): leagues whose
// standings arrive in labelled sections (NFL/NBA divisions, tournament groups) show the
// place WITHIN that section ("2nd · NFC East") because that's how those sports are read;
// flat single-table leagues (soccer) keep the overall line ("#4 · 40 pts").
export function standingLine(
  sections: StandingsTable["sections"],
  teamKey: TeamMatchInput
): string | null {
  for (const section of sections) {
    const index = section.rows.findIndex((r) => sameTeam(r, teamKey));
    if (index === -1) continue;
    const row = section.rows[index]!;
    // Zero games played = the league isn't in progress; its "rank" is carry-over noise like
    // "#14 · 0 pts" and the card is better off without the line (live feedback mra39rlv).
    if (row.wins + row.losses + (row.draws ?? 0) === 0) return null;
    // rank ≤ 0 = the provider omitted the stat and the source's positional fallback didn't
    // apply (hand-built fixtures, older cache entries) — the section order is still the rank.
    const place = row.rank > 0 ? row.rank : index + 1;
    if (section.label) return `${ordinal(place)} · ${shortSectionLabel(section.label)}`;
    if (row.points !== null) return `#${place} · ${row.points} pts`;
    return `#${place} · ${row.wins}-${row.losses}`;
  }
  return null;
}

// Display-only compression for the card sub-row: ESPN division labels like "National League
// West" / "Pacific Division" crowd the pips out of the narrow ticker sub-row (mraxrdxr).
// Kept server-side but OUT of the standings payload — the standings rail wants the full label,
// and adding a field to StandingsSection means response-schema churn (see the fast-json-
// stringify oneOf trap that 500'd the overview this morning). NFL needs no entry: ESPN already
// names its divisions short ("NFC East").
function shortSectionLabel(label: string): string {
  return label
    .replace(/^American League /, "AL ")
    .replace(/^National League /, "NL ")
    .replace(/ Division$/, "");
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

export function nextMatchAcross(
  games: readonly ResolvedGame[],
  now: Date
): FollowedNextMatch | null {
  const nowIso = now.toISOString();
  const next = games
    .filter(
      ({ game, teamKey }) =>
        game.state !== "final" && game.startsAt > nowIso && sideFor(game, teamKey)
    )
    .slice()
    .sort((a, b) => a.game.startsAt.localeCompare(b.game.startsAt))[0];
  if (!next) return null;
  const opponent = opponentFor(next.game, next.teamKey);
  if (!opponent) return null;
  return {
    opponentName: opponent.name,
    homeAway: sameTeam(next.game.home, next.teamKey) ? "home" : "away",
    startsAt: next.game.startsAt,
    // Footer identifies the opponent by crest, not name (live feedback mrawvc48)
    opponentCrestUrl: opponent.crestUrl
  };
}

// Result payload for the featured strip's score slot (Ben 2026-07-08 /sports #2). The opponent
// crest carries the identity, the same crest-leads treatment nextMatchFor uses for the fixture
// footer. Scores come back in home/away order — NOT followed-team-first — because the client
// always draws the home crest on the left and the away crest on the right (#2253: a
// followed-team-first string put the numbers on the wrong side whenever the followed team played
// away). Returns null when the game has no resolvable two sides (fully degraded source), so the
// card falls back to the text slot.
export function resultMatchFor(game: GameSummary, teamKey: TeamMatchInput): FollowedResultMatch | null {
  const side = sideFor(game, teamKey);
  const opponent = opponentFor(game, teamKey);
  if (!side || !opponent) return null;
  const result = resultOf(side, opponent);
  const homeAway = game.home.teamKey === side.teamKey ? "home" : "away";
  const homeScore = homeAway === "home" ? (side.score ?? 0) : (opponent.score ?? 0);
  const awayScore = homeAway === "home" ? (opponent.score ?? 0) : (side.score ?? 0);
  return {
    opponentName: opponent.name,
    opponentCrestUrl: opponent.crestUrl,
    resultLabel: result,
    homeScore,
    awayScore,
    homeAway,
    ownScorers: side.scorers ?? null,
    opponentScorers: opponent.scorers ?? null
  };
}

export function teamFact(game: GameSummary, teamKey: TeamMatchInput): string {
  const side = sideFor(game, teamKey);
  const opponent = opponentFor(game, teamKey);
  const name = side?.name ?? teamKey;
  if (!side || !opponent) return `${name} play today.`;
  if (game.state === "final") {
    const result = resultOf(side, opponent);
    const verb = result === "W" ? "won" : result === "L" ? "lost" : "tied";
    return `${name} ${verb} ${side.score ?? 0}–${opponent.score ?? 0} vs ${opponent.shortName}.`;
  }
  if (game.state === "live") {
    return `${name} play now: ${scoreLine(game)}.`;
  }
  return `${name} play today at ${game.statusDetail}.`;
}
