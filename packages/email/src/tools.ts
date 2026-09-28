import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type {
  ActionRequestPreview,
  ToolContext,
  ToolExecute,
  ToolPreview,
  ToolResult,
  ToolServices
} from "@moss/module-sdk";
import { nullableStringSchema } from "@moss/shared";

import type { EmailWriteService, ReplyInput } from "./email-write-service.js";
import { deriveReplyTarget } from "./reply-mime.js";
import { EmailRepository } from "./repository.js";

const repository = new EmailRepository();

export const emailToolMessageOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "cacheMessageId",
    "connectorAccountId",
    "providerLabel",
    "sender",
    "recipients",
    "subject",
    "receivedAt",
    "threadId",
    "snippet",
    "summary",
    "actionability",
    "importance",
    "confidence",
    "reason",
    "dueDate",
    "suggestedTasks",
    "awaitingJudgement",
    "source",
    "degradedReason"
  ],
  properties: {
    id: { type: "string", description: "Provider message key (live) or cached external id" },
    cacheMessageId: nullableStringSchema,
    connectorAccountId: { type: "string" },
    providerLabel: { type: "string" },
    sender: { type: "string" },
    recipients: { type: "array", items: { type: "string" } },
    subject: { type: "string" },
    receivedAt: { type: "string" },
    threadId: nullableStringSchema,
    snippet: nullableStringSchema,
    summary: nullableStringSchema,
    actionability: {
      type: "string",
      enum: [
        "needs_reply",
        "needs_action",
        "time_sensitive_info",
        "waiting_on_someone",
        "fyi",
        "noise",
        "unknown"
      ]
    },
    importance: { type: "string" },
    confidence: { type: "number" },
    reason: nullableStringSchema,
    dueDate: nullableStringSchema,
    suggestedTasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "dueDate"],
        properties: { title: { type: "string" }, dueDate: nullableStringSchema }
      }
    },
    awaitingJudgement: {
      type: "boolean",
      description: "The sorter handed this message to the Commitments closer look"
    },
    source: { type: "string", enum: ["live", "cache"] },
    degradedReason: nullableStringSchema
  }
} as const;

// Structural interfaces — no @moss/connectors import (module isolation). Shapes mirror
// the connectors SourceContextService email surface.
interface SourceAccountMetaShape {
  readonly connectorAccountId: string;
  readonly providerId: string;
  readonly providerLabel: string;
}

interface EmailContextItemShape {
  readonly messageKey: string;
  readonly account: SourceAccountMetaShape;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly receivedAt: string;
  readonly threadId: string | null;
  readonly snippet: string | null;
  readonly summary: string | null;
  readonly actionability: string;
  readonly importance: string;
  readonly confidence: number;
  readonly reason: string | null;
  readonly dueDate: string | null;
  readonly suggestedTasks: ReadonlyArray<{
    readonly title: string;
    readonly dueDate: string | null;
  }>;
  readonly awaitingJudgement?: boolean;
  readonly source: "live" | "cache";
  readonly degradedReason: string | null;
  readonly cacheMessageId: string | null;
}

interface SourceContextService {
  listEmailContext(
    scopedDb: DataContextDb,
    input: { limitPerAccount?: number }
  ): Promise<{
    items: readonly EmailContextItemShape[];
    accounts: readonly unknown[];
    gaps: readonly unknown[];
  }>;
  listCalendarContext(scopedDb: DataContextDb, input: Record<string, unknown>): Promise<unknown>;
}

function narrowSourceContext(services: ToolServices | undefined): SourceContextService {
  const svc = (services ?? {}).sourceContext as SourceContextService | undefined;
  if (!svc || typeof svc.listEmailContext !== "function") {
    throw new Error("sourceContext service is not available"); // fail closed — never stale direct cache reads
  }
  return svc;
}

/** Explicit field pick — no spread, so a leaked body/bodyExcerpt can never pass through. */
function serializeEmailContextItem(item: EmailContextItemShape) {
  return {
    id: item.messageKey,
    cacheMessageId: item.cacheMessageId,
    connectorAccountId: item.account.connectorAccountId,
    providerLabel: item.account.providerLabel,
    sender: item.sender,
    recipients: item.recipients,
    subject: item.subject,
    receivedAt: item.receivedAt,
    threadId: item.threadId,
    snippet: item.snippet,
    summary: item.summary,
    actionability: item.actionability,
    importance: item.importance,
    confidence: item.confidence,
    reason: item.reason,
    dueDate: item.dueDate,
    suggestedTasks: item.suggestedTasks.map((task) => ({
      title: task.title,
      dueDate: task.dueDate
    })),
    awaitingJudgement: item.awaitingJudgement === true,
    source: item.source,
    degradedReason: item.degradedReason
  };
}

export const emailListVisibleMessagesExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx,
  services
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const sourceContext = narrowSourceContext(services);
  const { items, accounts, gaps } = await sourceContext.listEmailContext(scopedDb, {});
  return { data: { messages: items.map(serializeEmailContextItem), accounts, gaps } };
};

// ── Reply write tools (email.draftReply / email.sendReply) ────────────────────────────────
//
// Tool input is `{ cacheMessageId, body }` ONLY — the model never addresses. The write-impl
// re-derives recipient/subject/threadId from the owner-visible cached email under DataContextDb
// (security floor §5). These tools are thin: narrow the composition-host `emailWrite` service
// and hand it the (validated) input. The composed body rides the live card preview + the Gmail
// call only; it is never persisted (summarize below is deliberately body-free).

// Structural interface — the concrete service is built in the composition host (packages/chat)
// which may import connectors. The email module only knows this shape (module isolation).
function narrowEmailWrite(services: ToolServices | undefined): EmailWriteService {
  const svc = (services ?? {}).emailWrite as EmailWriteService | undefined;
  if (!svc || typeof svc.draftReply !== "function" || typeof svc.sendReply !== "function") {
    throw new Error("emailWrite service is not available");
  }
  return svc;
}

function readReplyInput(input: Record<string, unknown>): ReplyInput {
  return {
    cacheMessageId: typeof input.cacheMessageId === "string" ? input.cacheMessageId : "",
    body: typeof input.body === "string" ? input.body : ""
  };
}

export const emailDraftReplyExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  const service = narrowEmailWrite(services);
  const result = await service.draftReply(scopedDb, ctx, readReplyInput(input));
  return { data: { ...result } };
};

export const emailSendReplyExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  const service = narrowEmailWrite(services);
  const result = await service.sendReply(scopedDb, ctx, readReplyInput(input));
  return { data: { ...result } };
};

// Card fallback lines — NO body, NO recipient interpolation from input (the rich, server-derived
// recipient/subject/body arrives via the async `preview` producer below; this is the text a client
// shows when no preview is present).
export function summarizeDraftReply(_input: Record<string, unknown>, _ctx: ToolContext): string {
  return (
    "Draft a reply to this email? Your assistant addresses it to the original sender on the existing " +
    "thread — the draft lands in Gmail for you to review before it sends."
  );
}

export function summarizeSendReply(_input: Record<string, unknown>, _ctx: ToolContext): string {
  return (
    "Send this reply? Your assistant addresses it to the original sender on the existing thread. " +
    "It sends immediately and can't be undone from Moss."
  );
}

/**
 * Async card-preview producer shared by both reply tools. Derives the recipient/subject from the
 * owner-visible cached email under the actor's DataContextDb and pairs them with the composed
 * `body` from input. Returned on the live SSE card only — NEVER persisted (the durable row keeps
 * the key-names-only inputSummary). Returns undefined (→ card falls back to summarize) when the
 * message id is missing or the cached row is not visible to the actor.
 */
export const emailReplyPreview: ToolPreview = async (
  scopedDb,
  input,
  _ctx,
  _services
): Promise<ActionRequestPreview | undefined> => {
  assertDataContextDb(scopedDb);
  const { cacheMessageId, body } = readReplyInput(input);
  if (!cacheMessageId) return undefined;
  const message = await repository.getById(scopedDb, cacheMessageId);
  if (!message) return undefined;
  const target = deriveReplyTarget(message);
  return { to: target.to, subject: target.subject, body };
};
