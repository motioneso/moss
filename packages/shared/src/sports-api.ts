// packages/shared/src/sports-api.ts — BROWSER-SAFE. No node:* imports.
import type { SportsSportKey } from "./sports-sources-api.js";

export type IsoDate = string; // "YYYY-MM-DD"

export interface TeamRef {
  readonly teamKey: string; // stable within a competition, e.g. "dal" or ESPN team id
  readonly competitionKey: string;
  readonly name: string;
  readonly shortName: string;
  readonly crestUrl: string | null;
}

export interface GameSide {
  readonly teamKey: string;
  readonly name: string;
  readonly shortName: string;
  readonly crestUrl: string | null;
  readonly score: number | null; // null pre-game
  readonly record: string | null; // "10-2"
  readonly winner: boolean;
  // Goal scorers for soccer/hockey, tallied as "Name" or "Name (2)" for a repeat scorer, in
  // first-appearance order. Null for every other sport, and null pre-game/live (only ever set
  // by the finished-game render path).
  readonly scorers: readonly string[] | null;
}

export interface GameSummary {
  readonly id: string;
  readonly competitionKey: string;
  readonly startsAt: string; // ISO instant
  readonly state: "pre" | "live" | "final";
  readonly statusDetail: string; // "7:20 PM", "Q3 4:12", "FT"
  readonly home: GameSide;
  readonly away: GameSide;
}

export interface StandingsRow {
  readonly teamKey: string;
  readonly name: string;
  readonly rank: number;
  readonly points: number | null; // soccer
  readonly wins: number;
  readonly losses: number;
  readonly draws: number | null;
  readonly winPercent: number | null; // US leagues; null for soccer
  readonly qualifies: boolean; // advancement/qualification marker
  readonly qualificationNote: string | null; // e.g. "UEFA Champions League"; null when none (#841)
  readonly qualificationColor: string | null; // raw source hex; carried for a later design pass (#841)
}

export type StandingsShape = "table" | "groups" | "record";

export interface StandingsSection {
  readonly label: string | null; // "Group A", "AFC East"; null = single table
  // Parent conference label, e.g. "American Football Conference"; absent/null for flat tables
  // and soccer groups (#839 follow-up).
  readonly conference?: string | null;
  readonly rows: readonly StandingsRow[];
}

export interface Headline {
  readonly id: string;
  readonly sportKey: SportsSportKey;
  readonly competitionKey: string | null;
  /** The human label for this story's sport or competition scope. */
  readonly competitionLabel: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly imageUrl: string | null; // first "header" image, else first image, else null
  // Pixel size of the stored copy behind `imageUrl` (#2237). Always present: null where the photo
  // size is not known, so a reader never has to distinguish "absent" from "unknown".
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  readonly summary: string; // short article blurb from the source; "" when absent (#840)
  readonly teamKeys: readonly string[]; // filled by the service join (Task 4); source emits []
  readonly publisherLabel: string;
  readonly publisherDomain: string;
  // Sanitized plaintext excerpt of the full article body (#857). Populated ONLY for the single
  // NewsBand featured story (the service fetches its per-article ESPN body); every other headline
  // omits it and the UI falls back to `summary`. Already stripped of all HTML/tokens and length-
  // capped in the source layer — the client renders it as text, never as HTML.
  readonly body?: string;
  // Opaque per-story identifier for usefulness feedback (#2019). Built server-side from the
  // canonical link with a Node-only hash, so the browser cannot compute it and never sends a raw
  // link. Optional: a payload cached in a browser from before this shipped has no ref, and the
  // story menu renders nothing rather than sending feedback the server would refuse.
  readonly storyRef?: string;
}

/** FIFA confederation grouping for the follow picker's browse mode (#907). "INTL" covers the
 *  US majors (grouping only applies visually to soccer) and cross-confederation tournaments. */
export type Confederation = "UEFA" | "CONCACAF" | "CONMEBOL" | "AFC" | "CAF" | "OFC" | "INTL";

export interface CompetitionRef {
  readonly competitionKey: string;
  readonly label: string; // "NFL", "Premier League"
  readonly sportLabel: string;
  readonly regionLabel: string | null;
  readonly kind: "league" | "tournament";
  readonly marquee: boolean; // World Cup flag
  readonly standingsShape: StandingsShape;
  readonly confederation: Confederation;
}

export interface SportsFollowDto {
  readonly id: string;
  readonly competitionKey: string;
  readonly teamKey: string | null; // null = whole competition
  readonly createdAt: string;
}

export interface FollowedTeamRef {
  readonly competitionKey: string;
  readonly teamKey: string;
}

// A whole-competition follow (teamKey: null on the DTO) — surfaced separately from
// FollowedTeamCard[] so the client can tell "follows nothing" apart from "follows leagues,
// not teams" (#763).
export interface FollowedLeagueRef {
  readonly competitionKey: string;
  readonly competitionLabel: string;
}

// One followed game inside the gameday window — a single slide of the hero score bar.
export interface GamedayGame {
  readonly game: GameSummary;
  readonly competitionLabel: string; // "NFL" — never render competitionKey raw (#765 M4)
  readonly rationale: string;
}

// Composed page (GET /api/sports/overview)
export type OverviewHero =
  // Every followed game currently in the gameday window, not just the lead one (#1386). Ordered
  // live-first, then by follow order; `games[0]` is the lead and the array is never empty. The
  // client carousels this when there's more than one, so a second live game is visible instead of
  // being reduced to the "N more followed games today" count this used to carry and never render.
  | { readonly mode: "gameday"; readonly games: readonly GamedayGame[] }
  | { readonly mode: "story"; readonly headline: Headline | null };

export interface FollowedTeamNews {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string; // ISO — the ticker ranks idle teams by news freshness (mra54n4h)
  readonly imageUrl: string | null; // small thumbnail on non-live ticker cards (mra5xnt2)
  readonly publisherLabel: string;
  readonly publisherDomain: string;
  // Same opaque feedback identifier as `Headline.storyRef` (#2019), and optional for the same
  // reason. A story reached from a followed card carries the SAME ref as the identical story
  // reached from top stories: both derive from the canonical link.
  readonly storyRef?: string;
}

export interface FollowedNextMatch {
  readonly opponentName: string; // full name, resolved per D1
  readonly homeAway: "home" | "away";
  readonly startsAt: string; // ISO instant; formatted client-side in the viewer's locale
  // Opponent crest for the ticker's Next footer, which identifies the opponent by logo
  // instead of name (live feedback mrawvc48). Optional: pre-#845 payloads predate it.
  readonly opponentCrestUrl?: string | null;
}

// A finished game rendered on the featured strip's score slot. The opponent crest carries the
// identity (mirroring FollowedNextMatch's crest-leads convention) — no "vs <team>" tail, that
// trailing text read as cheap next to the rest of the card (Ben 2026-07-08 /sports annotation #2).
// Set only for a today game that has gone final; live/pre/idle cards leave it null and keep the
// `primary` string slot.
export interface FollowedResultMatch {
  readonly opponentName: string; // full name; the crest is the primary identifier, this backs a11y
  readonly opponentCrestUrl: string | null;
  readonly resultLabel: "W" | "D" | "L"; // the followed team's own result, never home/away's
  // Scores in home/away order, matching the crest layout (home crest left, away crest right) —
  // NOT "followed team first". A flattened own-then-opponent string here was the #2253 bug: the
  // client showed the followed team's number first even when the crests had already flipped to
  // home-first order, so an away follower saw the numbers on the wrong side of the scoreline.
  readonly homeScore: number;
  readonly awayScore: number;
  readonly homeAway: "home" | "away"; // was the followed team home or away
  // Goal scorers for soccer/hockey, home team's own crest side vs the opponent's, so the client
  // can lay out both sides' scorers around both crests. Null for every other sport, or when the
  // provider had no scorer data for this game.
  readonly ownScorers: readonly string[] | null;
  readonly opponentScorers: readonly string[] | null;
}

// One completed game behind a recent-form pip, so the ticker can show the result on hover
// (Ben 2026-07-09 /today follow-cards: "add the result of the last match when the user hovers
// over the L or W… a nice little stylized pop-up"). Same length/order as `form` — index i of
// `formDetail` describes pip i. `result` duplicates `form[i]` so the client renders from one
// source. Kept minimal (no crest) because the popup is text-only.
export interface FollowedFormEntry {
  readonly result: "W" | "D" | "L";
  readonly opponentName: string; // full name of the opponent in that game
  readonly homeAway: "home" | "away"; // was the followed team home or away
  readonly score: string; // "4–2", your score first — the never-red result lives in `result`
  readonly playedAt: string; // ISO kickoff of the completed game, formatted client-side
}

export interface FollowedTeamCard {
  readonly teamKey: string;
  readonly competitionKey: string;
  readonly competitionLabel: string;
  readonly name: string;
  readonly crestUrl: string | null;
  readonly status: "live" | "today" | "news";
  readonly primary: string; // "MIN 21 – 14 DAL", "W 4–2 vs NYR", or a headline title
  // For status "today": whether today's game has finished. The ticker keeps a final score in
  // the primary slot but drops the pre-game matchup line — the Next footer already carries the
  // fixture (live feedback mrawrk0e). Optional: older payloads predate it.
  readonly todayGameState?: "pre" | "final";
  // Up to three of the club's own stories, newest first (live feedback mrb0pk1n — "three
  // stories per team… real news for their clubs"). stories[0] is the lead (thumbnail slot);
  // the rest render as text links. Replaces the old single `news` field.
  readonly stories: readonly FollowedTeamNews[];
  readonly form: readonly ("W" | "D" | "L")[];
  // Per-pip result detail backing the hover popup on `form` (Ben 2026-07-09). Same order/length
  // as `form`. Optional + nullable: pre-#897 payloads predate it, and the client falls back to a
  // plain (non-interactive) pip when it's absent.
  readonly formDetail?: readonly FollowedFormEntry[] | null;
  readonly standing: string | null;
  readonly nextMatch: FollowedNextMatch | null;
  // A finished today-game's result, rendered as opponent crest + "L 3–9" on the featured strip
  // (Ben 2026-07-08 /sports annotation #2) instead of the cheap-looking "L 3–9 vs Blue Jays"
  // text. Null unless today's game is final. Optional: pre-#864 payloads predate the field, so
  // the client falls back to the `primary` text slot when it's absent.
  readonly resultMatch?: FollowedResultMatch | null;
  // Start time of the team's most recent completed game (ISO), null when the schedule holds no
  // finals. The ticker uses it with nextMatch.startsAt to rank in-season teams (games within ten
  // days) above idle ones (live feedback mra54n4h).
  readonly lastMatchAt: string | null;
  readonly rationale: string;
}

// One recent game behind a followed-league card (Ben 2026-07-09 /today: "if the user follows a
// league or tournament we should show news / results for it"). `line` is scoreLine() — away
// short + score – score + home short — so the card needs no team refs. Live games rank ahead of
// finals; pre-games are omitted (a fixture is not a result, and the news body already implies the
// slate). Text-only by design: a league card is news-forward, the results are the sub-note.
export interface FollowedLeagueResult {
  readonly line: string; // "NYY 5 – 3 BOS"
  readonly startsAt: string; // ISO kickoff; formatted client-side if ever shown
  readonly state: "live" | "final";
  readonly detail: string; // statusDetail — "Final", "Q3 4:12" — the state chip on the row
}

// A followed whole-competition (teamKey: null) rendered as a team-shaped card in the /today
// Sports desk (Ben 2026-07-09, spec waived by owner). Mirrors FollowedTeamCard's news anatomy —
// league crest/name header, lead story + secondary links — but swaps the team's form/standing/
// next-game machinery for a compact recent-results block. Only built for ACTIVE competitions
// (games in the scoreboard window or news within ~14d); off-season leagues never produce a card,
// which is the "when that league / tournament is active" gate.
export interface FollowedLeagueCard {
  readonly competitionKey: string;
  readonly competitionLabel: string; // "Premier League", "NFL"
  readonly kind: "league" | "tournament"; // labels the standing slot ("League"/"Tournament")
  readonly status: "live" | "news"; // "live" when any game in the league is in progress now
  readonly logoUrl: string | null; // official competition logo (ESPN CDN); null → initials swatch
  readonly stories: readonly FollowedTeamNews[]; // ≤3 league headlines, newest first
  readonly results: readonly FollowedLeagueResult[]; // ≤3 recent live/final games, live first
}

export interface ScoreboardGroup {
  readonly competitionKey: string;
  readonly competitionLabel: string;
  readonly games: readonly GameSummary[];
}

export interface StandingsGroup {
  readonly competitionKey: string;
  readonly competitionLabel: string;
  readonly standingsShape: StandingsShape;
  readonly sections: readonly StandingsSection[];
}

export type SportsNewsGroup =
  | {
      readonly kind: "sport";
      readonly sportKey: SportsSportKey;
      readonly competitionKey: null;
      readonly competitionLabel: string;
      readonly headlines: readonly Headline[];
    }
  | {
      readonly kind: "competition";
      readonly sportKey: SportsSportKey;
      readonly competitionKey: string;
      readonly competitionLabel: string;
      readonly headlines: readonly Headline[];
    };

export interface SportsOverviewResponse {
  readonly hero: OverviewHero;
  readonly followed: readonly FollowedTeamCard[];
  readonly scoreboard: readonly ScoreboardGroup[];
  readonly topStories: readonly Headline[]; // ranked, capped at 6
  readonly leagueNews: readonly SportsNewsGroup[];
  readonly standings: readonly StandingsGroup[];
  readonly followedTeams: readonly FollowedTeamRef[]; // for is-you marking on the client
  readonly followedLeagues: readonly FollowedLeagueRef[]; // whole-competition follows (#763)
  // Team-shaped cards for followed whole-competitions that are active right now (Ben 2026-07-09).
  // Separate from `followedLeagues` (bare refs, for is-you marking): these carry the news+results
  // payload the /today Sports desk renders. Empty when no followed league is in-season.
  readonly followedLeagueCards: readonly FollowedLeagueCard[];
  readonly degraded: boolean; // source failed → cached/empty
}

/** `GET /api/sports/leagues/:competitionKey/teams` — one league's clubs, fetched on demand by
 *  the follow picker (browse-expand and followed-chip name resolution). Replaces the retired
 *  eager per-league fan-out in the catalog (#907). */
export interface SportsLeagueTeamsResponse {
  readonly teams: readonly TeamRef[];
  readonly degraded: boolean; // roster fetch failed → empty teams + retry affordance
}

/** `GET /api/sports/teams/search?q=` — bounded cross-league club search for the follow picker.
 *  `partial` = warm-fill hasn't covered every catalog league yet this process lifetime; NOT an
 *  error state (`degraded` keeps meaning "a fetch failed") — spec §4.4 (#907). */
export interface SportsTeamSearchResponse {
  readonly teams: readonly TeamRef[];
  readonly partial: boolean;
  readonly degraded: boolean;
}

export interface SportsCatalogResponse {
  readonly competitions: readonly CompetitionRef[];
  // Kept for wire stability; static catalog data can no longer degrade (#907).
  readonly degraded: boolean;
}

export interface SportsFollowsResponse {
  readonly follows: readonly SportsFollowDto[];
}

/** `GET /api/sports/standings?competitionKey=<key>` response (#842). */
export interface SportsStandingsResponse {
  readonly group: StandingsGroup;
  // Current-round matches for tournaments whose group stage is complete; empty otherwise
  // (#839 follow-up).
  readonly fixtures: readonly GameSummary[];
}

export interface CreateSportsFollowRequest {
  readonly competitionKey: string;
  readonly teamKey?: string | null;
}

// Fastify route JSON schemas live in sports-api-schemas.ts and are re-exported here so
// existing importers keep working.
export * from "./sports-api-schemas.js";
