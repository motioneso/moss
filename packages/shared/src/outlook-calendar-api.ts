import { errorResponseSchema, nullableStringSchema } from "./schema-fragments.js";

export type OutlookCalendarState =
  | "collecting"
  | "current"
  | "partial"
  | "stale"
  | "sign-in-needed"
  | "source-changed"
  | "disconnected";
export interface OutlookCalendarStatus {
  readonly available: boolean;
  readonly connected: boolean;
  readonly state: OutlookCalendarState;
  readonly lastCompleteAt: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly unconfirmed: number;
}
export const outlookCalendarStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "available",
    "connected",
    "state",
    "lastCompleteAt",
    "windowStart",
    "windowEnd",
    "unconfirmed"
  ],
  properties: {
    available: { type: "boolean" },
    connected: { type: "boolean" },
    state: {
      type: "string",
      enum: [
        "collecting",
        "current",
        "partial",
        "stale",
        "sign-in-needed",
        "source-changed",
        "disconnected"
      ]
    },
    lastCompleteAt: nullableStringSchema,
    windowStart: nullableStringSchema,
    windowEnd: nullableStringSchema,
    unconfirmed: { type: "integer", minimum: 0 }
  }
} as const;
export const outlookCalendarStatusRouteSchema = {
  tags: ["Connectors"],
  response: { 200: outlookCalendarStatusSchema, 401: errorResponseSchema, 403: errorResponseSchema }
} as const;
export const outlookCalendarActionRouteSchema = {
  ...outlookCalendarStatusRouteSchema,
  body: { type: "object", additionalProperties: false, maxProperties: 0 },
  response: {
    ...outlookCalendarStatusRouteSchema.response,
    400: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;
