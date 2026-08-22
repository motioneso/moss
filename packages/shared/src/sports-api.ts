// packages/shared/src/sports-api.ts — BROWSER-SAFE. No node:* imports.
import { errorResponseSchema } from "./schema-fragments.js";

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
  readonly competitionKey: string;
  readonly competitionLabel: string; // "NFL", "Premier League" — never render competitionKey raw (#765 M4)
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly imageUrl: string | null; // first "header" image, else first image, else null
  readonly summary: string; // short article blurb from the source; "" when absent (#840)
  readonly teamKeys: readonly string[]; // filled by the service join (Task 4); source emits []
  // Sanitized plaintext excerpt of the full article body (#857). Populated ONLY for the single
  // NewsBand featured story (the service fetches its per-article ESPN body); every other headline
  // omits it and the UI falls back to `summary`. Already stripped of all HTML/tokens and length-
  // capped in the source layer — the client renders it as text, never as HTML.
  readonly body?: string;
}

/** FIFA confederation grouping for the follow picker's browse mode (#907). "INTL" covers the
 *  US majors (grouping only applies visually to soccer) and cross-confederation tournaments. */
export type Confederation = "UEFA" | "CONCACAF" | "CONMEBOL" | "AFC" | "CAF" | "OFC" | "INTL";

export interface CompetitionRef {
  readonly competitionKey: string;
  readonly label: string; // "NFL", "Premier League"
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
// identity (mirroring FollowedNextMatch's crest-leads convention), so `scoreText` is just the
// result + scores with NO "vs <team>" tail — that trailing text read as cheap next to the rest
// of the card (Ben 2026-07-08 /sports annotation #2). Set only for a today game that has gone
// final; live/pre/idle cards leave it null and keep the `primary` string slot.
export interface FollowedResultMatch {
  readonly opponentName: string; // full name; the crest is the primary identifier, this backs a11y
  readonly opponentCrestUrl: string | null;
  readonly scoreText: string; // "L 3–9" — result letter + your–their score, opponent via the crest
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

export interface LeagueNewsGroup {
  readonly competitionKey: string;
  readonly competitionLabel: string;
  readonly headlines: readonly Headline[]; // no hard cap — bounded by the source fetch
}

export interface SportsOverviewResponse {
  readonly hero: OverviewHero;
  readonly followed: readonly FollowedTeamCard[];
  readonly scoreboard: readonly ScoreboardGroup[];
  readonly topStories: readonly Headline[]; // ranked, capped at 6
  readonly leagueNews: readonly LeagueNewsGroup[];
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

// ---------------------------------------------------------------------------
// Fastify route JSON schemas — mirror weather-api.ts (`as const`,
// additionalProperties: false, response 200 + errorResponseSchema).
// ---------------------------------------------------------------------------

const teamRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teamKey", "competitionKey", "name", "shortName", "crestUrl"],
  properties: {
    teamKey: { type: "string" },
    competitionKey: { type: "string" },
    name: { type: "string" },
    shortName: { type: "string" },
    crestUrl: { type: ["string", "null"] }
  }
} as const;

const gameSideSchema = {
  type: "object",
  additionalProperties: false,
  required: ["teamKey", "name", "shortName", "crestUrl", "score", "record", "winner"],
  properties: {
    teamKey: { type: "string" },
    name: { type: "string" },
    shortName: { type: "string" },
    crestUrl: { type: ["string", "null"] },
    score: { type: ["number", "null"] },
    record: { type: ["string", "null"] },
    winner: { type: "boolean" }
  }
} as const;

const gameSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "competitionKey", "startsAt", "state", "statusDetail", "home", "away"],
  properties: {
    id: { type: "string" },
    competitionKey: { type: "string" },
    startsAt: { type: "string" },
    state: { type: "string", enum: ["pre", "live", "final"] },
    statusDetail: { type: "string" },
    home: gameSideSchema,
    away: gameSideSchema
  }
} as const;

const standingsRowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "teamKey",
    "name",
    "rank",
    "points",
    "wins",
    "losses",
    "draws",
    "winPercent",
    "qualifies",
    "qualificationNote",
    "qualificationColor"
  ],
  properties: {
    teamKey: { type: "string" },
    name: { type: "string" },
    rank: { type: "number" },
    points: { type: ["number", "null"] },
    wins: { type: "number" },
    losses: { type: "number" },
    draws: { type: ["number", "null"] },
    winPercent: { type: ["number", "null"] },
    qualifies: { type: "boolean" },
    qualificationNote: { type: ["string", "null"] },
    qualificationColor: { type: ["string", "null"] }
  }
} as const;

const standingsSectionSchema = {
  type: "object",
  additionalProperties: false,
  // `conference` intentionally omitted from `required`: older cached standings tables lack it.
  required: ["label", "rows"],
  properties: {
    label: { type: ["string", "null"] },
    conference: { type: ["string", "null"] },
    rows: { type: "array", items: standingsRowSchema }
  }
} as const;

const headlineSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "competitionKey",
    "competitionLabel",
    "title",
    "url",
    "publishedAt",
    "imageUrl",
    "summary",
    "teamKeys"
  ],
  properties: {
    id: { type: "string" },
    competitionKey: { type: "string" },
    competitionLabel: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    publishedAt: { type: "string" },
    imageUrl: { type: ["string", "null"] },
    summary: { type: "string" },
    teamKeys: { type: "array", items: { type: "string" } },
    // Optional (not in `required`) — only the featured story carries it (#857). MUST be listed
    // here even though it's optional: this schema is used inside a oneOf (hero.headline), where
    // fast-json-stringify REJECTS the whole object for any emitted key it doesn't know — the same
    // trap documented on `nextMatch`/`stories` below that has 500'd /overview before.
    body: { type: "string" }
  }
} as const;

const competitionRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["competitionKey", "label", "kind", "marquee", "standingsShape", "confederation"],
  properties: {
    competitionKey: { type: "string" },
    label: { type: "string" },
    kind: { type: "string", enum: ["league", "tournament"] },
    marquee: { type: "boolean" },
    standingsShape: { type: "string", enum: ["table", "groups", "record"] },
    // Follow-picker browse grouping (#907); "INTL" = US majors + cross-confederation tournaments.
    confederation: {
      type: "string",
      enum: ["UEFA", "CONCACAF", "CONMEBOL", "AFC", "CAF", "OFC", "INTL"]
    }
  }
} as const;

const followDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "competitionKey", "teamKey", "createdAt"],
  properties: {
    id: { type: "string" },
    competitionKey: { type: "string" },
    teamKey: { type: ["string", "null"] },
    createdAt: { type: "string" }
  }
} as const;

const followedTeamCardSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "teamKey",
    "competitionKey",
    "competitionLabel",
    "name",
    "crestUrl",
    "status",
    "primary",
    "stories",
    "form",
    "standing",
    "nextMatch",
    "lastMatchAt",
    "rationale"
  ],
  properties: {
    teamKey: { type: "string" },
    competitionKey: { type: "string" },
    competitionLabel: { type: "string" },
    name: { type: "string" },
    crestUrl: { type: ["string", "null"] },
    status: { type: "string", enum: ["live", "today", "news"] },
    primary: { type: "string" },
    stories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // Plain array items (no oneOf — an empty array replaces the old null), but keep every
        // emitted field listed: fast-json-stringify silently DROPS unknown keys outside oneOf,
        // and rejects the whole object inside one — see toPublicHeadline note.
        required: ["title", "url", "publishedAt", "imageUrl"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          publishedAt: { type: "string" },
          imageUrl: { type: ["string", "null"] }
        }
      }
    },
    form: { type: "array", items: { type: "string", enum: ["W", "D", "L"] } },
    // Per-pip hover detail (Ben 2026-07-09). MUST be declared or fast-json-stringify silently
    // drops it on the wire (additionalProperties:false) — the same strip trap resultMatch hit in
    // #885. Optional, so it stays out of `required`.
    formDetail: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["result", "opponentName", "homeAway", "score", "playedAt"],
        properties: {
          result: { type: "string", enum: ["W", "D", "L"] },
          opponentName: { type: "string" },
          homeAway: { type: "string", enum: ["home", "away"] },
          score: { type: "string" },
          playedAt: { type: "string" }
        }
      }
    },
    standing: { type: ["string", "null"] },
    nextMatch: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          // Same oneOf trap as `news` above: a field the service emits but this schema omits
          // makes fast-json-stringify reject the whole object → 500 on /overview (bit us live
          // when opponentCrestUrl shipped in the payload without a schema row, mrawvc48).
          required: ["opponentName", "homeAway", "startsAt"],
          properties: {
            opponentName: { type: "string" },
            homeAway: { type: "string", enum: ["home", "away"] },
            startsAt: { type: "string" },
            opponentCrestUrl: { type: ["string", "null"] }
          }
        }
      ]
    },
    // #885: resultMatch MUST be declared here or fast-json-stringify silently drops it on the
    // wire (additionalProperties:false) — exactly the trap the nextMatch/stories comments flag.
    // PR #867 added the field to the interface + service + FeaturedTeamCard render but not this
    // schema, so the crest+score card degraded to the "L 3–9 vs Blue Jays" text fallback in both
    // prod and dev. Nullable-object oneOf mirrors nextMatch; shape tracks FollowedResultMatch.
    resultMatch: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["opponentName", "opponentCrestUrl", "scoreText"],
          properties: {
            opponentName: { type: "string" },
            opponentCrestUrl: { type: ["string", "null"] },
            scoreText: { type: "string" }
          }
        }
      ]
    },
    todayGameState: { type: "string", enum: ["pre", "final"] },
    lastMatchAt: { type: ["string", "null"] },
    rationale: { type: "string" }
  }
} as const;

const followedLeagueRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["competitionKey", "competitionLabel"],
  properties: {
    competitionKey: { type: "string" },
    competitionLabel: { type: "string" }
  }
} as const;

// Followed-league card (Ben 2026-07-09). Declared in full here — fast-json-stringify silently
// drops any emitted field not in the schema (additionalProperties:false), the strip trap that has
// 500'd/blanked the overview before (nextMatch, resultMatch). `stories` mirrors the team card's
// inline story shape exactly; `results` is the new recent-games block.
const followedLeagueCardSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "competitionKey",
    "competitionLabel",
    "kind",
    "status",
    "logoUrl",
    "stories",
    "results"
  ],
  properties: {
    competitionKey: { type: "string" },
    competitionLabel: { type: "string" },
    kind: { type: "string", enum: ["league", "tournament"] },
    status: { type: "string", enum: ["live", "news"] },
    // Declared or fast-json-stringify silently strips it on the wire (additionalProperties:false).
    logoUrl: { type: ["string", "null"] },
    stories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url", "publishedAt", "imageUrl"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          publishedAt: { type: "string" },
          imageUrl: { type: ["string", "null"] }
        }
      }
    },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line", "startsAt", "state", "detail"],
        properties: {
          line: { type: "string" },
          startsAt: { type: "string" },
          state: { type: "string", enum: ["live", "final"] },
          detail: { type: "string" }
        }
      }
    }
  }
} as const;

const scoreboardGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["competitionKey", "competitionLabel", "games"],
  properties: {
    competitionKey: { type: "string" },
    competitionLabel: { type: "string" },
    games: { type: "array", items: gameSummarySchema }
  }
} as const;

const standingsGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["competitionKey", "competitionLabel", "standingsShape", "sections"],
  properties: {
    competitionKey: { type: "string" },
    competitionLabel: { type: "string" },
    standingsShape: { type: "string", enum: ["table", "groups", "record"] },
    sections: { type: "array", items: standingsSectionSchema }
  }
} as const;

const leagueNewsGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["competitionKey", "competitionLabel", "headlines"],
  properties: {
    competitionKey: { type: "string" },
    competitionLabel: { type: "string" },
    headlines: { type: "array", items: headlineSchema }
  }
} as const;

const gamedayGameSchema = {
  type: "object",
  additionalProperties: false,
  required: ["game", "competitionLabel", "rationale"],
  properties: {
    game: gameSummarySchema,
    competitionLabel: { type: "string" },
    rationale: { type: "string" }
  }
} as const;

const overviewHeroSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "games"],
      properties: {
        mode: { type: "string", enum: ["gameday"] },
        games: { type: "array", items: gamedayGameSchema }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "headline"],
      properties: {
        mode: { type: "string", enum: ["story"] },
        headline: { oneOf: [headlineSchema, { type: "null" }] }
      }
    }
  ]
} as const;

export const sportsOverviewResponseSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: [
        "hero",
        "followed",
        "scoreboard",
        "topStories",
        "leagueNews",
        "standings",
        "followedTeams",
        "followedLeagues",
        "followedLeagueCards",
        "degraded"
      ],
      properties: {
        hero: overviewHeroSchema,
        followed: { type: "array", items: followedTeamCardSchema },
        scoreboard: { type: "array", items: scoreboardGroupSchema },
        topStories: { type: "array", items: headlineSchema },
        leagueNews: { type: "array", items: leagueNewsGroupSchema },
        standings: { type: "array", items: standingsGroupSchema },
        followedTeams: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["competitionKey", "teamKey"],
            properties: {
              competitionKey: { type: "string" },
              teamKey: { type: "string" }
            }
          }
        },
        followedLeagues: { type: "array", items: followedLeagueRefSchema },
        followedLeagueCards: { type: "array", items: followedLeagueCardSchema },
        degraded: { type: "boolean" }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const sportsCatalogResponseSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["competitions", "degraded"],
      properties: {
        // Static catalog data — no per-league teams. Rosters are served lazily by
        // sportsLeagueTeamsResponseSchema / sportsTeamSearchResponseSchema instead (#907).
        competitions: {
          type: "array",
          items: competitionRefSchema
        },
        degraded: { type: "boolean" }
      }
    },
    401: errorResponseSchema
  }
} as const;

/** `GET /api/sports/leagues/:competitionKey/teams` schema (#907) — mirrors sportsStandingsResponseSchema's
 *  params-validated 400 shape (unknown competitionKey rejected by the route, same as /standings). */
export const sportsLeagueTeamsResponseSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["competitionKey"],
    properties: {
      competitionKey: { type: "string", minLength: 1, maxLength: 100 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["teams", "degraded"],
      properties: {
        teams: { type: "array", items: teamRefSchema },
        degraded: { type: "boolean" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

/** `GET /api/sports/teams/search?q=` schema (#907 §4.4). `q` minLength 2 keeps a single
 *  keystroke from firing a query; maxLength 80 is a generous cap against abuse, not a real name
 *  length limit. */
export const sportsTeamSearchResponseSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    required: ["q"],
    properties: {
      q: { type: "string", minLength: 2, maxLength: 80 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["teams", "partial", "degraded"],
      properties: {
        teams: { type: "array", items: teamRefSchema },
        partial: { type: "boolean" },
        degraded: { type: "boolean" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const sportsFollowsResponseSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["follows"],
      properties: {
        follows: { type: "array", items: followDtoSchema }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const sportsStandingsResponseSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    required: ["competitionKey"],
    properties: {
      competitionKey: { type: "string", minLength: 1, maxLength: 100 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["group", "fixtures"],
      properties: {
        group: standingsGroupSchema,
        fixtures: { type: "array", items: gameSummarySchema }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const createSportsFollowRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["competitionKey"],
  properties: {
    competitionKey: { type: "string", minLength: 1, maxLength: 100 },
    teamKey: { type: ["string", "null"], maxLength: 100 }
  }
} as const;

export const createSportsFollowResponseSchema = {
  body: createSportsFollowRequestSchema,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["follow"],
      properties: {
        follow: followDtoSchema
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const deleteSportsFollowResponseSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", format: "uuid" }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: {
        ok: { type: "boolean" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;
