/**
 * Model activity log API (plan 3.6a, #2889). Read-only, admin-only, instance-wide.
 *
 * Every field is a short plain-text value recorded at the provider-adapter boundary. There is no
 * field for chat text, prompts, tool arguments or secrets, so a response can never carry them.
 */

const modelActivityEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "occurredAt", "kind", "action", "outcome", "modelName", "result"],
  properties: {
    id: { type: "string" },
    occurredAt: { type: "string" },
    kind: { type: "string" },
    action: { type: "string" },
    outcome: { type: "string" },
    modelName: { type: "string" },
    result: { type: "string" }
  }
} as const;

export const listModelActivityResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entries", "nextBefore", "nextBeforeId"],
  properties: {
    entries: { type: "array", items: modelActivityEntrySchema },
    /** Cursor for the next, older page; null when there is no further page. */
    nextBefore: { type: ["string", "null"] },
    /** Tiebreak cursor id for rows sharing the boundary millisecond; null with nextBefore. */
    nextBeforeId: { type: ["string", "null"] }
  }
} as const;

export const listModelActivityRouteSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", maxLength: 64 },
      model: { type: "string", maxLength: 200 },
      result: { type: "string", maxLength: 64 },
      /** ISO timestamp: only rows at or after this time. */
      since: { type: "string" },
      /** ISO timestamp cursor: only rows strictly before this time (older page). */
      before: { type: "string" },
      /** Tiebreak cursor id for rows at exactly `before`. */
      beforeId: { type: "string", format: "uuid", maxLength: 64 },
      limit: { type: "integer", minimum: 1, maximum: 200 }
    }
  },
  response: {
    200: listModelActivityResponseSchema
  }
} as const;

export type ModelActivityEntryDto = {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly action: string;
  readonly outcome: string;
  readonly modelName: string;
  readonly result: string;
};

export type ListModelActivityResponse = {
  readonly entries: readonly ModelActivityEntryDto[];
  readonly nextBefore: string | null;
  readonly nextBeforeId: string | null;
};
