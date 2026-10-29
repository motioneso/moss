import { HEARTBEAT_SOURCES, type HeartbeatSource } from "./heartbeat-source-api.js";
import { errorResponseSchema } from "./schema-fragments.js";

export type HeartbeatCadenceMinutes = 30 | 60;

export interface HeartbeatSettings {
  readonly enabled: boolean;
  readonly cadenceMinutes: HeartbeatCadenceMinutes;
  readonly sources: Readonly<Record<HeartbeatSource, boolean>>;
  /** 0 until the first save or check creates the stored record. */
  readonly revision: number;
  readonly origin: "default" | "saved" | "legacy_off";
}

export type HeartbeatOutcomeKind =
  | "never"
  | "quiet"
  | "message"
  | "held_allowance"
  | "degraded"
  | "failed"
  | "off";

export interface HeartbeatStatus {
  readonly lastCheckedAt: string | null;
  readonly nextCheckAt: string | null;
  readonly outcome: HeartbeatOutcomeKind;
  readonly unavailableSources: readonly HeartbeatSource[];
  readonly recent: readonly {
    readonly at: string;
    readonly outcome: HeartbeatOutcomeKind;
    readonly itemCount: number;
  }[];
}

export interface HeartbeatMute {
  readonly id: string;
  readonly label: string;
  readonly scope: "item" | "topic";
  readonly createdAt: string;
}

/** `readable` is false when the stored record fails validation; checks stay on hold then. */
export interface GetHeartbeatSettingsResponse {
  readonly settings: HeartbeatSettings;
  readonly readable: boolean;
}

export interface PutHeartbeatSettingsRequest {
  readonly enabled: boolean;
  readonly cadenceMinutes: HeartbeatCadenceMinutes;
  readonly sources: Readonly<Record<HeartbeatSource, boolean>>;
  readonly expectedRevision: number;
}

export interface PutHeartbeatSettingsResponse {
  readonly settings: HeartbeatSettings;
}

export interface HeartbeatSettingsConflictResponse {
  readonly error: string;
  readonly settings: HeartbeatSettings;
}

export interface GetHeartbeatStatusResponse {
  readonly status: HeartbeatStatus;
}

export interface ListHeartbeatMutesResponse {
  readonly mutes: readonly HeartbeatMute[];
}

export function defaultHeartbeatSources(): Record<HeartbeatSource, boolean> {
  return { calendar: true, tasks: true, memory: true, sports: true, news: true };
}

const sourcesSchema = {
  type: "object",
  additionalProperties: false,
  required: [...HEARTBEAT_SOURCES],
  properties: Object.fromEntries(HEARTBEAT_SOURCES.map((source) => [source, { type: "boolean" }]))
} as const;

const settingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "cadenceMinutes", "sources", "revision", "origin"],
  properties: {
    enabled: { type: "boolean" },
    cadenceMinutes: { type: "integer", enum: [30, 60] },
    sources: sourcesSchema,
    revision: { type: "integer", minimum: 0 },
    origin: { type: "string", enum: ["default", "saved", "legacy_off"] }
  }
} as const;

const outcomeSchema = {
  type: "string",
  enum: ["never", "quiet", "message", "held_allowance", "degraded", "failed", "off"]
} as const;

const nullableTimestampSchema = { anyOf: [{ type: "string" }, { type: "null" }] } as const;

export const getHeartbeatSettingsRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["settings", "readable"],
      properties: { settings: settingsSchema, readable: { type: "boolean" } }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const putHeartbeatSettingsRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["enabled", "cadenceMinutes", "sources", "expectedRevision"],
    properties: {
      enabled: { type: "boolean" },
      cadenceMinutes: { type: "integer", enum: [30, 60] },
      sources: sourcesSchema,
      expectedRevision: { type: "integer", minimum: 0 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["settings"],
      properties: { settings: settingsSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    409: {
      type: "object",
      additionalProperties: false,
      required: ["error", "settings"],
      properties: { error: { type: "string" }, settings: settingsSchema }
    }
  }
} as const;

export const getHeartbeatStatusRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: {
          type: "object",
          additionalProperties: false,
          required: ["lastCheckedAt", "nextCheckAt", "outcome", "unavailableSources", "recent"],
          properties: {
            lastCheckedAt: nullableTimestampSchema,
            nextCheckAt: nullableTimestampSchema,
            outcome: outcomeSchema,
            unavailableSources: {
              type: "array",
              items: { type: "string", enum: [...HEARTBEAT_SOURCES] }
            },
            recent: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["at", "outcome", "itemCount"],
                properties: {
                  at: { type: "string" },
                  outcome: outcomeSchema,
                  itemCount: { type: "integer", minimum: 0 }
                }
              }
            }
          }
        }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const listHeartbeatMutesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["mutes"],
      properties: {
        mutes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label", "scope", "createdAt"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              scope: { type: "string", enum: ["item", "topic"] },
              createdAt: { type: "string" }
            }
          }
        }
      }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const deleteHeartbeatMuteRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } }
    },
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;
