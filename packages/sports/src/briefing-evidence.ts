import {
  SPORTS_EVIDENCE_GAMES_MAX,
  SPORTS_EVIDENCE_STORIES_PER_TEAM_MAX,
  SPORTS_EVIDENCE_STORIES_TOTAL_MAX,
  type GameSummary,
  type SportsBriefingEvidenceV1,
  type SportsBriefingEvidenceGameV1,
  type SportsBriefingEvidenceStoryV1,
  type SportsBriefingGamePhase,
  type SportsBriefingState,
  type SportsFollowDto
} from "@moss/shared";

import { matchTargetFor, resolveFollowIdentity } from "./follow-identity.js";
import {
  filterTeamHeadlines,
  findTeamGame,
  matchupLine,
  scoreLine,
  teamFact,
  toTeamStories
} from "./followed-card.js";
import type { StoryRefFor } from "./headline-composition.js";
import type { SourceHeadline, SourceTeamRef } from "./source/sports-source.js";
export interface SportsBriefingFact {
  readonly competitionKey: string;
  readonly text: string;
}

// `deriveGamePhase` lives in `@moss/shared` (T11) so the owning Today widgets can reuse the
// local-day rule in the browser without importing this service module's server-only graph.
// Imported for use below and re-exported so existing server callers and tests keep working.
import { deriveGamePhase } from "@moss/shared";

export { deriveGamePhase };

/** Section state: live wins, then tonight, then finals; quiet needs a full empty answer. */
export function deriveSportsState(
  phases: readonly SportsBriefingGamePhase[],
  degraded: boolean,
  boardsEmpty: boolean
): SportsBriefingState {
  if (phases.includes("live")) return "live";
  if (phases.includes("tonight")) return "tonight";
  if (phases.includes("final")) return "finals";
  if (degraded) return "unknown";
  if (boardsEmpty) return "quiet";
  return "quiet";
}

export interface SportsEvidenceInput {
  readonly follows: readonly SportsFollowDto[];
  readonly teamsByComp: ReadonlyMap<string, readonly SourceTeamRef[]>;
  readonly scoreboardByComp: ReadonlyMap<string, readonly GameSummary[]>;
  readonly headlinesByComp: ReadonlyMap<string, readonly SourceHeadline[]>;
  readonly now: Date;
  readonly timeZone: string;
  readonly degraded: boolean;
  readonly capturedAt: string;
  readonly refFor?: StoryRefFor;
}

function toEvidenceGame(
  game: GameSummary,
  phase: SportsBriefingGamePhase
): SportsBriefingEvidenceGameV1 {
  let headline: string;
  try {
    headline = game.state === "final" ? scoreLine(game) : matchupLine(game);
  } catch {
    headline = `${game.away.shortName} at ${game.home.shortName}`;
  }
  const homeScore = typeof game.home.score === "number" ? game.home.score : null;
  const awayScore = typeof game.away.score === "number" ? game.away.score : null;
  return {
    id: game.id.slice(0, 200),
    competitionKey: game.competitionKey.slice(0, 100),
    startsAt: game.startsAt,
    phase,
    statusDetail: (game.statusDetail ?? "").slice(0, 200),
    headline: headline.slice(0, 300),
    homeShort: (game.home.shortName ?? "").slice(0, 60),
    awayShort: (game.away.shortName ?? "").slice(0, 60),
    homeScore,
    awayScore
  };
}

function toEvidenceStory(
  headline: {
    title: string;
    url: string;
    publishedAt: string;
    imageUrl: string | null;
    publisherLabel: string;
    publisherDomain: string;
    storyRef?: string;
  },
  teamKey: string | null,
  competitionKey: string
): SportsBriefingEvidenceStoryV1 | null {
  try {
    const protocol = new URL(headline.url).protocol;
    if (protocol !== "https:" && protocol !== "http:") return null;
  } catch {
    return null;
  }
  if (!headline.title || !headline.publishedAt) return null;
  if (Number.isNaN(Date.parse(headline.publishedAt))) return null;
  return {
    teamKey,
    competitionKey: competitionKey.slice(0, 100),
    title: headline.title.slice(0, 300),
    url: headline.url.slice(0, 2000),
    publishedAt: headline.publishedAt,
    imageUrl: headline.imageUrl ? headline.imageUrl.slice(0, 2000) : null,
    publisherLabel: (headline.publisherLabel ?? "").slice(0, 200),
    publisherDomain: (headline.publisherDomain ?? "").slice(0, 200),
    ...(headline.storyRef ? { storyRef: headline.storyRef.slice(0, 300) } : {})
  };
}

/**
 * Pure sports evidence composition. The service fetches boards, teams and
 * headlines; this function resolves identities, facts, phases and stories.
 */
export function composeSportsBriefingEvidence(input: SportsEvidenceInput): {
  facts: SportsBriefingFact[];
  evidence: SportsBriefingEvidenceV1;
} {
  const facts: SportsBriefingFact[] = [];
  const gamesById = new Map<string, SportsBriefingEvidenceGameV1>();
  const stories: SportsBriefingEvidenceStoryV1[] = [];
  let ambiguousFollowCount = 0;

  const pushGame = (game: GameSummary): SportsBriefingGamePhase => {
    const phase = deriveGamePhase(game, input.now, input.timeZone);
    if (!gamesById.has(game.id) && gamesById.size < SPORTS_EVIDENCE_GAMES_MAX) {
      gamesById.set(game.id, toEvidenceGame(game, phase));
    }
    return phase;
  };

  const pushTeamStories = (
    headlines: readonly SourceHeadline[],
    teamKey: string | null,
    competitionKey: string
  ): void => {
    if (stories.length >= SPORTS_EVIDENCE_STORIES_TOTAL_MAX) return;
    const mapped = toTeamStories(headlines, input.refFor).slice(
      0,
      SPORTS_EVIDENCE_STORIES_PER_TEAM_MAX
    );
    for (const story of mapped) {
      if (stories.length >= SPORTS_EVIDENCE_STORIES_TOTAL_MAX) break;
      const evidence = toEvidenceStory(story, teamKey, competitionKey);
      if (evidence) stories.push(evidence);
    }
  };

  if (input.follows.length === 0) {
    const boards = [...input.scoreboardByComp.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [competitionKey, board] of boards) {
      const upcoming = [...board].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 3);
      for (const game of upcoming) pushGame(game);
      if (board.length > 0 && facts.length < 8) {
        facts.push({
          competitionKey,
          text: `${board.length} ${competitionKey} game${board.length === 1 ? "" : "s"} on the slate.`
        });
      }
      const headlines = input.headlinesByComp.get(competitionKey) ?? [];
      if (headlines.length > 0 && stories.length < SPORTS_EVIDENCE_STORIES_TOTAL_MAX) {
        pushTeamStories(headlines.slice(0, 3), null, competitionKey);
      }
      if (gamesById.size >= SPORTS_EVIDENCE_GAMES_MAX) break;
    }
  } else {
    for (const follow of input.follows) {
      if (!follow.teamKey) {
        const board = input.scoreboardByComp.get(follow.competitionKey) ?? [];
        for (const game of board.slice(0, 3)) pushGame(game);
        if (board.length > 0) {
          facts.push({
            competitionKey: follow.competitionKey,
            text: `${board.length} ${follow.competitionKey} game${board.length === 1 ? "" : "s"} play today.`
          });
        }
        const headlines = input.headlinesByComp.get(follow.competitionKey) ?? [];
        pushTeamStories(headlines.slice(0, 3), null, follow.competitionKey);
        continue;
      }
      const teams = input.teamsByComp.get(follow.competitionKey) ?? [];
      const identity = resolveFollowIdentity(follow, teams);
      const target = matchTargetFor(identity);
      if (target === null) {
        ambiguousFollowCount += 1;
        continue;
      }
      const board = input.scoreboardByComp.get(follow.competitionKey) ?? [];
      const game = findTeamGame(board, target);
      if (game) {
        pushGame(game);
        facts.push({ competitionKey: follow.competitionKey, text: teamFact(game, target) });
      }
      if (identity.catalogKey) {
        const headlines = input.headlinesByComp.get(follow.competitionKey) ?? [];
        const filtered = filterTeamHeadlines(headlines, identity.catalogKey);
        pushTeamStories(filtered, identity.catalogKey, follow.competitionKey);
      }
    }
  }

  const games = [...gamesById.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const phases = games.map((game) => game.phase);
  const boardsEmpty = [...input.scoreboardByComp.values()].every((board) => board.length === 0);
  const state = deriveSportsState(phases, input.degraded, boardsEmpty);

  return {
    facts,
    evidence: {
      version: 1,
      capturedAt: input.capturedAt,
      degraded: input.degraded,
      state:
        input.degraded && state !== "live" && state !== "tonight" && state !== "finals"
          ? "unknown"
          : state,
      ambiguousFollowCount,
      games,
      stories
    }
  };
}
