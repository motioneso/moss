/**
 * Personal activity lines API (#2956, slice C). Owner-scoped: each person reads their own
 * model-call lines; admins additionally read ownerless System lines (row security enforces
 * both, the route adds no admin check). Each entry carries its recorded detail while that
 * detail is unexpired; older lines arrive bare. Quoted words and step text never outlive the
 * 30-day detail row. No field carries prompts, tool arguments, or raw provider text.
 */

const activityLineStepSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "result"],
  properties: {
    title: { type: "string" },
    result: { type: "string" },
    askedFor: { type: "string" },
    returned: { type: "string" }
  }
} as const;

const activityLineDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["steps", "expiresAt"],
  properties: {
    quote: { type: ["string", "null"] },
    resultLine: { type: ["string", "null"] },
    steps: { type: "array", items: activityLineStepSchema },
    expiresAt: { type: "string" }
  }
} as const;

const activityLineEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "occurredAt", "kind", "action", "outcome", "modelName", "result"],
  properties: {
    id: { type: "string" },
    occurredAt: { type: "string" },
    kind: { type: "string" },
    action: { type: "string" },
    outcome: { type: "string", enum: ["ok", "error", "aborted"] },
    modelName: { type: "string" },
    result: { type: "string" },
    ownerUserId: { type: ["string", "null"] },
    actionCode: { type: ["string", "null"] },
    turnId: { type: ["string", "null"] },
    parentId: { type: ["string", "null"] },
    durationMs: { type: ["integer", "null"] },
    inputTokens: { type: ["integer", "null"] },
    outputTokens: { type: ["integer", "null"] },
    failureCode: { type: ["string", "null"] },
    // Free-form numbers and booleans; the database CHECK is the strict guard. Declared open
    // (not per-key) because fast-json-stringify drops undeclared object properties as {}.
    factCounts: { type: ["object", "null"], additionalProperties: true },
    detail: { ...activityLineDetailSchema, type: ["object", "null"] }
  }
} as const;

export const listActivityLinesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: { type: "array", items: activityLineEntrySchema }
  }
} as const;

export const listActivityLinesRouteSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      /** ISO timestamp: only lines at or after this time. */
      since: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 }
    }
  },
  response: {
    200: listActivityLinesResponseSchema
  }
} as const;

export type ActivityLineStepDto = {
  readonly title: string;
  readonly result: string;
  readonly askedFor?: string;
  readonly returned?: string;
};

export type ActivityLineDetailDto = {
  readonly quote: string | null;
  readonly resultLine: string | null;
  readonly steps: readonly ActivityLineStepDto[];
  readonly expiresAt: string;
};

/** Small numbers and flags only (tools, tools_failed, jev_agreed, confidence, images); never text. */
export type ActivityFactCountsDto = Record<string, number | boolean>;

export type ActivityLineDto = {
  readonly id: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly action: string;
  readonly outcome: "ok" | "error" | "aborted";
  readonly modelName: string;
  readonly result: string;
  readonly ownerUserId: string | null;
  readonly actionCode: string | null;
  readonly turnId: string | null;
  readonly parentId: string | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly failureCode: string | null;
  readonly factCounts: ActivityFactCountsDto | null;
  readonly detail: ActivityLineDetailDto | null;
};

export type ListActivityLinesResponse = {
  readonly entries: readonly ActivityLineDto[];
};
