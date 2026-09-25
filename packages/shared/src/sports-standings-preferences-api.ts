// The sports standings preferences carry two owner-only facts:
//  - selectedCompetitionKeys: which competitions the standings picker may show (null = all).
//  - lastViewed: the competition and inner view the viewer last looked at, so the picker can
//    reopen it next time on any device (#2661). null = never picked.
export interface SportsStandingsLastViewed {
  readonly competitionKey: string;
  // The inner view (a division/group/conference key from the rail) the viewer last picked.
  // Null means the competition's own default view. Both are remembered best-effort: an inner
  // view that no longer exists falls back to the default quietly.
  readonly viewKey: string | null;
  readonly viewLabel: string | null;
}

export interface SportsStandingsPreferencesResponse {
  readonly selectedCompetitionKeys: readonly string[] | null;
  readonly lastViewed: SportsStandingsLastViewed | null;
}

export interface UpdateSportsStandingsPreferencesRequest {
  // Both fields are optional, but at least one must be present. Sending only
  // selectedCompetitionKeys leaves lastViewed untouched, and the other way round, so the
  // settings pane and the standings rail never clobber each other's value.
  readonly selectedCompetitionKeys?: readonly string[];
  readonly lastViewed?: SportsStandingsLastViewed | null;
}

const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: { message: { type: "string" } }
} as const;

const nullableStringSchema = {
  anyOf: [{ type: "string" }, { type: "null" }]
} as const;

const lastViewedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["competitionKey", "viewKey", "viewLabel"],
  properties: {
    competitionKey: { type: "string", minLength: 1, maxLength: 100 },
    viewKey: nullableStringSchema,
    viewLabel: nullableStringSchema
  }
} as const;

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selectedCompetitionKeys", "lastViewed"],
  properties: {
    selectedCompetitionKeys: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }]
    },
    lastViewed: { anyOf: [lastViewedSchema, { type: "null" }] }
  }
} as const;

export const sportsStandingsPreferencesResponseSchema = {
  response: { 200: responseSchema, 401: errorResponseSchema }
} as const;

export const updateSportsStandingsPreferencesSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      selectedCompetitionKeys: {
        type: "array",
        maxItems: 64,
        uniqueItems: true,
        items: { type: "string" }
      },
      lastViewed: { anyOf: [lastViewedSchema, { type: "null" }] }
    }
  },
  response: { 200: responseSchema, 400: errorResponseSchema, 401: errorResponseSchema }
} as const;
