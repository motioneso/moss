/** Public, browser-safe read contracts for immutable Sports match results. */
export interface SportsResultSide {
  id: string;
  name: string;
  crestUrl: string | null;
  score: number | null;
  shootout: number | null;
  aggregate: number | null;
}
export interface SportsCompletedResult {
  id: string;
  sport: string;
  competitionKey: string;
  competition: string;
  startsAt: string;
  status: string;
  home: SportsResultSide;
  away: SportsResultSide;
}
export interface SportsResultQuery {
  teamName?: string;
  competitionKey?: string;
  sourceTeamId?: string;
}
export interface SportsResultCandidate {
  competitionKey: string;
  sourceTeamId: string;
  name: string;
}
export type SportsResultRead =
  | {
      status: "needs_team" | "ambiguous" | "unavailable";
      candidates: SportsResultCandidate[];
      message: string;
    }
  | {
      status: "result" | "empty";
      team: SportsResultCandidate;
      result: SportsCompletedResult | null;
      retrievedAt: string;
      from: string;
      to: string;
      competitions: string[];
      failedCompetitions: string[];
      coverage: string;
    };
export const sportsResultQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    teamName: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Exact team name from the conversation or Sports roster. Do not guess men's or women's."
    },
    competitionKey: {
      type: "string",
      pattern: "^[a-z0-9.-]{1,100}$",
      description:
        "Explicit competition context from the person or Sports catalog. Omit to use follows."
    },
    sourceTeamId: {
      type: "string",
      pattern: "^[0-9]{1,20}$",
      description:
        "Permanent provider team ID from a Sports roster or follow, never an abbreviation or invented ID."
    }
  }
} as const;
const name = { type: "string", minLength: 1, maxLength: 200 } as const;
const nullableScore = {
  anyOf: [{ type: "integer", minimum: 0, maximum: 1000 }, { type: "null" }]
} as const;
const side = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "crestUrl", "score", "shootout", "aggregate"],
  properties: {
    id: name,
    name,
    crestUrl: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
    score: nullableScore,
    shootout: nullableScore,
    aggregate: nullableScore
  }
} as const;
const match = {
  type: "object",
  additionalProperties: false,
  required: ["id", "sport", "competitionKey", "competition", "startsAt", "status", "home", "away"],
  properties: {
    id: name,
    sport: name,
    competitionKey: name,
    competition: name,
    startsAt: name,
    status: name,
    home: side,
    away: side
  }
} as const;
const candidate = {
  type: "object",
  additionalProperties: false,
  required: ["competitionKey", "sourceTeamId", "name"],
  properties: { competitionKey: name, sourceTeamId: name, name }
} as const;
export const sportsResultResponseSchema = {
  querystring: sportsResultQuerySchema,
  response: {
    200: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "candidates", "message"],
          properties: {
            status: { type: "string", enum: ["needs_team", "ambiguous", "unavailable"] },
            candidates: { type: "array", items: candidate },
            message: { type: "string" }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "team",
            "result",
            "retrievedAt",
            "from",
            "to",
            "competitions",
            "failedCompetitions",
            "coverage"
          ],
          properties: {
            status: { type: "string", enum: ["result", "empty"] },
            team: candidate,
            result: { anyOf: [match, { type: "null" }] },
            retrievedAt: name,
            from: name,
            to: name,
            competitions: { type: "array", items: name },
            failedCompetitions: { type: "array", items: name },
            coverage: { type: "string" }
          }
        }
      ]
    }
  }
} as const;
