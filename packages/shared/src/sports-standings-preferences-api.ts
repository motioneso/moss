export interface SportsStandingsPreferencesResponse {
  readonly selectedCompetitionKeys: readonly string[] | null;
}

export interface UpdateSportsStandingsPreferencesRequest {
  readonly selectedCompetitionKeys: readonly string[];
}

const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: { message: { type: "string" } }
} as const;

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selectedCompetitionKeys"],
  properties: {
    selectedCompetitionKeys: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }]
    }
  }
} as const;

export const sportsStandingsPreferencesResponseSchema = {
  response: { 200: responseSchema, 401: errorResponseSchema }
} as const;

export const updateSportsStandingsPreferencesSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["selectedCompetitionKeys"],
    properties: {
      selectedCompetitionKeys: {
        type: "array",
        maxItems: 64,
        uniqueItems: true,
        items: { type: "string" }
      }
    }
  },
  response: { 200: responseSchema, 400: errorResponseSchema, 401: errorResponseSchema }
} as const;
