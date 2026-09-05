import { nullableStringSchema } from "./schema-fragments.js";

/**
 * A bounded primitive value permitted inside notification metadata.
 * Producers may only emit these JSON primitives; nested objects / arrays are dropped by
 * the projection helper (see `projectNotificationMetadata` in @moss/notifications).
 */
export type NotificationMetadataValue = string | number | boolean | null;

/**
 * Bounded notification metadata: at most 16 keys (matching `^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`),
 * each with a primitive value, total serialized size ≤ 4096 bytes, string values ≤ 256 chars.
 * The runtime projection (input + output) and the DB-level size CHECK (migration 0101)
 * enforce this contract; the schema below declares it honestly to clients.
 */
export type NotificationMetadata = Record<string, NotificationMetadataValue>;

export interface NotificationDto {
  readonly id: string;
  readonly moduleId: string | null;
  readonly actorUserId: string | null;
  readonly recipientUserId: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly metadata: NotificationMetadata;
  readonly readAt: string | null;
  readonly createdAt: string | null;
  // Task 2b (#1283): same-origin path only ("/settings", never an absolute URL) — enforced
  // at write time (worker-rpc-host.ts + NotificationsRepository), not re-validated here.
  // Null for every notification posted before this task, and for any that omit it.
  readonly href: string | null;
}

export interface ListNotificationsResponse {
  readonly notifications: readonly NotificationDto[];
  readonly unreadCount: number;
  // #1285: this module's unread count, keyed by module_id, for the nav badge (rulings-ledger
  // G6 — the badge IS this number, not a new polling channel). Not in the response schema's
  // `required` list below; the client defaults a missing/old-shape response to `{}`.
  readonly unreadByModule: Readonly<Record<string, number>>;
}

export interface MarkNotificationReadResponse {
  readonly notification: NotificationDto;
}

export interface MarkAllNotificationsReadResponse {
  readonly unreadCount: number;
}

const metadataSchema = {
  type: "object",
  maxProperties: 16,
  additionalProperties: {
    anyOf: [
      { type: "string", maxLength: 256 },
      { type: "number" },
      { type: "boolean" },
      { type: "null" }
    ]
  },
  propertyNames: { pattern: "^[a-zA-Z_][a-zA-Z0-9_]{0,63}$" }
} as const;

export const notificationParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" }
  }
} as const;

export const notificationDtoSchema = {
  type: "object",
  required: [
    "id",
    "moduleId",
    "actorUserId",
    "recipientUserId",
    "title",
    "body",
    "metadata",
    "readAt",
    "createdAt",
    "href"
  ],
  properties: {
    id: { type: "string" },
    moduleId: nullableStringSchema,
    actorUserId: nullableStringSchema,
    recipientUserId: nullableStringSchema,
    title: { type: "string" },
    body: nullableStringSchema,
    metadata: metadataSchema,
    readAt: nullableStringSchema,
    createdAt: nullableStringSchema,
    // Task 2b (#1283): must be declared here, not just on NotificationDto — a response
    // field missing from this schema is silently stripped by fast-json-stringify even
    // though the handler returns it (recurring trap, see #1285's unreadByModule comment
    // above for the same gotcha hitting this file once already).
    href: nullableStringSchema
  }
} as const;

export const listNotificationsResponseSchema = {
  type: "object",
  required: ["notifications", "unreadCount"],
  properties: {
    notifications: {
      type: "array",
      items: notificationDtoSchema
    },
    unreadCount: {
      type: "integer",
      minimum: 0
    },
    // #1285: fast-json-stringify strips any field missing here even if the handler returns
    // it (recurring trap — see agentmemory `fast-json-stringify-schema-strip`). Not required:
    // callers default a missing map to `{}` rather than treating it as a schema violation.
    unreadByModule: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 0 }
    }
  }
} as const;

export const markNotificationReadResponseSchema = {
  type: "object",
  required: ["notification"],
  properties: {
    notification: notificationDtoSchema
  }
} as const;

export const markAllNotificationsReadResponseSchema = {
  type: "object",
  required: ["unreadCount"],
  properties: {
    unreadCount: {
      type: "integer",
      minimum: 0
    }
  }
} as const;

export const listNotificationsRouteSchema = {
  response: {
    200: listNotificationsResponseSchema
  }
} as const;

export const markNotificationReadRouteSchema = {
  params: notificationParamsSchema,
  response: {
    200: markNotificationReadResponseSchema
  }
} as const;

export const markAllNotificationsReadRouteSchema = {
  response: {
    200: markAllNotificationsReadResponseSchema
  }
} as const;

// --- Web push (#743 / #2227) --------------------------------------------------------------

export interface PushDeviceDto {
  readonly id: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly disabledAt: string | null;
}

export interface PushConfigResponse {
  readonly publicKey: string;
  readonly enabledDevices: readonly PushDeviceDto[];
}

export interface RegisterPushSubscriptionRequest {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

export interface RegisterPushSubscriptionResponse {
  readonly device: PushDeviceDto;
}

export interface DeletePushSubscriptionResponse {
  readonly success: boolean;
}

const pushDeviceDtoSchema = {
  type: "object",
  required: ["id", "label", "createdAt", "lastUsedAt", "disabledAt"],
  properties: {
    id: { type: "string" },
    label: nullableStringSchema,
    createdAt: { type: "string" },
    lastUsedAt: nullableStringSchema,
    disabledAt: nullableStringSchema
  }
} as const;

export const pushConfigResponseSchema = {
  type: "object",
  required: ["publicKey", "enabledDevices"],
  properties: {
    publicKey: { type: "string" },
    enabledDevices: {
      type: "array",
      items: pushDeviceDtoSchema
    }
  }
} as const;

/**
 * Push delivery addresses must be https URLs (the browser only hands out those) and the
 * server refuses anything else before it ever stores or contacts the address. The key
 * lengths are fixed by the Web Push encryption spec: a 65-byte uncompressed P-256 point
 * (87 base64url characters) and a 16-byte auth secret (22 characters).
 */
export const PUSH_ENDPOINT_MIN_LENGTH = 12;
export const PUSH_ENDPOINT_MAX_LENGTH = 2048;
export const PUSH_ENDPOINT_PATTERN = "^https://";
export const PUSH_P256DH_PATTERN = "^[A-Za-z0-9_-]{87}=?$";
export const PUSH_AUTH_PATTERN = "^[A-Za-z0-9_-]{22}(==)?$";

export const registerPushSubscriptionRequestSchema = {
  type: "object",
  required: ["endpoint", "keys"],
  properties: {
    endpoint: {
      type: "string",
      minLength: PUSH_ENDPOINT_MIN_LENGTH,
      maxLength: PUSH_ENDPOINT_MAX_LENGTH,
      pattern: PUSH_ENDPOINT_PATTERN
    },
    keys: {
      type: "object",
      required: ["p256dh", "auth"],
      properties: {
        p256dh: { type: "string", pattern: PUSH_P256DH_PATTERN },
        auth: { type: "string", pattern: PUSH_AUTH_PATTERN }
      }
    }
  }
} as const;

export const registerPushSubscriptionResponseSchema = {
  type: "object",
  required: ["device"],
  properties: {
    device: pushDeviceDtoSchema
  }
} as const;

export const deletePushSubscriptionResponseSchema = {
  type: "object",
  required: ["success"],
  properties: {
    success: { type: "boolean" }
  }
} as const;

export const pushSubscriptionParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" }
  }
} as const;

export const pushConfigRouteSchema = {
  response: {
    200: pushConfigResponseSchema
  }
} as const;

export const registerPushSubscriptionRouteSchema = {
  body: registerPushSubscriptionRequestSchema,
  response: {
    200: registerPushSubscriptionResponseSchema
  }
} as const;

export const deletePushSubscriptionRouteSchema = {
  params: pushSubscriptionParamsSchema,
  response: {
    200: deletePushSubscriptionResponseSchema
  }
} as const;
