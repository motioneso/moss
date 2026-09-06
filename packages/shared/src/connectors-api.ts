import { errorResponseSchema, jsonObjectSchema } from "./schema-fragments.js";

export type ConnectorProviderType = "calendar" | "email" | "google" | "imap";
export type ConnectorProviderStatus = "available" | "disabled";
export type ConnectorAccountStatus = "active" | "error" | "revoked";
export type ConnectorSyncStatus = "success" | "partial" | "failed";

/**
 * Why this run set email messages aside for the assistant to catch up on later. A small
 * fixed set of codes, never a provider message: the human sentence for each one lives in
 * `connector-sync-explain.ts` so the words stay in one place.
 */
export type ConnectorSyncDeferredReason =
  | "assistant-login-expired"
  | "assistant-unavailable"
  | "structured-output";

/**
 * Aggregate-only sync counts surfaced to owners/admins. Never carries per-item
 * detail (subjects, titles, external IDs) — just bounded tallies for health display.
 */
export interface ConnectorSyncCounts {
  readonly calendarUpserted?: number;
  readonly calendarReconciled?: number;
  readonly emailUpserted?: number;
  readonly emailFailures?: number;
  readonly escalations?: number;
  readonly truncated?: boolean;
  /**
   * How many email messages Google sync set aside for a later retry this run (never more
   * than emailUpserted). Distinct from emailFailures, which is a permanent per-message error.
   */
  readonly emailDeferred?: number;
  /**
   * Why those messages were set aside, as a fixed code. Null (or absent) when nothing was
   * deferred. Never carries a provider message, prompt, or any message content.
   */
  readonly deferredReason?: ConnectorSyncDeferredReason | null;
}

export interface ConnectorProviderDto {
  readonly id: string;
  readonly providerType: ConnectorProviderType;
  readonly displayName: string;
  readonly status: ConnectorProviderStatus;
  readonly defaultScopes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectorAccountDto {
  readonly id: string;
  readonly providerId: string;
  readonly providerType: ConnectorProviderType;
  readonly providerDisplayName: string;
  readonly providerStatus: ConnectorProviderStatus;
  readonly ownerUserId: string;
  readonly scopes: readonly string[];
  readonly status: ConnectorAccountStatus;
  readonly hasSecret: boolean;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSyncStartedAt: string | null;
  readonly lastSyncFinishedAt: string | null;
  readonly lastSyncStatus: ConnectorSyncStatus | null;
  readonly lastSyncError: string | null;
  readonly lastSyncCounts: ConnectorSyncCounts | null;
}

export interface ListConnectorProvidersResponse {
  readonly providers: readonly ConnectorProviderDto[];
}

export interface ListConnectorAccountsResponse {
  readonly accounts: readonly ConnectorAccountDto[];
}

export interface CreateConnectorAccountRequest {
  readonly providerId: string;
  readonly scopes?: readonly string[];
  readonly status?: Exclude<ConnectorAccountStatus, "revoked">;
  readonly tokenPayload: Record<string, unknown>;
}

export interface CreateConnectorAccountResponse {
  readonly account: ConnectorAccountDto;
}

export interface UpdateConnectorAccountRequest {
  readonly scopes?: readonly string[];
  readonly status?: Exclude<ConnectorAccountStatus, "revoked">;
  readonly tokenPayload?: Record<string, unknown>;
}

export interface UpdateConnectorAccountResponse {
  readonly account: ConnectorAccountDto;
}

export interface RevokeConnectorAccountResponse {
  readonly account: ConnectorAccountDto;
}

export interface FeatureGrantsResponse {
  readonly email: boolean;
  readonly calendar: boolean;
}

export interface UpdateFeatureGrantsRequest {
  readonly email?: boolean;
  readonly calendar?: boolean;
}

export interface ListAdminConnectorAccountsResponse {
  readonly accounts: readonly ConnectorAccountDto[];
}

const connectorProviderSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "providerType",
    "displayName",
    "status",
    "defaultScopes",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    providerType: { type: "string", enum: ["calendar", "email", "google", "imap"] },
    displayName: { type: "string" },
    status: { type: "string", enum: ["available", "disabled"] },
    defaultScopes: { type: "array", items: { type: "string" } },
    createdAt: { type: "string" },
    updatedAt: { type: "string" }
  }
} as const;

// Aggregate-only counts. `additionalProperties: false` makes Fastify response
// serialization strip any unexpected key, so per-item detail can never ride along
// even if a future writer over-populates the JSON column.
const connectorSyncCountsSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    calendarUpserted: { type: "number" },
    calendarReconciled: { type: "number" },
    emailUpserted: { type: "number" },
    emailFailures: { type: "number" },
    escalations: { type: "number" },
    truncated: { type: "boolean" },
    emailDeferred: { type: "number" }
  }
} as const;

const connectorAccountSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "providerId",
    "providerType",
    "providerDisplayName",
    "providerStatus",
    "ownerUserId",
    "scopes",
    "status",
    "hasSecret",
    "revokedAt",
    "createdAt",
    "updatedAt",
    "lastSyncStartedAt",
    "lastSyncFinishedAt",
    "lastSyncStatus",
    "lastSyncError",
    "lastSyncCounts"
  ],
  properties: {
    id: { type: "string" },
    providerId: { type: "string" },
    providerType: { type: "string", enum: ["calendar", "email", "google", "imap"] },
    providerDisplayName: { type: "string" },
    providerStatus: { type: "string", enum: ["available", "disabled"] },
    ownerUserId: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["active", "error", "revoked"] },
    hasSecret: { type: "boolean" },
    revokedAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    lastSyncStartedAt: { type: ["string", "null"] },
    lastSyncFinishedAt: { type: ["string", "null"] },
    lastSyncStatus: { type: ["string", "null"], enum: ["success", "partial", "failed", null] },
    lastSyncError: { type: ["string", "null"] },
    lastSyncCounts: connectorSyncCountsSchema
  }
} as const;

export const createConnectorAccountRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerId", "tokenPayload"],
  properties: {
    providerId: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["active", "error"] },
    tokenPayload: jsonObjectSchema
  }
} as const;

export const updateConnectorAccountRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scopes: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["active", "error"] },
    tokenPayload: jsonObjectSchema
  }
} as const;

export const listConnectorProvidersResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providers"],
  properties: {
    providers: { type: "array", items: connectorProviderSchema }
  }
} as const;

export const listConnectorAccountsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accounts"],
  properties: {
    accounts: { type: "array", items: connectorAccountSchema }
  }
} as const;

export const createConnectorAccountResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["account"],
  properties: {
    account: connectorAccountSchema
  }
} as const;

export const updateConnectorAccountResponseSchema = createConnectorAccountResponseSchema;
export const revokeConnectorAccountResponseSchema = createConnectorAccountResponseSchema;
export const listAdminConnectorAccountsResponseSchema = listConnectorAccountsResponseSchema;

export const featureGrantsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "calendar"],
  properties: {
    email: { type: "boolean" },
    calendar: { type: "boolean" }
  }
} as const;

export const updateFeatureGrantsRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    email: { type: "boolean" },
    calendar: { type: "boolean" }
  }
} as const;

export const listConnectorProvidersRouteSchema = {
  response: {
    200: listConnectorProvidersResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const listConnectorAccountsRouteSchema = {
  response: {
    200: listConnectorAccountsResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const createConnectorAccountRouteSchema = {
  body: createConnectorAccountRequestSchema,
  response: {
    201: createConnectorAccountResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const updateConnectorAccountRouteSchema = {
  body: updateConnectorAccountRequestSchema,
  response: {
    200: updateConnectorAccountResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const revokeConnectorAccountRouteSchema = {
  response: {
    200: revokeConnectorAccountResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const getFeatureGrantsRouteSchema = {
  response: {
    200: featureGrantsResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const putFeatureGrantsRouteSchema = {
  body: updateFeatureGrantsRequestSchema,
  response: {
    200: featureGrantsResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const listAdminConnectorAccountsRouteSchema = {
  response: {
    200: listAdminConnectorAccountsResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export interface GoogleAuthorizeRequest {
  clientId: string;
  clientSecret: string;
}

export interface GoogleAuthorizeResponse {
  authUrl: string;
}

export interface GoogleCompleteRequest {
  redirectUrl: string;
}

export interface GoogleCompleteResponse {
  account: ConnectorAccountDto;
}

export const googleAuthorizeRequestSchema = {
  type: "object",
  required: ["clientId", "clientSecret"],
  additionalProperties: false,
  properties: {
    clientId: { type: "string", minLength: 1 },
    clientSecret: { type: "string", minLength: 1 }
  }
} as const;

export const googleAuthorizeResponseSchema = {
  type: "object",
  required: ["authUrl"],
  properties: { authUrl: { type: "string" } }
} as const;

export const googleCompleteRequestSchema = {
  type: "object",
  required: ["redirectUrl"],
  additionalProperties: false,
  properties: { redirectUrl: { type: "string", minLength: 1 } }
} as const;

export const googleAuthorizeRouteSchema = {
  body: googleAuthorizeRequestSchema,
  response: { 200: googleAuthorizeResponseSchema }
} as const;

export const googleCompleteRouteSchema = {
  body: googleCompleteRequestSchema,
  response: { 201: createConnectorAccountResponseSchema }
} as const;

export interface ImapConnectRequest {
  readonly providerId: string;
  readonly username: string;
  readonly password: string;
}

export interface ImapTestResult {
  readonly result: "ok" | "auth_failed" | "tls_failed" | "unreachable";
}

export const imapConnectRequestSchema = {
  type: "object",
  required: ["providerId", "username", "password"],
  additionalProperties: false,
  properties: {
    providerId: {
      type: "string",
      enum: ["imap-yahoo", "imap-proton", "imap-icloud", "imap-fastmail"]
    },
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 }
  }
} as const;

export const imapTestResultSchema = {
  type: "object",
  required: ["result"],
  additionalProperties: false,
  properties: {
    result: { type: "string", enum: ["ok", "auth_failed", "tls_failed", "unreachable"] }
  }
} as const;

export const imapTestRouteSchema = {
  body: imapConnectRequestSchema,
  response: {
    200: imapTestResultSchema,
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const imapConnectRouteSchema = {
  body: imapConnectRequestSchema,
  response: {
    201: createConnectorAccountResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export interface GoogleSyncResponse {
  /** True when a new job was enqueued; false when an in-flight sync already covers this actor. */
  readonly enqueued: boolean;
  /** True when this request was collapsed into an already-queued/running sync (singletonKey hit). */
  readonly deduped: boolean;
  readonly jobId: string | null;
}

export interface GmailLiveMessageSummaryDto {
  readonly id: string;
  readonly threadId: string | null;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly snippet: string | null;
  readonly receivedAt: string;
  readonly labelIds: readonly string[];
}

export interface GmailSearchLiveResponse {
  readonly messages: readonly GmailLiveMessageSummaryDto[];
  readonly skipped: number;
}

export interface GmailGetLiveMessageResponse {
  readonly message: GmailLiveMessageSummaryDto & { readonly bodyText: string };
}

export interface CalendarLiveEventDto {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location: string | null;
  readonly htmlLink: string | null;
  readonly status: string | null;
  readonly attendeeCount: number;
}

export interface CalendarListLiveEventsResponse {
  readonly events: readonly CalendarLiveEventDto[];
}

export const googleSyncResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enqueued", "deduped", "jobId"],
  properties: {
    enqueued: { type: "boolean" },
    deduped: { type: "boolean" },
    jobId: { type: ["string", "null"] }
  }
} as const;

export const googleSyncRouteSchema = {
  response: { 202: googleSyncResponseSchema }
} as const;

export const gmailSearchLiveInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string" },
    limit: { type: "number" }
  }
} as const;

export const gmailGetLiveMessageInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 }
  }
} as const;

export const calendarListLiveEventsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    timeMin: { type: "string" },
    timeMax: { type: "string" },
    limit: { type: "number" }
  }
} as const;

const gmailLiveMessageSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "threadId", "from", "to", "subject", "snippet", "receivedAt", "labelIds"],
  properties: {
    id: { type: "string" },
    threadId: { type: ["string", "null"] },
    from: { type: "string" },
    to: { type: "array", items: { type: "string" } },
    subject: { type: "string" },
    snippet: { type: ["string", "null"] },
    receivedAt: { type: "string" },
    labelIds: { type: "array", items: { type: "string" } }
  }
} as const;

export const gmailSearchLiveResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["messages", "skipped"],
  properties: {
    messages: { type: "array", items: gmailLiveMessageSummarySchema },
    skipped: { type: "number" }
  }
} as const;

export const gmailGetLiveMessageResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "threadId",
        "from",
        "to",
        "subject",
        "snippet",
        "receivedAt",
        "labelIds",
        "bodyText"
      ],
      properties: {
        id: { type: "string" },
        threadId: { type: ["string", "null"] },
        from: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        snippet: { type: ["string", "null"] },
        receivedAt: { type: "string" },
        labelIds: { type: "array", items: { type: "string" } },
        bodyText: { type: "string" }
      }
    }
  }
} as const;

const calendarLiveEventSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "title",
    "startsAt",
    "endsAt",
    "location",
    "htmlLink",
    "status",
    "attendeeCount"
  ],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    startsAt: { type: "string" },
    endsAt: { type: "string" },
    location: { type: ["string", "null"] },
    htmlLink: { type: ["string", "null"] },
    status: { type: ["string", "null"] },
    attendeeCount: { type: "number" }
  }
} as const;

export const calendarListLiveEventsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: { type: "array", items: calendarLiveEventSchema }
  }
} as const;
