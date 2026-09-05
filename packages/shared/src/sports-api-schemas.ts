// packages/shared/src/sports-api-schemas.ts — BROWSER-SAFE. No node:* imports.
// Fastify route JSON schemas for the sports API. Split out of sports-api.ts, which
// re-exports everything here, so importers are unaffected.
import { errorResponseSchema } from "./schema-fragments.js";

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
  required: ["teamKey", "name", "shortName", "crestUrl", "score", "record", "winner", "scorers"],
  properties: {
    teamKey: { type: "string" },
    name: { type: "string" },
    shortName: { type: "string" },
    crestUrl: { type: ["string", "null"] },
    score: { type: ["number", "null"] },
    record: { type: ["string", "null"] },
    winner: { type: "boolean" },
    scorers: { type: ["array", "null"], items: { type: "string" } }
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
    "sportKey",
    "competitionKey",
    "competitionLabel",
    "title",
    "url",
    "publishedAt",
    "imageUrl",
    "summary",
    "teamKeys",
    "publisherLabel",
    "publisherDomain"
  ],
  properties: {
    id: { type: "string" },
    sportKey: {
      type: "string",
      enum: ["football", "hockey", "soccer", "baseball", "basketball"]
    },
    competitionKey: { type: ["string", "null"] },
    competitionLabel: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    publishedAt: { type: "string" },
    imageUrl: { type: ["string", "null"] },
    summary: { type: "string" },
    teamKeys: { type: "array", items: { type: "string" } },
    publisherLabel: { type: "string" },
    publisherDomain: { type: "string" },
    // Optional (not in `required`) — only the featured story carries it (#857). MUST be listed
    // here even though it's optional: this schema is used inside a oneOf (hero.headline), where
    // fast-json-stringify REJECTS the whole object for any emitted key it doesn't know — the same
    // trap documented on `nextMatch`/`stories` below that has 500'd /overview before.
    body: { type: "string" },
    // Optional for the same reason as `body`, and declared here for the same reason: a field the
    // schema does not know is stripped on the wire, so the story menu would never see a ref
    // (#2019).
    storyRef: { type: "string" }
  }
} as const;

const competitionRefSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "competitionKey",
    "label",
    "sportLabel",
    "regionLabel",
    "kind",
    "marquee",
    "standingsShape",
    "confederation"
  ],
  properties: {
    competitionKey: { type: "string" },
    label: { type: "string" },
    sportLabel: { type: "string" },
    regionLabel: { anyOf: [{ type: "string" }, { type: "null" }] },
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
        required: ["title", "url", "publishedAt", "imageUrl", "publisherLabel", "publisherDomain"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          publishedAt: { type: "string" },
          imageUrl: { type: ["string", "null"] },
          publisherLabel: { type: "string" },
          publisherDomain: { type: "string" },
          // Optional, declared: an undeclared key is silently dropped here (#2019).
          storyRef: { type: "string" }
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
          required: [
            "opponentName",
            "opponentCrestUrl",
            "resultLabel",
            "homeScore",
            "awayScore",
            "homeAway",
            "ownScorers",
            "opponentScorers"
          ],
          properties: {
            opponentName: { type: "string" },
            opponentCrestUrl: { type: ["string", "null"] },
            resultLabel: { type: "string", enum: ["W", "D", "L"] },
            homeScore: { type: "number" },
            awayScore: { type: "number" },
            homeAway: { type: "string", enum: ["home", "away"] },
            ownScorers: { type: ["array", "null"], items: { type: "string" } },
            opponentScorers: { type: ["array", "null"], items: { type: "string" } }
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
          imageUrl: { type: ["string", "null"] },
          // Optional, declared: an undeclared key is silently dropped here (#2019).
          storyRef: { type: "string" }
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

const sportsNewsGroupSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sportKey", "competitionKey", "competitionLabel", "headlines"],
      properties: {
        kind: { type: "string", enum: ["sport"] },
        sportKey: {
          type: "string",
          enum: ["football", "hockey", "soccer", "baseball", "basketball"]
        },
        competitionKey: { type: "null" },
        competitionLabel: { type: "string" },
        headlines: { type: "array", items: headlineSchema }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sportKey", "competitionKey", "competitionLabel", "headlines"],
      properties: {
        kind: { type: "string", enum: ["competition"] },
        sportKey: {
          type: "string",
          enum: ["football", "hockey", "soccer", "baseball", "basketball"]
        },
        competitionKey: { type: "string" },
        competitionLabel: { type: "string" },
        headlines: { type: "array", items: headlineSchema }
      }
    }
  ]
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
        leagueNews: { type: "array", items: sportsNewsGroupSchema },
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
