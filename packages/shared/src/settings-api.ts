import { errorResponseSchema } from "./schema-fragments.js";

export interface QuietHoursSettingsDto {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
  readonly timezone: string | null;
}

export interface GetQuietHoursSettingsResponse {
  readonly quietHours: QuietHoursSettingsDto;
}

export interface PutQuietHoursSettingsRequest {
  readonly quietHours: QuietHoursSettingsDto;
}

export type PutQuietHoursSettingsResponse = GetQuietHoursSettingsResponse;

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

export type NotificationSensitivityDto = "quiet" | "balanced" | "proactive";

export interface GetNotificationSensitivityResponse {
  readonly sensitivity: NotificationSensitivityDto;
}

export interface PutNotificationSensitivityRequest {
  readonly sensitivity: NotificationSensitivityDto;
}

export type PutNotificationSensitivityResponse = GetNotificationSensitivityResponse;

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

export const getQuietHoursSettingsRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["quietHours"],
      properties: { quietHours: quietHoursSchema }
    },
    401: errorResponseSchema
  }
} as const;

export const putQuietHoursSettingsRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["quietHours"],
    properties: { quietHours: quietHoursSchema }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["quietHours"],
      properties: { quietHours: quietHoursSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
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

const notificationSensitivityResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sensitivity"],
  properties: { sensitivity: { type: "string", enum: ["quiet", "balanced", "proactive"] } }
} as const;

export const getNotificationSensitivityRouteSchema = {
  response: { 200: notificationSensitivityResponseSchema, 401: errorResponseSchema }
} as const;

export const putNotificationSensitivityRouteSchema = {
  body: notificationSensitivityResponseSchema,
  response: {
    200: notificationSensitivityResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;
