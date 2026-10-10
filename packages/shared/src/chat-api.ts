import type { AiCapabilityRouteReason, AiConfiguredModelDto, AiModelCapability } from "./ai-api.js";
import type { SourceFreshnessV1 } from "./freshness-types.js";
import type { MeetingChatCoverage } from "./meeting-chat-api.js";
import type { WorkflowApprovalStatusDto } from "./workflows-api.js";
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
  /** Correlates a server approval decision without retaining its input preview. */
  readonly actionRequestId?: string;
  /** Server-owned action title, never model-authored text. */
  readonly summary?: string;
  readonly kind: string;
  readonly text: string;
  readonly id?: string;
  readonly sequence?: number;
  readonly toolName?: string;
  readonly outcome?: "executed" | "denied" | "error" | "allowed";
  readonly toolCallId?: string;
  readonly durationMs?: number;
  readonly decidedBy?: "person" | "policy" | "timeout" | "cancelled";
  readonly reason?: string;
}

export interface ChatThreadDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly title: string;
  readonly incognito: boolean;
  /** Durable drawer destination used when reconnecting after side-chat activity. */
  readonly isMain: boolean;
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
  readonly meetingContext?: MeetingChatCoverage;
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
  /** Elapsed duration of this turn in milliseconds, when available. */
  readonly elapsedMs?: number;
  /** Token usage reported for this turn, when available. */
  readonly usage?: ChatTurnUsageDto;
  /**
   * Task 4.1 (#2901) — present only on a turn the classifier gate handled. Absent on model turns
   * and on all history written before this contract existed.
   */
  readonly origin?: ChatTurnOriginV1;
}

export interface ListChatThreadsResponse {
  readonly threads: readonly ChatThreadDto[];
}

export interface GetChatPrivacyStateResponse {
  readonly incognito: boolean;
  /** The owner-scoped conversation currently selected for this chat surface. */
  readonly threadId?: string;
}

export interface ListChatThreadMessagesResponse {
  readonly messages: readonly ChatMessageDto[];
}

/**
 * Token usage reported for a single chat turn.
 * All counts are optional: providers report what they know, and a provider
 * that reports nothing leaves usage absent.
 */
export interface ChatTurnUsageDto {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
  readonly thoughtTokens?: number;
  readonly totalTokens?: number;
}

/**
 * One row of a rendered chat transcript — the shape the shared `Thread` component reads.
 * Defined here (moved from the web app's chat stream hook) so the shell and every module
 * thread render the same records from one definition.
 */
export type ChatRecordKind =
  | "user"
  | "thinking"
  | "thought"
  | "tool"
  | "result"
  | "approval"
  | "approved"
  | "not_approved"
  | "refusal"
  | "refused"
  | "status"
  | "reply"
  | "error"
  | "action_request"
  | "workflow_approval"
  | "action_result";

/**
 * Rich, server-derived Approve/Deny card preview (email reply recipient/subject/body). Rides the
 * live SSE stream ONLY — the backend never persists it. Mirrors `@moss/module-sdk`
 * ActionRequestPreview; declared locally so the web bundle stays free of node-side deps.
 */
export interface ActionRequestPreview {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** Live, server-derived app action preview; never interpreted as markup. */
export interface ActionRequestDetails {
  readonly presentation?: "human";
  /** Host-owned semantic identity; never derived from title text. */
  readonly approvalKind?: "memory_delete" | "note_delete";
  readonly target: string | null;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
}

export interface TranscriptRecord {
  readonly nativePermission?: true;
  /** Host-marked connected tool; complete arguments are shown verbatim. */
  readonly externalTool?: true;
  readonly exactArguments?: string;
  readonly approvalAvailable?: boolean;
  readonly meetingContext?: MeetingChatCoverage;
  readonly kind: ChatRecordKind;
  readonly text: string;
  readonly id?: string;
  readonly sequence?: number;
  readonly messageId?: string;
  readonly actionRequestId?: string;
  readonly workflowApprovalId?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly summary?: string;
  /** Plain title frozen with a pending server card; absent for native command descriptions. */
  readonly outcomeTitle?: string;
  readonly status?: WorkflowApprovalStatusDto;
  readonly outcome?: "executed" | "denied" | "error" | "allowed";
  readonly decidedBy?: "person" | "policy" | "timeout" | "cancelled";
  readonly reason?: string;
  readonly result?: Record<string, unknown>;
  /** Dot-path tokens into the frontend `queryKeys` object, resolved by app-shell's generic invalidation effect. */
  readonly affectsQueryKeys?: readonly string[];
  /** Module ids whose cached screens became stale after a successful action. */
  readonly affectsModules?: readonly string[];
  readonly answerProvenance?: readonly AnswerSourceSupportCard[];
  readonly answerProvenanceCitedIds?: readonly string[];
  readonly sourceFreshness?: SourceFreshnessV1 | null;
  readonly preview?: ActionRequestPreview;
  readonly details?: ActionRequestDetails;
  readonly outsideContentNotice?: boolean;
  /** Chips shown on a sent user message (optimistic, post-response, and history rows). */
  readonly attachments?: readonly ChatAttachmentDto[];
  /** Elapsed time in milliseconds for the prompt turn (from submit to stop reason). */
  readonly elapsedMs?: number;
  /** Token usage block for the prompt turn. */
  readonly usage?: ChatTurnUsageDto;
  /** Duration of an approval hold in milliseconds, when recorded. */
  readonly durationMs?: number;
}

// Classifier gate, task 1.2 (#2881). The gate is one ADMIN-WIDE switch for the instance, set beside
// the Classifier binding through the existing admin configuration boundary (Ben's ruling 1,
// 2026-10-01). "off" is the missing-value default. The switch is stored as the enum runtime-config
// key `chat.classifier_gate_mode` (packages/settings/src/runtime-config-keys.ts), not per user.
export type ClassifierGateMode = "off" | "shadow" | "on";

export const CLASSIFIER_GATE_MODES: readonly ClassifierGateMode[] = ["off", "shadow", "on"];

export const CLASSIFIER_GATE_MODE_DEFAULT: ClassifierGateMode = "off";

/**
 * The runtime-config key that stores the admin-wide gate switch. Defined here so the settings
 * registry and the web settings row share one literal (task 1.3, #2892).
 */
export const CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY = "chat.classifier_gate_mode";

/**
 * Task 4.1 (#2901) — where a completed assistant turn came from. A turn the classifier gate handled
 * carries this instead of a model execution stamp: the reply was rendered by code from the validated
 * tool result (or a fixed failure string), so no provider/model/usage may be recorded for it. Old
 * and default-model turns have no origin and keep their `executed` metadata.
 */
export interface ChatClassifierGateOriginV1 {
  readonly version: 1;
  readonly kind: "classifier_gate";
  /** Server turn correlation id for the gate decision that produced this turn. */
  readonly decisionId: string;
  readonly moduleId: string | null;
  readonly toolName: string | null;
  readonly outcome: "executed-success" | "executed-failure-or-unknown";
}

/**
 * #3309 — a turn written by code for a relative reminder: the saved or refused request, or the
 * delivered reminder itself. No model ran, so there is no executed provider or usage.
 */
export interface ChatReminderOriginV1 {
  readonly version: 1;
  readonly kind: "reminder";
  readonly event: "saved" | "refused" | "delivered";
  readonly reminderId: string | null;
  /** Set on delivery: true when the reminder arrived more than a minute after it was due. */
  readonly late?: boolean;
}

export type ChatTurnOriginV1 = ChatClassifierGateOriginV1 | ChatReminderOriginV1;

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
  | "meeting"
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
    "isMain",
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
    isMain: { type: "boolean" },
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
    text: { type: "string" },
    id: { type: "string" },
    sequence: { type: "number" },
    actionRequestId: { type: "string" },
    toolName: { type: "string" },
    summary: { type: "string" },
    outcome: { type: "string", enum: ["executed", "denied", "error", "allowed"] },
    toolCallId: { type: "string" },
    durationMs: { type: "number" },
    decidedBy: { type: "string", enum: ["person", "policy", "timeout", "cancelled"] },
    reason: { type: "string" }
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
    answerProvenanceCitedIds: { type: "array", items: { type: "string" } },
    meetingContext: {
      type: "object",
      additionalProperties: false,
      required: [
        "meetingId",
        "selectionId",
        "transcriptRevision",
        "cursor",
        "cutoffMs",
        "throughMs",
        "containsProvisional",
        "omittedSegments"
      ],
      properties: {
        meetingId: { type: "string" },
        selectionId: { type: "string" },
        transcriptRevision: { type: "integer" },
        cursor: { type: "integer" },
        cutoffMs: { type: "integer" },
        throughMs: { anyOf: [{ type: "integer" }, { type: "null" }] },
        containsProvisional: { type: "boolean" },
        omittedSegments: { type: "integer" },
        notesRevision: { type: "integer" },
        notesCharacters: { type: "integer" },
        notesTruncated: { type: "boolean" }
      }
    }
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
    incognito: { type: "boolean" },
    threadId: { type: "string" }
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

/**
 * Temporary classifier shadow report (#2957). Owner-only counts over a day window plus the
 * disagreement rows, newest first. No message text: the numbers answer whether the classifier
 * is doing the job.
 */
export type ClassifierShadowReportRange = 7 | 30 | 90;

export interface ClassifierShadowDisagreementDto {
  readonly id: string;
  readonly createdAt: string;
  /** Lowercased `module.tool` the classifier picked, or null when it named none. */
  readonly classifierTool: string | null;
  /** Lowercased `module.tool` the main model used first, or null when it used none. */
  readonly modelTool: string | null;
  readonly confidence: number | null;
}

export interface ClassifierShadowReportDto {
  readonly days: ClassifierShadowReportRange;
  readonly checked: number;
  readonly pickedTool: number;
  readonly agreed: number;
  readonly comparable: number;
  readonly missedTool: number;
  readonly disagreements: readonly ClassifierShadowDisagreementDto[];
}

export interface GetClassifierShadowReportResponse {
  readonly report: ClassifierShadowReportDto;
}
