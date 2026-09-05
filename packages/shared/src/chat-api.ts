import type { AiCapabilityRouteReason, AiConfiguredModelDto, AiModelCapability } from "./ai-api.js";
import type { SourceFreshnessV1 } from "./freshness-types.js";
import { errorResponseSchema } from "./schema-fragments.js";

export type { MossError, MossErrorClass } from "@moss/module-sdk/errors";
import type { MossError } from "@moss/module-sdk/errors";

export type ChatMessageRole = "user" | "assistant";
export type ChatMessageStatus = "stored" | "pending" | "blocked" | "no_model" | "working" | "error";

export type ChatSurface = string & { readonly __chatSurface: unique symbol };
export const DEFAULT_CHAT_SURFACE = "drawer" as ChatSurface;

const CHAT_SURFACE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function normalizeChatSurface(value?: unknown): ChatSurface {
  if (value === undefined) return DEFAULT_CHAT_SURFACE;
  if (typeof value !== "string" || !CHAT_SURFACE_PATTERN.test(value)) {
    throw new Error("Invalid chat surface");
  }
  return value as ChatSurface;
}

export interface ChatActivityEventDto {
  readonly kind: string;
  readonly text: string;
  readonly toolName?: string;
  readonly outcome?: "executed" | "denied" | "error" | "allowed";
}

export interface ChatThreadDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly title: string;
  readonly incognito: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When this conversation was last active (a new turn), for ordering and display age. */
  readonly lastActiveAt: string;
  /** First line of the most recent message in the thread, for a list preview. */
  readonly lastMessagePreview: string | null;
}

export interface ChatModelRouteMetadataDto {
  readonly capability: Extract<AiModelCapability, "chat">;
  readonly available: boolean;
  readonly reason: AiCapabilityRouteReason;
  readonly model: AiConfiguredModelDto | null;
}

export interface ChatSelectedToolMetadataDto {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly name: string;
  readonly permissionId: string;
  readonly risk: "read" | "write" | "outbound" | "destructive";
}

/**
 * #1133 — metadata for a file the user attached to a chat turn. Bytes live in the user's
 * vault (`attachments/<id>/blob`), never on the wire in chat DTOs; this is the display
 * metadata persisted on the user message (`tool_metadata.attachments`) and echoed by the
 * upload route. `fileName` is an opaque display string, never a path component.
 */
export interface ChatAttachmentDto {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** #1133 — response of POST /api/chat/attachments (raw-body upload). */
export interface UploadChatAttachmentResponse {
  readonly attachment: ChatAttachmentDto;
}

export interface ChatMessageDto {
  readonly id: string;
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly role: ChatMessageRole;
  readonly status: ChatMessageStatus;
  readonly body: string;
  readonly modelRoute: ChatModelRouteMetadataDto | null;
  readonly tools: readonly ChatSelectedToolMetadataDto[];
  readonly activity: readonly ChatActivityEventDto[];
  readonly sourceFreshness?: SourceFreshnessV1 | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly answerProvenance?: readonly AnswerSourceSupportCard[];
  readonly answerProvenanceCitedIds?: readonly string[];
  /** #1133 — attachments the user sent with this message (user messages only). */
  readonly attachments?: readonly ChatAttachmentDto[];
}

export interface ListChatThreadsResponse {
  readonly threads: readonly ChatThreadDto[];
}

export interface GetChatPrivacyStateResponse {
  readonly incognito: boolean;
}

export interface ListChatThreadMessagesResponse {
  readonly messages: readonly ChatMessageDto[];
}

export type MemoryCorrectionReasonDto = "rejected" | "corrected";
export type MemoryCorrectionSourceDto = "chat" | "pattern-reject";

export interface MemoryCorrectionDto {
  readonly id: string;
  readonly category: string;
  readonly content: string;
  readonly reason: MemoryCorrectionReasonDto;
  readonly source: MemoryCorrectionSourceDto;
  readonly factId: string | null;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
  readonly createdAt: string;
}

export interface ListMemoryCorrectionsResponse {
  readonly corrections: readonly MemoryCorrectionDto[];
}

export interface CreateChatThreadRequest {
  readonly title: string;
}

export interface AppendChatUserMessageRequest {
  readonly body: string;
  readonly selectedToolNames?: readonly string[];
}

export interface SendChatTurnResponse {
  readonly reply: string;
  readonly userMessageId?: string;
  readonly assistantMessageId?: string;
  readonly sourceFreshness?: SourceFreshnessV1 | null;
}

/**
 * #679 — a bounded, redacted snapshot of what the user currently sees in the web app,
 * captured client-side and attached to a chat turn ONLY when the user's message appears
 * to ask about the current page. Never persisted: it is folded into the hidden
 * engine-bound context for the single turn it arrives with (see
 * ChatSessionManager.engineText) and is never written to `userText`/`recordTurn`, never
 * queued in a pg-boss payload, and never reaches memory extraction. The client never
 * captures raw input/textarea VALUES, and skips password fields and other sensitive-
 * autocomplete fields entirely (see apps/web/src/chat/page-context.ts).
 */
export interface PageContextFocusedElementDto {
  readonly tag: string;
  readonly role: string | null;
  readonly label: string | null;
}

export interface PageContextSnapshotDto {
  readonly route: string;
  readonly pageTitle: string;
  readonly headings: readonly string[];
  readonly buttons: readonly string[];
  readonly labels: readonly string[];
  readonly visibleText: readonly string[];
  readonly focused: PageContextFocusedElementDto | null;
  readonly selectedText: string | null;
  readonly errors: readonly MossError[];
  readonly capturedAt: string;
}

export interface SendChatTurnRequest {
  readonly text: string;
  /** #1133 — ids of previously uploaded attachments to include with this turn (max 5). */
  readonly attachmentIds?: readonly string[];
  readonly surface?: ChatSurface;
}

// #1284 — shared by the client (apps/web/src/api/client.ts's seedChat) and the server
// (packages/chat/src/live-routes.ts's body validation) so the two never drift apart.
export const CHAT_SEED_MAX_LENGTH = 8000;
export const CHAT_SEED_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * #1284 — body of POST /api/chat/seed: frame a surface's thread before the user's first visible
 * turn, with no visible user message. `idempotencyKey` (backed by the server's per-session
 * seededContextKeys) makes a repeat call a no-op, so a component remount can never re-frame a
 * conversation already in progress. Trust boundary: `seed` enters the model's context with exactly
 * the authority of a user turn, no more — it is never treated as a system prompt.
 */
export interface SeedChatRequest {
  readonly seed: string;
  readonly idempotencyKey: string;
  readonly surface?: ChatSurface;
}

/** #1109 — PUT /api/chat/page-context body: the actor's current client-reported view. */
export interface UpdatePageContextRequest {
  readonly snapshot: PageContextSnapshotDto;
}

export interface AppBuildInfo {
  readonly version: string;
  readonly buildId: string;
}

export interface CurrentViewServerFactsDto {
  readonly appVersion: string;
  readonly buildId: string;
  readonly platform: "web";
  readonly modelCapabilities: readonly AiModelCapability[];
}

/** #1109 — output of the `chat.getCurrentView` read tool: the actor's synced page view, if any is
 * on file and unexpired, plus server-authoritative facts the model cannot know on its own
 * (build/version, and what the currently-selected chat model can actually do). */
export interface CurrentViewSnapshotDto {
  readonly available: boolean;
  readonly view: PageContextSnapshotDto | null;
  readonly serverFacts: CurrentViewServerFactsDto;
}

export type AnswerProvenanceSourceKind =
  | "memory"
  | "note"
  | "email"
  | "calendar"
  | "task"
  | "commitment"
  | "person"
  | "goal"
  | "briefing";

export type AnswerProvenanceState =
  | "confirmed_source"
  | "inferred_memory"
  | "pending_candidate"
  | "ambiguous_identity"
  | "unverified_context";

export interface AnswerSourceSupport {
  readonly supportId: string;
  readonly sourceKind: AnswerProvenanceSourceKind;
  readonly sourceLabel: string;
  readonly title: string;
  readonly snippet?: string;
  readonly state: AnswerProvenanceState;
  readonly confidence?: number;
  readonly confidenceTier?: "confirmed" | "high" | "medium" | "low";
  readonly provenance?: "volunteered" | "inferred" | "confirmed" | "imported" | "source";
  readonly occurredAt?: string;
  readonly citationToken?: string;
  readonly canDereference: boolean;
}

export interface AnswerSourceSupportCard {
  readonly supportId: string;
  readonly sourceKind: AnswerProvenanceSourceKind;
  readonly sourceLabel: string;
  readonly title: string;
  readonly snippet?: string;
  readonly state: AnswerProvenanceState;
  readonly confidence?: number;
  readonly confidenceTier?: "confirmed" | "high" | "medium" | "low";
  readonly provenance?: "volunteered" | "inferred" | "confirmed" | "imported" | "source";
  readonly occurredAt?: string;
  readonly canDereference: boolean;
}

export interface AnswerProvenanceMetadataV1 {
  readonly version: 1;
  readonly citedSupportIds: readonly string[];
  readonly supportItems: readonly AnswerSourceSupport[];
  readonly contextCheckedCount: number;
  readonly omittedCount: number;
}

export interface AnswerProvenanceProvider {
  readonly sourceKind: AnswerProvenanceSourceKind;
  verifySupport(
    scopedDb: unknown,
    input: { readonly ownerUserId: string; readonly citationToken: string }
  ): Promise<AnswerSourceSupport | null>;
  dereferenceSupport(
    scopedDb: unknown,
    input: { readonly ownerUserId: string; readonly citationToken: string }
  ): Promise<AnswerProvenanceDereference | null>;
}

export interface AnswerProvenanceDereference {
  readonly sourceLabel: string;
  readonly title: string;
  readonly snippet?: string;
  readonly deepLinkPath?: string;
  readonly unavailableReason?: "missing" | "permission" | "source_unavailable";
}

const chatThreadSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "ownerUserId",
    "title",
    "incognito",
    "createdAt",
    "updatedAt",
    "lastActiveAt",
    "lastMessagePreview"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    title: { type: "string" },
    incognito: { type: "boolean" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    lastActiveAt: { type: "string" },
    lastMessagePreview: { anyOf: [{ type: "string" }, { type: "null" }] }
  }
} as const;

const chatActivityEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "text"],
  properties: {
    kind: { type: "string" },
    text: { type: "string" }
  }
} as const;

const chatSelectedToolMetadataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["moduleId", "moduleName", "name", "permissionId", "risk"],
  properties: {
    moduleId: { type: "string" },
    moduleName: { type: "string" },
    name: { type: "string" },
    permissionId: { type: "string" },
    risk: { type: "string", enum: ["read", "write", "outbound", "destructive"] }
  }
} as const;

/**
 * #1133 — display metadata for a file attached to a user message. Must stay declared
 * in chatMessageSchema or fast-json-stringify silently strips it from responses.
 */
const chatAttachmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "fileName", "mimeType", "sizeBytes"],
  properties: {
    id: { type: "string" },
    fileName: { type: "string" },
    mimeType: { type: "string" },
    sizeBytes: { type: "number" }
  }
} as const;

const chatModelRouteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["capability", "available", "reason", "model"],
  properties: {
    capability: { type: "string", enum: ["chat"] },
    available: { type: "boolean" },
    reason: { type: "string" },
    model: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] }
  }
} as const;

const chatMessageSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "threadId",
    "ownerUserId",
    "role",
    "status",
    "body",
    "modelRoute",
    "tools",
    "activity",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    ownerUserId: { type: "string" },
    role: { type: "string", enum: ["user", "assistant"] },
    status: {
      type: "string",
      enum: ["stored", "pending", "blocked", "no_model", "working", "error"]
    },
    body: { type: "string" },
    modelRoute: { anyOf: [chatModelRouteSchema, { type: "null" }] },
    tools: { type: "array", items: chatSelectedToolMetadataSchema },
    activity: { type: "array", items: chatActivityEventSchema },
    attachments: { type: "array", items: chatAttachmentSchema },
    sourceFreshness: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["version", "capturedAt", "sources"],
          properties: {
            version: { type: "number" },
            capturedAt: { type: "string" },
            sources: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["source", "freshnessKind", "asOf"],
                properties: {
                  source: { type: "string" },
                  freshnessKind: { type: "string" },
                  asOf: { anyOf: [{ type: "string" }, { type: "null" }] }
                }
              }
            }
          }
        },
        { type: "null" }
      ]
    },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    answerProvenance: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["supportId", "sourceKind", "sourceLabel", "title", "state", "canDereference"],
        properties: {
          supportId: { type: "string" },
          sourceKind: { type: "string" },
          sourceLabel: { type: "string" },
          title: { type: "string" },
          snippet: { type: "string" },
          state: { type: "string" },
          confidence: { type: "number" },
          confidenceTier: { type: "string" },
          provenance: { type: "string" },
          occurredAt: { type: "string" },
          canDereference: { type: "boolean" }
        }
      }
    },
    answerProvenanceCitedIds: { type: "array", items: { type: "string" } }
  }
} as const;

export const listChatThreadsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["threads"],
  properties: {
    threads: { type: "array", items: chatThreadSchema }
  }
} as const;

export const listChatThreadsRouteSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { surface: { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" } }
  },
  response: {
    200: listChatThreadsResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const getChatPrivacyStateResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["incognito"],
  properties: {
    incognito: { type: "boolean" }
  }
} as const;

export const getChatPrivacyStateRouteSchema = {
  response: {
    200: getChatPrivacyStateResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const listChatThreadMessagesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["messages"],
  properties: {
    messages: { type: "array", items: chatMessageSchema }
  }
} as const;

export const listChatThreadMessagesRouteSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { surface: { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$" } }
  },
  response: {
    200: listChatThreadMessagesResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const memoryCorrectionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "category",
    "content",
    "reason",
    "source",
    "factId",
    "beforeContent",
    "afterContent",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    category: { type: "string" },
    content: { type: "string" },
    reason: { type: "string", enum: ["rejected", "corrected"] },
    source: { type: "string", enum: ["chat", "pattern-reject"] },
    factId: { anyOf: [{ type: "string" }, { type: "null" }] },
    beforeContent: { anyOf: [{ type: "string" }, { type: "null" }] },
    afterContent: { anyOf: [{ type: "string" }, { type: "null" }] },
    createdAt: { type: "string" }
  }
} as const;

export const listMemoryCorrectionsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["corrections"],
  properties: {
    corrections: { type: "array", items: memoryCorrectionSchema }
  }
} as const;

export const listMemoryCorrectionsRouteSchema = {
  response: {
    200: listMemoryCorrectionsResponseSchema,
    401: errorResponseSchema
  }
} as const;
