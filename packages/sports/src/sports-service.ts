import type { DatasetClient } from "@moss/datasets";
import type { AccessContext, DataContextDb } from "@moss/db";
import {
  localDay,
  type CreateSportsFollowRequest,
  type FollowedLeagueCard,
  type FollowedLeagueRef,
  type FollowedTeamCard,
  type GamedayGame,
  type GameSummary,
  type IsoDate,
  type OverviewHero,
  type ScoreboardGroup,
  type SportsCatalogResponse,
  type SportsFollowDto,
  type SportsLeagueTeamsResponse,
  type SportsOverviewResponse,
  type SportsNewsGroup,
  type SportsSportKey,
  type SportsTeamSearchResponse,
  type StandingsGroup,
  type StoryRelevanceCandidate,
  type StoryRelevanceResult,
  type TeamRef
} from "@moss/shared";

import { SPORTS_CATALOG, catalogEntry, competitionLogoUrl } from "./source/catalog.js";
import { isWrittenArticle, selectFeature } from "./news-ranking.js";
import {
  canonicalStoryUrl,
  composeSportsNewsGroups,
  mergeHeadlineScope,
  rankTopStories,
  resolveEspnHeadlineTeamKeys,
  toPublicHeadline,
  type StoryRefFor
} from "./headline-composition.js";
import {
  groupFollowedTeams,
  type FollowedTeamGroup,
  type ResolvedFollow
} from "./followed-groups.js";
import {
  currentGameAcrossGroup,
  currentTeamGame,
  filterTeamHeadlines,
  findTeamGame,
  firstDefined,
  inGamedayWindow,
  joinLabels,
  lastMatchAcross,
  leagueResults,
  matchupLine,
  nextMatchAcross,
  resultLine,
  resultMatchFor,
  scoreLine,
  sideFor,
  scheduleSideFor,
  standingLine,
  teamFact,
  toResolvedGames,
  toTeamStories,
  computeFormAcross,
  computeFormDetailAcross
} from "./followed-card.js";
import type { SourceHeadline, SourceTeamRef, StandingsTable } from "./source/sports-source.js";
import type { SportsPublicSourceReader } from "./source/public-source-reader.js";
import type {
  SportsEspnCoverageRepository,
  SportsEspnCoverageState
} from "./source/espn-coverage-repository.js";
import { sportsNewsCoverageAllows, sportsNewsScopeForFollow } from "./source/scope.js";

/** A compact, non-sensitive today-fact for the daily briefing. */
export type FollowedFact = { competitionKey: string; text: string };

/** The subset of `DataContextRunner` the service needs (injectable for tests). */
export interface SportsDataContext {
  withDataContext<T>(
    accessContext: AccessContext,
    work: (scopedDb: DataContextDb) => Promise<T>
  ): Promise<T>;
}

/** The subset of `SportsFollowsRepository` the service reads (injectable for tests). */
export interface SportsFollowsReader {
  list(scopedDb: DataContextDb): Promise<SportsFollowDto[]>;
}

/** The subset of `SportsFollowsRepository` the service needs to follow/unfollow (injectable for
 *  tests). The routes' CRUD handlers and the assistant tools share this same write surface. */
export interface SportsFollowsWriter extends SportsFollowsReader {
  create(scopedDb: DataContextDb, input: CreateSportsFollowRequest): Promise<SportsFollowDto>;
  remove(scopedDb: DataContextDb, id: string): Promise<boolean>;
}

/**
 * One story the overview actually rendered, registered so the owner is allowed to give feedback on
 * it (#2019). Registration is the authorisation boundary: the feedback routes refuse a target that
 * was never registered for this owner AND this surface, so a story registered only for the Sports
 * page cannot be acted on from the Today widget.
 *
 * Carries only the agreed story details. Never a raw link, never an article body.
 */
export interface RegisteredStory {
  readonly storyRef: string;
  readonly surface: "sports" | "today";
  readonly headline: string;
  readonly sourceLabel: string;
  readonly publishedAt: string;
  readonly teamRef: string | null;
  readonly competitionRef: string | null;
  readonly hasEditorialEvidence: boolean;
  readonly isOpinion?: boolean;
}

/**
 * The relevance filter and the story registrar, both injected (#2019). Sports never imports the
 * usefulness-feedback package: that is another module's internals, and the composition root owns
 * the binding. The shapes are structural for the same reason.
 */
export interface SportsStoryRelevancePort {
  (
    scopedDb: DataContextDb,
    input: {
      readonly ownerUserId: string;
      readonly moduleId: "sports";
      readonly candidates: readonly StoryRelevanceCandidate[];
      readonly now: Date;
    }
  ): Promise<StoryRelevanceResult>;
}

export interface SportsStoryFeedbackPort {
  /** Opaque per-story reference built from the canonical link; the browser cannot compute it. */
  readonly refFor: StoryRefFor;
  readonly registerStories: (
    scopedDb: DataContextDb,
    ownerUserId: string,
    stories: readonly RegisteredStory[]
  ) => Promise<void>;
}

export interface SportsServiceDependencies {
  /**
   * The dataset-connector-SDK runtime client bound to the sports module's `espn` external
   * source (docs/superpowers/specs/2026-07-04-module-dataset-connector-sdk.md). Replaces the
   * former directly-injected `SportsSource` + in-service `SportsCache` — TTL, staleness policy,
   * and host pinning now live in the manifest declaration + `@moss/datasets` runtime, not here.
   */
  readonly datasetClient: DatasetClient;
  readonly dataContext: SportsDataContext;
  readonly repository: SportsFollowsWriter;
  readonly publicSourceReader?: Pick<SportsPublicSourceReader, "refresh">;
  readonly espnCoverage?: Pick<SportsEspnCoverageRepository, "get">;
  /** Clock seam (default `() => new Date()`); tests inject a fixed instant. */
  readonly now?: () => Date;
  /**
   * Story relevance (#2019). Both optional: a service built without them behaves exactly as it did
   * before this shipped, which is also how an owner who has saved no preferences pays nothing.
   */
  readonly storyRelevance?: SportsStoryRelevancePort;
  readonly storyFeedback?: SportsStoryFeedbackPort;
}

// ESPN's `scoreboard?dates=YYYYMMDD` param is interpreted in US Eastern time, not UTC — the
// calendar day sent to the source (and cached under) must match that boundary or evening
// games fall on the wrong side of the UTC/Eastern midnight gap (#761).
const ESPN_TIMEZONE = "America/New_York";

const DAY_MS = 86_400_000;

// The overview scoreboard is fetched as yesterday..today (Eastern): a Pacific user's evening
// crosses ESPN's midnight at 9 PM local, after which "today" alone returns tomorrow's slate
// while tonight's live/final games sit under the previous ESPN day (#761's other edge). The
// wider window then needs a "near now" cut (currentTeamGame, followed-card.ts) so last night's
// finals and tomorrow's matchups don't read as today's game.
// How many hero slides get their teams' own ESPN feeds pulled for a matchup story band (#1386).
// Two feed reads per game; beyond this the later slides render bar-only.
const HERO_STORY_FEED_GAMES = 3;
const EMPTY_STANDINGS: StandingsTable = { sections: [] };
const DEFAULT_ESPN_COVERAGE: SportsEspnCoverageState = {
  enabled: true,
  usesDefaultCoverage: true,
  assignments: []
};
const DISABLED_ESPN_COVERAGE: SportsEspnCoverageState = {
  enabled: false,
  usesDefaultCoverage: false,
  assignments: []
};

// A brand-new user with zero follows (no teams, no whole-league follows) would otherwise drive
// `competitionKeys` to `[]`, so `getOverview` never fetches any scoreboard/headline data and the
// page renders as a lone empty-state CTA — the opposite of spec §4.6a's "useful any day" promise
// (#764). Fall back to this small fixed slate so the populated-empty-state branch the frontend
// already ships (`hasSlate` in sports-page.tsx) has something to show alongside the "follow your
// teams" CTA. Deliberately the major year-round domestic leagues (not `marquee`, which flags only
// the World Cup for the follow picker) so at least one is in season on any given day: NFL
// (fall/winter), NBA/NHL (fall-spring), MLB (spring-fall), Premier League (fall-spring).
const DEFAULT_SLATE_COMPETITION_KEYS: readonly string[] = ["nfl", "nba", "nhl", "mlb", "eng.1"];

// Cross-league search fan-out bounds (#907 spec §4.4): per query, at most this many uncached
// league rosters are fetched live; leagues beyond the cap are skipped and reported via
// `partial` so the UI can hint that coverage is still warming. Repeated searches converge.
const SEARCH_WARM_FILL_CAP = 5;
const SEARCH_RESULT_CAP = 30;

/** Mutable degraded flag threaded through a single composition pass. */
interface DegradeState {
  degraded: boolean;
}

/** Everything needed to build one member of a merged `FollowedTeamCard` — the same per-follow
 *  data `buildCard` used to consume directly, now stashed so a group's members can be pooled. */
/**
 * What one candidate story carried into the relevance pass, kept so the same pass can also supply
 * the bounded detail the story's registered row is allowed to store (#2019). Never a raw link and
 * never an article body.
 */
interface StoryDetail {
  readonly candidate: StoryRelevanceCandidate;
  readonly hasEditorialEvidence: boolean;
  readonly isOpinion?: boolean;
}

/**
 * Every story reference the finished response actually carries, from all five places a story can
 * appear: the story hero, top stories, the league news band, followed team cards and followed
 * league cards. A story with no reference (its link would not normalise) is simply absent.
 */
function shownStoryRefs(overview: SportsOverviewResponse): ReadonlySet<string> {
  const refs = new Set<string>();
  const add = (ref: string | undefined): void => {
    if (ref !== undefined) refs.add(ref);
  };
  if (overview.hero.mode === "story") add(overview.hero.headline?.storyRef);
  for (const headline of overview.topStories) add(headline.storyRef);
  for (const group of overview.leagueNews) {
    for (const headline of group.headlines) add(headline.storyRef);
  }
  for (const card of overview.followed) {
    for (const story of card.stories) add(story.storyRef);
  }
  for (const card of overview.followedLeagueCards) {
    for (const story of card.stories) add(story.storyRef);
  }
  return refs;
}

interface FollowedTeamBundle {
  readonly follow: ResolvedFollow;
  readonly sourceTeamId: string | null;
  readonly scoreboard: readonly GameSummary[];
  readonly standings: StandingsTable["sections"];
  readonly headlines: readonly SourceHeadline[];
  readonly schedule: readonly GameSummary[];
  readonly teams: readonly SourceTeamRef[];
}

/**
 * Composes the sports overview page, per-team cards, and briefing facts from the
 * swappable `SportsSource`. Every source call is wrapped so a provider failure
 * degrades to authored empties (`degraded: true`) rather than propagating a 500.
 */
export class SportsService {
  private readonly datasetClient: DatasetClient;
  private readonly dataContext: SportsDataContext;
  private readonly repository: SportsFollowsWriter;
  private readonly now: () => Date;
  private readonly publicSourceReader?: Pick<SportsPublicSourceReader, "refresh">;
  private readonly espnCoverage?: Pick<SportsEspnCoverageRepository, "get">;
  private readonly storyRelevance?: SportsStoryRelevancePort;
  private readonly storyFeedback?: SportsStoryFeedbackPort;

  constructor(deps: SportsServiceDependencies) {
    this.datasetClient = deps.datasetClient;
    this.dataContext = deps.dataContext;
    this.repository = deps.repository;
    this.publicSourceReader = deps.publicSourceReader;
    this.espnCoverage = deps.espnCoverage;
    this.now = deps.now ?? (() => new Date());
    this.storyRelevance = deps.storyRelevance;
    this.storyFeedback = deps.storyFeedback;
  }

  /** League metadata for the follow picker — static catalog data, no ESPN calls. Rosters are
   *  served lazily by getLeagueTeams/searchTeams instead (#907 §4.2). */
  async getCatalog(): Promise<SportsCatalogResponse> {
    const competitions = SPORTS_CATALOG.map((entry) => ({
      competitionKey: entry.competitionKey,
      label: entry.label,
      kind: entry.kind,
      marquee: entry.marquee,
      standingsShape: entry.standingsShape,
      confederation: entry.confederation
    }));
    return { competitions, degraded: false };
  }

  /** One league's clubs, on demand — picker browse-expand + followed-chip resolution (#907).
   *  Replaces the catalog's former eager per-competition fan-out to ESPN: the picker now asks
   *  for a league's roster only when the user actually expands it. */
  async getLeagueTeams(competitionKey: string): Promise<SportsLeagueTeamsResponse> {
    const state: DegradeState = { degraded: false };
    const teams = await this.teamsFor(competitionKey, state);
    return { teams, degraded: state.degraded };
  }

  /** Club search across all catalog leagues without an unbounded ESPN fan-out (#907 §4.4). */
  async searchTeams(query: string): Promise<SportsTeamSearchResponse> {
    const state: DegradeState = { degraded: false };
    const q = query.trim().toLowerCase();
    // The route schema's minLength(2) counts pre-trim characters, so a whitespace-padded query
    // ("  ") sneaks through and `includes("")` would match every cached roster while burning the
    // warm-fill budget on live fetches. Enforce the 2-char minimum post-trim too (#907 review).
    if (q.length < 2) return { teams: [], partial: false, degraded: false };
    const teams: TeamRef[] = [];
    let warmed = 0;
    let partial = false;
    // Sequential on purpose: warm-fill is a bounded, rate-courteous trickle, not a burst.
    for (const entry of SPORTS_CATALOG) {
      // Peek first (never fetches) — Task 1's cacheOnly option.
      const peek = await this.datasetClient.getDataset<SourceTeamRef[]>(
        "teams",
        { competitionKey: entry.competitionKey },
        { fallback: [], cacheOnly: true }
      );
      let roster: readonly SourceTeamRef[];
      if (peek.cacheMiss) {
        if (warmed >= SEARCH_WARM_FILL_CAP) {
          // Cap hit: this league's roster isn't cached and we've already spent this query's
          // live-fetch budget. Skip it rather than fan out to every catalog league on a cold
          // cache — `partial` tells the client coverage will improve as the cache warms.
          partial = true;
          continue;
        }
        warmed += 1;
        roster = await this.teamsFor(entry.competitionKey, state);
      } else {
        if (peek.degraded) state.degraded = true;
        roster = peek.data;
      }
      for (const team of roster) {
        // Team name/shortName only — league-label rows ("Follow all of…") stay client-side
        // against the cheap catalog list (spec §4.2).
        if (`${team.name} ${team.shortName}`.toLowerCase().includes(q)) teams.push(team);
      }
    }
    return { teams: teams.slice(0, SEARCH_RESULT_CAP), partial, degraded: state.degraded };
  }

  /** The composed `/api/sports/overview` payload for the actor. */
  async getOverview(
    accessContext: AccessContext,
    signal?: AbortSignal
  ): Promise<SportsOverviewResponse> {
    const customRefresh = this.publicSourceReader
      ? this.publicSourceReader
          .refresh(accessContext, { signal })
          .catch(() => ({ headlines: [], degraded: true, persistedResults: 0 }))
      : Promise.resolve({ headlines: [], degraded: false, persistedResults: 0 });
    const coverageRepository = this.espnCoverage;
    const [rawFollows, coverage] = await Promise.all([
      this.dataContext.withDataContext(accessContext, (db) => this.repository.list(db)),
      coverageRepository
        ? this.dataContext
            .withDataContext(accessContext, (db) => coverageRepository.get(db))
            .then((value) => ({ value, degraded: false }))
            .catch(() => ({ value: DISABLED_ESPN_COVERAGE, degraded: true }))
        : Promise.resolve({ value: DEFAULT_ESPN_COVERAGE, degraded: false })
    ]);
    // One story reference builder for the whole pass (#2019). Absent when the port is not wired,
    // in which case no story carries a reference and the browser renders no feedback menu.
    const refFor = this.storyFeedback?.refFor;
    const espnCoverage = coverage.value;
    // Skip any follow row whose competitionKey isn't in the catalog (e.g. a retired entry)
    // instead of letting it permanently degrade every load with no explanation — the picker
    // flags these to the user separately as unrecognized (#765 M3).
    const follows = rawFollows.filter((f) => catalogEntry(f.competitionKey) !== undefined);
    const state: DegradeState = { degraded: coverage.degraded };
    const today = this.today();
    // Scoreboard window start — see currentTeamGame (followed-card.ts) for why one Eastern day isn't enough.
    // ESPN accepts `dates=YYYYMMDD-YYYYMMDD`, so yesterday..today is a single fetch (and a
    // single cache entry) rather than two.
    const dayBefore = localDay(new Date(this.now().getTime() - DAY_MS), ESPN_TIMEZONE);
    // Zero follows (team or whole-league) → fetch the default slate instead of nothing (#764).
    const competitionKeys =
      follows.length > 0
        ? unique(follows.map((f) => f.competitionKey))
        : [...DEFAULT_SLATE_COMPETITION_KEYS];
    const followedTeams = follows.filter((f): f is ResolvedFollow => Boolean(f.teamKey));
    // Whole-league follows (teamKey: null) are first-class in the picker but produce no
    // FollowedTeamCard — surface them separately so the client can tell "follows nothing"
    // apart from "follows leagues, not teams" (#763).
    const followedLeagues: FollowedLeagueRef[] = follows
      .filter((f) => !f.teamKey)
      .map((f) => ({
        competitionKey: f.competitionKey,
        competitionLabel: catalogEntry(f.competitionKey)?.label ?? f.competitionKey
      }));

    // Every competition is fetched independently and in parallel (scoreboard/standings/teams
    // together, then headlines once teams resolves for the team-key join) instead of a serial
    // crawl across all competitions — a cold load no longer pays N sequential round-trips
    // (#765 M2).
    const [perComp, custom] = await Promise.all([
      Promise.all(
        competitionKeys.map(async (key) => {
          const [scoreboard, standingsTable, teams] = await Promise.all([
            this.cached<GameSummary[]>(
              "scoreboard",
              { competitionKey: key, day: dayBefore, endDay: today },
              [],
              state
            ),
            this.cached<StandingsTable>(
              "standings",
              { competitionKey: key },
              EMPTY_STANDINGS,
              state
            ),
            this.teamsFor(key, state)
          ]);
          const competition = catalogEntry(key);
          const includeEspnHeadlines =
            competition !== undefined &&
            sportsNewsCoverageAllows(espnCoverage, follows, {
              kind: "competition",
              sportKey: competition.espnSport,
              competitionKey: key
            });
          const headlines = resolveEspnHeadlineTeamKeys(
            includeEspnHeadlines
              ? await this.cached<SourceHeadline[]>("headlines", { competitionKey: key }, [], state)
              : [],
            teams
          );
          return { key, scoreboard, standingsTable, teams, headlines };
        })
      ),
      customRefresh
    ]);
    if (custom.degraded) state.degraded = true;
    const scoreboardByComp = new Map(perComp.map((p) => [p.key, p.scoreboard]));
    const standingsByComp = new Map(perComp.map((p) => [p.key, p.standingsTable]));
    const headlinesByComp = new Map(perComp.map((p) => [p.key, p.headlines]));
    const headlinesBySport = new Map<SportsSportKey, SourceHeadline[]>();
    const teamsByComp = new Map(perComp.map((p) => [p.key, p.teams]));
    for (const headline of custom.headlines) {
      if (headline.competitionKey === null) {
        const existing = headlinesBySport.get(headline.sportKey) ?? [];
        headlinesBySport.set(headline.sportKey, mergeHeadlineScope(existing, headline));
      } else {
        const existing = headlinesByComp.get(headline.competitionKey) ?? [];
        headlinesByComp.set(headline.competitionKey, mergeHeadlineScope(existing, headline));
      }
    }

    // One schedule fetch per followed team, also parallelized (#765 M2). Each follow's fetched
    // data is stashed as a bundle rather than piped straight into a card — a merged card (#855)
    // needs to pool a whole group's bundles, not just one.
    const bundleList: FollowedTeamBundle[] = await Promise.all(
      followedTeams.map(async (follow) => {
        // Resolve the provider's numeric team id from the catalog: ESPN's soccer schedule
        // endpoint returns an empty payload for abbreviation slugs, which silently zeroed
        // form/next-match on every soccer card (live feedback mrawhx9c). Null falls back to
        // the abbreviation inside the source, which the US leagues accept.
        const sourceTeamId =
          (teamsByComp.get(follow.competitionKey) ?? []).find(
            (team) => team.teamKey === follow.teamKey
          )?.sourceTeamId ?? null;
        const teamScope = sportsNewsScopeForFollow(follow);
        const includeEspnTeamFeed =
          teamScope !== null && sportsNewsCoverageAllows(espnCoverage, follows, teamScope);
        // The league-wide feed rarely files a story under a specific team, so most followed
        // cards showed "No recent news" while ESPN's per-team feed had plenty (live feedback
        // mraxssnf). Pull each followed team's own feed — same pattern as the gameday hero
        // block below — and merge it in for this card only; leagueNews stays league-scoped.
        const [schedule, teamFeed] = await Promise.all([
          this.cached<GameSummary[]>(
            "schedule",
            { teamKey: follow.teamKey, competitionKey: follow.competitionKey, sourceTeamId },
            [],
            state
          ),
          includeEspnTeamFeed
            ? this.cached<SourceHeadline[]>(
                "headlines",
                { competitionKey: follow.competitionKey, teamKey: follow.teamKey, sourceTeamId },
                [],
                state
              )
            : Promise.resolve([])
        ]);
        const compTeams = teamsByComp.get(follow.competitionKey) ?? [];
        const leagueHeadlines = headlinesByComp.get(follow.competitionKey) ?? [];
        let headlines = [...leagueHeadlines];
        for (const headline of resolveEspnHeadlineTeamKeys(teamFeed, compTeams)) {
          headlines = mergeHeadlineScope(headlines, headline);
        }
        return {
          follow,
          sourceTeamId,
          scoreboard: scoreboardByComp.get(follow.competitionKey) ?? [],
          standings: standingsByComp.get(follow.competitionKey)?.sections ?? [],
          headlines,
          schedule,
          teams: compTeams
        };
      })
    );
    // The gameday slides are settled here, BEFORE anything is filtered (#2019). They depend only
    // on the scoreboards and the follows, never on top stories, so pulling their teams' feeds now
    // means the relevance filter sees every headline the page could show and runs exactly once.
    // Filtering after the hero was known would cost a second model call on every page load.
    const gamedayGames = this.gamedayGames(followedTeams, scoreboardByComp, this.now());

    // On a gameday, the league-wide news feed rarely covers the featured matchup itself, so
    // the scorebar's photo+blurb band (findFeaturedStory on the client) usually comes up
    // empty. Pull each hero team's own ESPN feed into the pool so a real story about the
    // matchup is available — still honest data, just fetched where ESPN actually files it.
    // Every hero slide needs its own story band, so this runs per game, not just for the lead
    // one (#1386). Capped: each game costs two ESPN feed reads, and past a handful of
    // simultaneous games the reads stop paying for themselves — later slides simply show the
    // score bar with no band, which is already the normal no-matching-story outcome.
    for (const { game } of gamedayGames.slice(0, HERO_STORY_FEED_GAMES)) {
      const heroTeams = teamsByComp.get(game.competitionKey) ?? [];
      const heroCompetition = catalogEntry(game.competitionKey);
      // Resolve each hero side's numeric id from the same catalog the followed cards use — the
      // news endpoint 400s on a soccer abbreviation slug (EspnHeadlinesParams.sourceTeamId),
      // which would leave a soccer gameday hero with no matchup story at all.
      const teamFeeds = await Promise.all(
        [game.home.teamKey, game.away.teamKey].map((teamKey) => {
          const includeEspnTeamFeed =
            heroCompetition !== undefined &&
            sportsNewsCoverageAllows(espnCoverage, follows, {
              kind: "team",
              sportKey: heroCompetition.espnSport,
              competitionKey: game.competitionKey,
              teamKey
            });
          return includeEspnTeamFeed
            ? this.cached<SourceHeadline[]>(
                "headlines",
                {
                  competitionKey: game.competitionKey,
                  teamKey,
                  sourceTeamId:
                    heroTeams.find((team) => team.teamKey === teamKey)?.sourceTeamId ?? null
                },
                [],
                state
              )
            : Promise.resolve([]);
        })
      );
      const existing = headlinesByComp.get(game.competitionKey) ?? [];
      // Dedup by url, not id: the same story arrives from the league feed and a hero team's own
      // feed under DIFFERENT ids (ESPN ids are feed-scoped — see the
      // toTeamStories/followedStoryUrls dedup, which key on url for the same reason). Keying on
      // id here let a matchup story render twice in the NewsBand (Fable M1). url is the story's
      // stable cross-feed identity.
      let merged = [...existing];
      for (const headline of resolveEspnHeadlineTeamKeys(teamFeeds.flat(), heroTeams)) {
        merged = mergeHeadlineScope(merged, headline);
      }
      headlinesByComp.set(game.competitionKey, merged);
    }

    // One relevance pass over every headline the page could show, then every pool is cut down to
    // the survivors (#2019). Doing it here — before followed cards, the hero, top stories and the
    // league news band are composed from these same pools — is what makes the promise true that a
    // story the owner asked to see less of cannot come back through a sibling feed.
    const relevance = await this.applyStoryRelevance(
      accessContext,
      { byComp: headlinesByComp, bySport: headlinesBySport, bundles: bundleList },
      followedTeams,
      state
    );

    const bundles = new Map(bundleList.map((b) => [b.follow.id, b]));
    // Group by canonical club key (espnSport:sourceTeamId) — spec's dedupe rule (#855). A follow
    // whose sourceTeamId didn't resolve becomes its own singleton group (never merged by name).
    const groups = groupFollowedTeams(followedTeams, (f) => bundles.get(f.id)!.sourceTeamId);
    const cards: FollowedTeamCard[] = groups.map((group) =>
      this.buildGroupedCard(group, bundles, this.now(), refFor)
    );

    // Rank across every followed competition (team or whole-league), not just team-followed
    // ones — otherwise a league-only follower's competition never contributes a top story and
    // the story hero has nothing personalized to fall back to (#763).
    const rankingNewsGroups = composeSportsNewsGroups(
      headlinesBySport,
      headlinesByComp,
      competitionKeys
    );
    const rankedTopStories = rankTopStories(
      rankingNewsGroups,
      followedTeams,
      relevance.liftFor
    );

    // The hero must not echo what the followed strip already shows (mrb8ahf7). rankTopStories'
    // first tier IS followed-team stories — the same pool toTeamStories draws each card's ≤3
    // stories from — so the hero's lead routinely duplicated a card's lead. Drop any top story
    // whose url is already on a followed card: the strip owns a followed team's news, and the
    // hero then surfaces that team's deeper stories plus each league's editorial lead instead.
    // Match on url, not id — the same story arrives from the league and per-team feeds under
    // different ids (the same reason toTeamStories dedups by url).
    const followedStoryUrls = new Set(
      cards.flatMap((card) =>
        card.stories.map((story) => canonicalStoryUrl(story.url) ?? story.url)
      )
    );
    const topStories = rankedTopStories.filter(
      (headline) => !followedStoryUrls.has(canonicalStoryUrl(headline.url) ?? headline.url)
    );

    // Band exclusion keys off the FULL ranked set, not the deduped one: a story we pulled from
    // the hero for already being on a card must not resurface in the league news band either, so
    // a followed-team story stays shown exactly once — in its card.
    const topStoryUrls = new Set(
      rankedTopStories.map((headline) => canonicalStoryUrl(headline.url) ?? headline.url)
    );

    const hero = this.buildHero(gamedayGames, topStories, this.storyFeedback?.refFor);

    const newsGroups = composeSportsNewsGroups(
      headlinesBySport,
      headlinesByComp,
      competitionKeys
    ).flatMap((group) => {
      const headlines = group.headlines.filter(
        (headline) => !topStoryUrls.has(canonicalStoryUrl(headline.url) ?? headline.url)
      );
      return headlines.length > 0 ? [{ ...group, headlines }] : [];
    });

    const scoreboard: ScoreboardGroup[] = competitionKeys
      .map((key) => ({
        competitionKey: key,
        competitionLabel: catalogEntry(key)?.label ?? key,
        games: scoreboardByComp.get(key) ?? []
      }))
      .filter((group) => group.games.length > 0);

    const standings: StandingsGroup[] = competitionKeys
      .map((key) => ({
        competitionKey: key,
        competitionLabel: catalogEntry(key)?.label ?? key,
        standingsShape: catalogEntry(key)?.standingsShape ?? "table",
        sections: standingsByComp.get(key)?.sections ?? []
      }))
      .filter((group) => group.sections.some((section) => section.rows.length > 0));

    // Fill the NewsBand hero with real article body (#857). The featured story is picked
    // CLIENT-side by NewsBand; we recompute the IDENTICAL pick here with the shared ranking
    // (selectFeature over all groups = the client's default "all" filter), fetch just that one
    // article's ESPN body (sanitized to plaintext in the source layer), and splice it onto the
    // matching headline. Body isn't a ranking input, so the pick is stable. Any failure returns
    // "" → we leave `body` off → the client falls back to the one-paragraph dek. Only ONE extra
    // request per overview, cached by article id (immutable post-publish).
    const publicNewsGroups: SportsNewsGroup[] = newsGroups.map((group) => ({
      ...group,
      headlines: group.headlines.map((headline) => toPublicHeadline(headline, refFor))
    }));
    const followedPairs = new Set(followedTeams.map((f) => `${f.competitionKey}:${f.teamKey}`));
    const feature = selectFeature(publicNewsGroups, followedPairs);
    const internalFeature = feature
      ? newsGroups
          .flatMap((group) => group.headlines)
          .find(
            (headline) =>
              headline.id === feature.id &&
              canonicalStoryUrl(headline.url) === canonicalStoryUrl(feature.url)
          )
      : undefined;
    const featureBody =
      feature && internalFeature?.origin === "espn"
        ? await this.cached<string>("articleBody", { articleId: feature.id }, "", state)
        : "";
    const newsGroupsWithBody =
      feature && featureBody
        ? publicNewsGroups.map((group) => ({
            ...group,
            headlines: group.headlines.map((h) =>
              h.id === feature.id && h.url === feature.url ? { ...h, body: featureBody } : h
            )
          }))
        : publicNewsGroups;

    // Team-shaped cards for whole-competition follows that are ACTIVE right now (Ben 2026-07-09:
    // "show news/results for a followed league/tournament when it's active"). Active = the comp has
    // recent games (scoreboard window) OR fresh headlines — an in-season signal, no separate schedule
    // probe. A followed league with neither (off-season) yields no card, so the widget stays quiet
    // instead of showing an empty shell. Reuses the team-card machinery: toTeamStories for the ≤3
    // headline strip, leagueResults for the recent live/final block.
    const followedLeagueCards: FollowedLeagueCard[] = followedLeagues
      .map((league): FollowedLeagueCard => {
        const games = scoreboardByComp.get(league.competitionKey) ?? [];
        const stories = toTeamStories(headlinesByComp.get(league.competitionKey) ?? [], refFor);
        const results = leagueResults(games);
        return {
          competitionKey: league.competitionKey,
          competitionLabel: league.competitionLabel,
          kind: (catalogEntry(league.competitionKey)?.kind ?? "league") as "league" | "tournament",
          // "live" the instant any of the league's games is in progress — drives the card's live dot,
          // same as a team card's `.sp-tk__live`. Otherwise it's a news/results card.
          status: games.some((g) => g.state === "live") ? "live" : "news",
          // Official competition logo (Ben 2026-07-09 "prefer the logo to be clear"); client Crest
          // degrades to the initials swatch if the CDN URL 404s.
          logoUrl: competitionLogoUrl(league.competitionKey),
          stories,
          results
        };
      })
      .filter((card) => card.stories.length > 0 || card.results.length > 0);

    const overview: SportsOverviewResponse = {
      hero,
      followed: cards,
      scoreboard,
      topStories: topStories.map((headline) => toPublicHeadline(headline, refFor)),
      leagueNews: newsGroupsWithBody,
      standings,
      followedTeams: followedTeams.map((f) => ({
        competitionKey: f.competitionKey,
        teamKey: f.teamKey
      })),
      followedLeagues,
      followedLeagueCards,
      degraded: state.degraded
    };

    // Read the references back off the FINISHED response rather than off the candidate pool, so a
    // story is registered when, and only when, the owner can actually see it and act on it.
    await this.registerShownStories(accessContext, shownStoryRefs(overview), relevance.details);
    return overview;
  }

  /**
   * One league's standings, fetched on demand (#842). Never throws; degrades to empty sections.
   * For a tournament whose group stage is complete, also returns the current round's fixtures
   * (a ±window of the scoreboard) so the client can show the bracket instead of a stale group
   * table (#839 follow-up); `fixtures` is empty for every other case.
   */
  async getStandings(
    competitionKey: string
  ): Promise<{ group: StandingsGroup; fixtures: GameSummary[] }> {
    const state: DegradeState = { degraded: false };
    const table = await this.cached<StandingsTable>(
      "standings",
      { competitionKey },
      EMPTY_STANDINGS,
      state
    );
    const entry = catalogEntry(competitionKey);
    const group: StandingsGroup = {
      competitionKey,
      competitionLabel: entry?.label ?? competitionKey,
      standingsShape: entry?.standingsShape ?? "table",
      sections: table.sections
    };
    const fixtures =
      entry?.kind === "tournament" && groupStageComplete(table.sections)
        ? await this.currentRoundFixtures(competitionKey, state)
        : [];
    return { group, fixtures };
  }

  /** Scoreboard over a ±window around today, flattened and sorted ascending. Never throws. */
  private async currentRoundFixtures(
    competitionKey: string,
    state: DegradeState
  ): Promise<GameSummary[]> {
    const now = this.now();
    const day = localDay(new Date(now.getTime() - 3 * DAY_MS), ESPN_TIMEZONE);
    const endDay = localDay(new Date(now.getTime() + 4 * DAY_MS), ESPN_TIMEZONE);
    const games = await this.cached<GameSummary[]>(
      "scoreboard",
      { competitionKey, day, endDay },
      [],
      state
    );
    return [...games].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  /**
   * Compact today-facts for followed competitions/teams, for the daily briefing.
   * `scopedDb` is already opened under `withDataContext` by the caller. Never throws.
   */
  async getFollowedFactsForToday(
    scopedDb: DataContextDb,
    _actorUserId: string
  ): Promise<{ facts: FollowedFact[] }> {
    try {
      const rawFollows = await this.repository.list(scopedDb);
      const follows = rawFollows.filter((f) => catalogEntry(f.competitionKey) !== undefined);
      const today = this.today();
      const state: DegradeState = { degraded: false };
      const boards = new Map<string, GameSummary[]>();
      const facts: FollowedFact[] = [];
      for (const follow of follows) {
        const comp = follow.competitionKey;
        if (!boards.has(comp)) {
          boards.set(
            comp,
            await this.cached<GameSummary[]>(
              "scoreboard",
              { competitionKey: comp, day: today },
              [],
              state
            )
          );
        }
        const games = boards.get(comp) ?? [];
        if (follow.teamKey) {
          const game = findTeamGame(games, follow.teamKey);
          if (game) facts.push({ competitionKey: comp, text: teamFact(game, follow.teamKey) });
        } else if (games.length > 0) {
          const label = catalogEntry(comp)?.label ?? comp;
          facts.push({
            competitionKey: comp,
            text: `${games.length} ${label} game${games.length === 1 ? "" : "s"} play today.`
          });
        }
      }
      return { facts };
    } catch {
      return { facts: [] };
    }
  }

  /** Follow a catalog team or whole competition. Both keys are closed against the catalog, same
   *  rule as `POST /api/sports/follows` (routes.ts) — the route and the assistant tool share this.
   *
   *  The teamKey check exists because this is a `granted_at_install` auto-run write tool (#1265
   *  security QA BLOCKING-1a): an assistant-supplied teamKey lands here with no human
   *  confirmation, is persisted, and is later interpolated into an outbound ESPN schedule URL
   *  (espn-source.ts `getSchedule`). Closing it against the league roster — the same list the
   *  picker and `GET /api/sports/leagues/:competitionKey/teams` serve — keeps an attacker-chosen
   *  string out of that sink at the earliest layer. Two further independent belts back this up:
   *  the manifest input schema's length/pattern bounds, and encodeURIComponent at the URL site. */
  async followTeam(
    scopedDb: DataContextDb,
    input: { competitionKey: string; teamKey?: string | null }
  ): Promise<{ ok: true; follow: SportsFollowDto } | { ok: false; error: string }> {
    if (!catalogEntry(input.competitionKey)) {
      return { ok: false, error: `Unknown competition: ${input.competitionKey}` };
    }
    const teamKey = input.teamKey ?? null;
    if (teamKey !== null) {
      // `getLeagueTeams` fails soft (empty list + degraded) on an ESPN outage rather than
      // throwing, so an outage rejects every teamKey. That is deliberate fail-CLOSED behavior for
      // an auto-run write tool — do not add a degraded-bypass.
      const { teams } = await this.getLeagueTeams(input.competitionKey);
      if (!teams.some((team) => team.teamKey === teamKey)) {
        return { ok: false, error: `Unknown team: ${teamKey}` };
      }
    }
    const follow = await this.repository.create(scopedDb, {
      competitionKey: input.competitionKey,
      teamKey
    });
    return { ok: true, follow };
  }

  /** Unfollow by catalog key, not by opaque follow id — the assistant never sees row ids. Removing
   *  something never followed is a no-op (`removed: false`), not an error: follow -> unfollow ->
   *  follow must be idempotent (Spec 2). */
  async unfollowTeam(
    scopedDb: DataContextDb,
    input: { competitionKey: string; teamKey?: string | null }
  ): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
    if (!catalogEntry(input.competitionKey)) {
      return { ok: false, error: `Unknown competition: ${input.competitionKey}` };
    }
    const teamKey = input.teamKey ?? null;
    const existing = await this.repository.list(scopedDb);
    const match = existing.find(
      (f) => f.competitionKey === input.competitionKey && f.teamKey === teamKey
    );
    if (!match) return { ok: true, removed: false };
    const removed = await this.repository.remove(scopedDb, match.id);
    return { ok: true, removed };
  }

  // --- internals ----------------------------------------------------------

  private today(): IsoDate {
    return localDay(this.now(), ESPN_TIMEZONE);
  }

  private async cached<T>(
    datasetKey: string,
    params: Record<string, unknown>,
    fallback: T,
    state: DegradeState
  ): Promise<T> {
    const result = await this.datasetClient.getDataset<T>(datasetKey, params, { fallback });
    if (result.degraded) state.degraded = true;
    return result.data;
  }

  private async teamsFor(
    competitionKey: string,
    state: DegradeState
  ): Promise<readonly SourceTeamRef[]> {
    return this.cached<SourceTeamRef[]>("teams", { competitionKey }, [], state);
  }

  /**
   * Runs the relevance filter exactly once over every headline the page could show, cuts every
   * pool down to the survivors in place, and hands back what the rest of the composition needs
   * (#2019).
   *
   * Returns the per-story details for the stories it saw, so the caller can register the ones the
   * response actually contains, plus the "more like this" lift by story reference.
   *
   * Never throws. A relevance failure must not blank the page and must not stop live scores: the
   * Sports page re-fetches every sixty seconds while a game is in progress, so this is wrapped the
   * same way every other source call in `getOverview` is wrapped.
   */
  private async applyStoryRelevance(
    accessContext: AccessContext,
    pools: {
      readonly byComp: Map<string, SourceHeadline[]>;
      readonly bySport: Map<SportsSportKey, SourceHeadline[]>;
      readonly bundles: FollowedTeamBundle[];
    },
    followedTeams: readonly ResolvedFollow[],
    state: DegradeState
  ): Promise<{
    readonly details: ReadonlyMap<string, StoryDetail>;
    readonly liftFor: (headline: SourceHeadline) => number;
  }> {
    const policy = this.storyRelevance;
    const refFor = this.storyFeedback?.refFor;
    const empty = { details: new Map<string, StoryDetail>(), liftFor: () => 0 };
    if (!policy || !refFor) return empty;

    const followedPairs = new Set(
      followedTeams.map((follow) => `${follow.competitionKey}:${follow.teamKey}`)
    );
    const refByUrl = new Map<string, string>();
    const details = new Map<string, StoryDetail>();

    const refOf = (headline: SourceHeadline): string | undefined => {
      // Keyed on the CANONICAL link, which is this module's cross-feed identity for a story
      // (canonicalStoryUrl). That is what makes one story arriving from a league feed and from a
      // team feed a single candidate with a single reference.
      const canonical = canonicalStoryUrl(headline.url);
      if (!canonical) return undefined;
      const known = refByUrl.get(canonical);
      if (known !== undefined) return known;
      try {
        const ref = refFor(canonical);
        refByUrl.set(canonical, ref);
        return ref;
      } catch {
        return undefined;
      }
    };

    const collect = (headlines: readonly SourceHeadline[]): void => {
      headlines.forEach((headline, feedPosition) => {
        const storyRef = refOf(headline);
        if (storyRef === undefined || details.has(storyRef)) return;
        const competitionKey = headline.competitionKey;
        const teamRef =
          competitionKey === null
            ? null
            : (headline.teamKeys.find((key) => followedPairs.has(`${competitionKey}:${key}`)) ??
              null);
        // A clip or a short blurb is not an opinion piece. A written article MIGHT be, and this
        // check cannot tell — so the flag is left off rather than guessed. Never invent evidence.
        const written = isWrittenArticle(headline);
        details.set(storyRef, {
          candidate: {
            storyRef,
            headline: headline.title,
            sourceLabel: headline.publisherLabel,
            publishedAt: headline.publishedAt,
            feedPosition,
            teamRef,
            competitionRef: competitionKey,
            ...(written ? {} : { isOpinion: false })
          },
          // The only editorial signal this module actually has: the source put the story first in
          // its own feed. Nothing else counts as evidence.
          hasEditorialEvidence: feedPosition === 0,
          ...(written ? {} : { isOpinion: false })
        });
      });
    };
    for (const headlines of pools.byComp.values()) collect(headlines);
    for (const headlines of pools.bySport.values()) collect(headlines);
    for (const bundle of pools.bundles) collect(bundle.headlines);
    if (details.size === 0) return empty;

    let result: StoryRelevanceResult;
    try {
      result = await this.dataContext.withDataContext(accessContext, (db) =>
        policy(db, {
          ownerUserId: accessContext.actorUserId,
          moduleId: "sports",
          candidates: [...details.values()].map((detail) => detail.candidate),
          now: this.now()
        })
      );
    } catch {
      // Keep the last good behaviour: every story stays, the page says it is degraded, and the
      // scoreboard is untouched.
      state.degraded = true;
      return { details, liftFor: () => 0 };
    }
    if (result.status === "degraded") state.degraded = true;

    const kept = new Set(result.kept.map((candidate) => candidate.storyRef));
    const keep = (headline: SourceHeadline): boolean => {
      const storyRef = refOf(headline);
      // A story we could not build a reference for was never judged, so it is never dropped.
      return storyRef === undefined || kept.has(storyRef);
    };
    for (const [key, headlines] of pools.byComp) pools.byComp.set(key, headlines.filter(keep));
    for (const [key, headlines] of pools.bySport) pools.bySport.set(key, headlines.filter(keep));
    pools.bundles.forEach((bundle, index) => {
      pools.bundles[index] = { ...bundle, headlines: bundle.headlines.filter(keep) };
    });

    const lifts =
      result.status === "applied"
        ? new Map(result.boosts.map((boost) => [boost.storyRef, boost.lift]))
        : new Map<string, number>();
    return {
      details,
      liftFor: (headline) => {
        const storyRef = refOf(headline);
        return storyRef === undefined ? 0 : (lifts.get(storyRef) ?? 0);
      }
    };
  }

  /**
   * Registers every story the composed response actually carries, so the owner is allowed to give
   * feedback on it (#2019). Registration is the authorisation boundary — the feedback routes
   * refuse a target that was never registered for this owner and this surface — so it is not
   * optional, and it is done once per surface the story can be acted on from.
   *
   * Both surfaces are written because the Today widget renders from this very same response
   * (`web/today-widget.tsx` reuses the overview query). Registering only the Sports page would
   * make the Today menu fail on a story the user can plainly see.
   *
   * Note for the next reader: #2016 left an "a story preference changed" callback unwired, and
   * this slice deliberately does not wire it. Sports composes its overview live on every request,
   * so there is no stored snapshot to rebuild and no queue to schedule; the refresh is simply the
   * browser fetching the overview again, and the next fetch already excludes a rejected story
   * without any model call because the shared code removes rejections by reference first.
   *
   * Never throws: failing to register must not take the page down.
   */
  private async registerShownStories(
    accessContext: AccessContext,
    shownRefs: ReadonlySet<string>,
    details: ReadonlyMap<string, StoryDetail>
  ): Promise<void> {
    const port = this.storyFeedback;
    if (!port || shownRefs.size === 0) return;
    const stories: RegisteredStory[] = [];
    for (const storyRef of shownRefs) {
      const detail = details.get(storyRef);
      if (!detail) continue;
      for (const surface of ["sports", "today"] as const) {
        stories.push({
          storyRef,
          surface,
          headline: detail.candidate.headline,
          sourceLabel: detail.candidate.sourceLabel,
          publishedAt: detail.candidate.publishedAt,
          teamRef: detail.candidate.teamRef ?? null,
          competitionRef: detail.candidate.competitionRef ?? null,
          hasEditorialEvidence: detail.hasEditorialEvidence,
          ...(detail.isOpinion === undefined ? {} : { isOpinion: detail.isOpinion })
        });
      }
    }
    if (stories.length === 0) return;
    try {
      // One database call inside one data context: a page can easily carry fifty stories, and two
      // surfaces each, so a row-at-a-time loop would be a hundred round-trips per page load.
      await this.dataContext.withDataContext(accessContext, (db) =>
        port.registerStories(db, accessContext.actorUserId, stories)
      );
    } catch {
      // The page is already composed and correct. A story whose row is missing simply refuses
      // feedback, which is the safe direction for the authorisation boundary to fail in.
    }
  }

  /**
   * The gameday slides, in final order. Split out of `buildHero` (#2019) because it depends only
   * on the scoreboards and the follows — not on top stories — so `getOverview` can settle the
   * gameday games, pull those teams' own feeds and fold them into the headline pools BEFORE the
   * relevance filter runs. Filtering twice would mean two model calls per page load.
   */
  private gamedayGames(
    followedTeams: readonly ResolvedFollow[],
    scoreboardByComp: Map<string, GameSummary[]>,
    now: Date
  ): GamedayGame[] {
    // Every followed game in the window becomes a hero slide (#1386), not just the best one.
    const inWindow: GamedayGame[] = [];
    const seenGameIds = new Set<string>();
    for (const follow of followedTeams) {
      // currentTeamGame (not findTeamGame): the two-day scoreboard also holds last night's
      // final and, past Eastern midnight, tomorrow's matchup — neither belongs in the hero.
      const game = currentTeamGame(
        scoreboardByComp.get(follow.competitionKey) ?? [],
        follow.teamKey,
        now
      );
      if (!game) continue;
      const teamSide = sideFor(game, follow.teamKey);
      if (!teamSide) continue;
      // The gameday masthead+scorebar only leads the page from T−15min through the final
      // whistle; a morning "Today: X at Y" all day pushes real news below the fold (live
      // feedback mra4kqpf). Outside the window the top story leads instead.
      if (!inGamedayWindow(game, now)) continue;
      // Follow both clubs in one derby and it's still ONE game — without this it would slide
      // twice, and the count line this replaced had exactly that bug.
      if (seenGameIds.has(game.id)) continue;
      seenGameIds.add(game.id);
      inWindow.push({
        game,
        // Editorial UI shows the human label, never the raw key (#765 M4).
        competitionLabel: catalogEntry(follow.competitionKey)?.label ?? follow.competitionKey,
        rationale: `You follow ${teamSide.name}.`
      });
    }
    // Live games lead; within each group the user's own follow order decides. Two passes over
    // the array rather than a comparator so the ordering is stable by construction — a sort
    // whose comparator ties would be free to reshuffle equal games between polls, and the
    // client tracks the active slide by game id precisely so it never moves under a reader.
    return [
      ...inWindow.filter((entry) => entry.game.state === "live"),
      ...inWindow.filter((entry) => entry.game.state !== "live")
    ];
  }

  private buildHero(
    gamedayGames: readonly GamedayGame[],
    topStories: readonly SourceHeadline[],
    refFor: StoryRefFor | undefined
  ): OverviewHero {
    if (gamedayGames.length > 0) return { mode: "gameday", games: gamedayGames };
    const top = topStories[0];
    return { mode: "story", headline: top ? toPublicHeadline(top, refFor) : null };
  }

  private buildGroupedCard(
    group: FollowedTeamGroup,
    bundles: ReadonlyMap<string, FollowedTeamBundle>,
    now: Date,
    refFor: StoryRefFor | undefined
  ): FollowedTeamCard {
    // Primary-first: the primary follow's data wins every precedence tie below (spec Design).
    const orderedFollows = [
      group.primary,
      ...group.follows.filter((f) => f.id !== group.primary.id)
    ];
    const orderedBundles = orderedFollows.map((f) => bundles.get(f.id)!);
    const primaryBundle = orderedBundles[0]!;
    const comp = group.primary.competitionKey;
    const competitionLabel = catalogEntry(comp)?.label ?? comp;

    const todayGame = currentGameAcrossGroup(
      orderedBundles.map((b) => ({ scoreboard: b.scoreboard, teamKey: b.follow.teamKey })),
      now
    );
    const todaySide = todayGame ? sideFor(todayGame.game, todayGame.teamKey) : undefined;
    const catalogTeamFor = (b: FollowedTeamBundle) =>
      b.teams.find((t) => t.teamKey === b.follow.teamKey);
    // D1: today side → catalog → schedule → last-resort uppercase key, same precedence as the
    // old single-team buildCard, now searched primary-first across the group's bundles.
    const name =
      todaySide?.name ??
      firstDefined(orderedBundles, (b) => catalogTeamFor(b)?.name) ??
      firstDefined(orderedBundles, (b) => scheduleSideFor(b.schedule, b.follow.teamKey)?.name) ??
      group.primary.teamKey.toUpperCase();
    const crestUrl =
      todaySide?.crestUrl ??
      firstDefined(orderedBundles, (b) => catalogTeamFor(b)?.crestUrl) ??
      firstDefined(
        orderedBundles,
        (b) => scheduleSideFor(b.schedule, b.follow.teamKey)?.crestUrl
      ) ??
      null;

    let status: FollowedTeamCard["status"];
    let primary: string;
    let todayGameState: FollowedTeamCard["todayGameState"];
    if (todayGame && todayGame.game.state === "live") {
      status = "live";
      primary = scoreLine(todayGame.game);
    } else if (todayGame) {
      status = "today";
      todayGameState = todayGame.game.state === "final" ? "final" : "pre";
      primary =
        todayGame.game.state === "final"
          ? resultLine(todayGame.game, todayGame.teamKey)
          : matchupLine(todayGame.game);
    } else {
      status = "news";
      primary = "";
    }

    const resolvedGames = orderedBundles.flatMap((b) =>
      toResolvedGames(b.schedule, b.follow.teamKey)
    );
    const storyPool = orderedBundles.flatMap((b) =>
      filterTeamHeadlines(b.headlines, b.follow.teamKey)
    );
    const competitionLabels = orderedBundles.map(
      (b) => catalogEntry(b.follow.competitionKey)?.label ?? b.follow.competitionKey
    );

    return {
      teamKey: group.primary.teamKey,
      competitionKey: comp,
      competitionLabel,
      name,
      crestUrl,
      status,
      primary,
      todayGameState,
      stories: toTeamStories(storyPool, refFor),
      form: computeFormAcross(resolvedGames),
      formDetail: computeFormDetailAcross(resolvedGames),
      // standing comes ONLY from the primary competition (spec Design) — a Champions League
      // group table would be meaningless as "the" standing for a club whose default identity is
      // its domestic league position.
      standing: standingLine(primaryBundle.standings, group.primary.teamKey),
      nextMatch: nextMatchAcross(resolvedGames, now),
      // Crest-led result for the featured strip's score slot (Ben 2026-07-08 /sports #2). Only a
      // finished today game qualifies.
      resultMatch:
        todayGame && todayGame.game.state === "final"
          ? resultMatchFor(todayGame.game, todayGame.teamKey)
          : null,
      lastMatchAt: lastMatchAcross(resolvedGames),
      rationale:
        orderedBundles.length === 1
          ? `You follow ${name}.`
          : `You follow ${name} in ${joinLabels(competitionLabels)}.`
    };
  }
}

// --- pure helpers ---------------------------------------------------------

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// A tournament group stage is complete once every group is fully played — each section has rows
// and every team in it has played at least (group size − 1) games (a round-robin). Used to switch
// the standings response over to current-round fixtures (#839 follow-up).
function groupStageComplete(sections: StandingsTable["sections"]): boolean {
  if (sections.length === 0) return false;
  return sections.every(
    (section) =>
      section.rows.length > 0 &&
      section.rows.every(
        (row) => row.wins + row.losses + (row.draws ?? 0) >= section.rows.length - 1
      )
  );
}
