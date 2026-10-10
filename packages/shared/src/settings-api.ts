import { errorResponseSchema } from "./schema-fragments.js";

export interface QuietHoursSettingsDto {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
  readonly timezone: string | null;
}

/**
 * Which record governs quiet hours. "conflict" means Profile and the older alert schedule
 * disagree; each consumer keeps its own schedule until the owner chooses, and `alerts` shows the
 * alert one. "malformed" means a saved record cannot be read and is left untouched.
 */
export interface QuietHoursAuthorityDto {
  readonly status: "default" | "carried" | "canonical" | "conflict" | "malformed";
  readonly alerts: {
    readonly enabled: boolean;
    readonly start: string;
    readonly end: string;
  } | null;
}

export interface GetQuietHoursSettingsResponse {
  readonly quietHours: QuietHoursSettingsDto;
  readonly authority: QuietHoursAuthorityDto;
  /** Opaque write expectation for the saved row; null when nothing is saved yet. */
  readonly version: string | null;
}

export interface PutQuietHoursSettingsRequest {
  readonly quietHours: QuietHoursSettingsDto;
  /** The version the caller last read; a mismatch is refused with 409. */
  readonly expectedVersion: string | null;
}

export type PutQuietHoursSettingsResponse = GetQuietHoursSettingsResponse;

/** The owner's explicit pick between two differing saved schedules. */
export interface ResolveQuietHoursConflictRequest {
  /** "profile" keeps Profile's own schedule; "alerts" adopts the older alert schedule. */
  readonly choice: "profile" | "alerts";

  /** The chosen schedule as the owner saw it; a different current value is refused with 409. */
  readonly quietHours: QuietHoursSettingsDto;
  readonly expectedVersion: string | null;
}

export type ResolveQuietHoursConflictResponse = GetQuietHoursSettingsResponse;

export interface NotificationPreferenceDto {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly enabled: boolean;
}

export interface ListNotificationPreferencesResponse {
  readonly preferences: readonly NotificationPreferenceDto[];
}

export interface PutNotificationPreferenceRequest {
  readonly enabled: boolean;
  readonly clearUnread?: boolean;
}

export interface PutNotificationPreferenceResponse {
  readonly preference: NotificationPreferenceDto;
  readonly unreadCount: number | null;
}

export type NotificationDigestCadenceDto = "daily" | "weekly";
export type NotificationDigestUnavailableReason = "no_email_connector" | "no_enabled_modules";

export interface NotificationDigestScheduleMetadataDto {
  readonly targetTime: string;
  readonly timezone: string;
  readonly dayOfWeek?: number;
}

export interface NotificationDigestPreferenceDto {
  readonly enabled: boolean;
  readonly cadence: NotificationDigestCadenceDto;
  readonly scheduleMetadata: NotificationDigestScheduleMetadataDto;
  readonly available: boolean;
  readonly unavailableReason: NotificationDigestUnavailableReason | null;
}

export interface GetNotificationDigestPreferenceResponse {
  readonly digest: NotificationDigestPreferenceDto;
}

export interface PutNotificationDigestPreferenceRequest {
  readonly digest: {
    readonly enabled: boolean;
    readonly cadence: NotificationDigestCadenceDto;
    readonly scheduleMetadata: NotificationDigestScheduleMetadataDto;
  };
}

export type PutNotificationDigestPreferenceResponse = GetNotificationDigestPreferenceResponse;

const quietHoursSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "start", "end", "timezone"],
  properties: {
    enabled: { type: "boolean" },
    start: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    end: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    timezone: { type: ["string", "null"], maxLength: 100 }
  }
} as const;

const quietHoursVersionSchema = { type: ["string", "null"], maxLength: 64 } as const;

const localTimeSchema = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" } as const;

const quietHoursAuthoritySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "alerts"],
  properties: {
    status: { type: "string", enum: ["default", "carried", "canonical", "conflict", "malformed"] },
    alerts: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["enabled", "start", "end"],
      properties: { enabled: { type: "boolean" }, start: localTimeSchema, end: localTimeSchema }
    }
  }
} as const;

const quietHoursResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["quietHours", "authority", "version"],
  properties: {
    quietHours: quietHoursSchema,
    authority: quietHoursAuthoritySchema,
    version: quietHoursVersionSchema
  }
} as const;

export const getQuietHoursSettingsRouteSchema = {
  response: {
    200: quietHoursResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const putQuietHoursSettingsRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["quietHours", "expectedVersion"],
    properties: { quietHours: quietHoursSchema, expectedVersion: quietHoursVersionSchema }
  },
  response: {
    200: quietHoursResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

export const resolveQuietHoursConflictRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["choice", "quietHours", "expectedVersion"],
    properties: {
      choice: { type: "string", enum: ["profile", "alerts"] },
      quietHours: quietHoursSchema,
      expectedVersion: quietHoursVersionSchema
    }
  },
  response: {
    200: quietHoursResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

const notificationPreferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["moduleId", "moduleName", "enabled"],
  properties: {
    moduleId: { type: "string" },
    moduleName: { type: "string" },
    enabled: { type: "boolean" }
  }
} as const;

export const listNotificationPreferencesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["preferences"],
      properties: {
        preferences: {
          type: "array",
          items: notificationPreferenceSchema
        }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const putNotificationPreferenceRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["moduleId"],
    properties: { moduleId: { type: "string" } }
  },
  body: {
    type: "object",
    additionalProperties: false,
    required: ["enabled"],
    properties: {
      enabled: { type: "boolean" },
      clearUnread: { type: "boolean" }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["preference", "unreadCount"],
      properties: {
        preference: notificationPreferenceSchema,
        unreadCount: {
          anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }]
        }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    422: errorResponseSchema
  }
} as const;

const notificationDigestScheduleMetadataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetTime", "timezone"],
  properties: {
    targetTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    timezone: { type: "string", minLength: 1, maxLength: 100 },
    dayOfWeek: { type: "integer", minimum: 0, maximum: 6 }
  }
} as const;

const notificationDigestPreferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "cadence", "scheduleMetadata", "available", "unavailableReason"],
  properties: {
    enabled: { type: "boolean" },
    cadence: { type: "string", enum: ["daily", "weekly"] },
    scheduleMetadata: notificationDigestScheduleMetadataSchema,
    available: { type: "boolean" },
    unavailableReason: {
      anyOf: [
        { type: "string", enum: ["no_email_connector", "no_enabled_modules"] },
        { type: "null" }
      ]
    }
  }
} as const;

export const getNotificationDigestPreferenceRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["digest"],
      properties: { digest: notificationDigestPreferenceSchema }
    },
    401: errorResponseSchema
  }
} as const;

export const putNotificationDigestPreferenceRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["digest"],
    properties: {
      digest: {
        type: "object",
        additionalProperties: false,
        required: ["enabled", "cadence", "scheduleMetadata"],
        properties: {
          enabled: { type: "boolean" },
          cadence: { type: "string", enum: ["daily", "weekly"] },
          scheduleMetadata: notificationDigestScheduleMetadataSchema
        }
      }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["digest"],
      properties: { digest: notificationDigestPreferenceSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    422: errorResponseSchema
  }
} as const;
