import type { ChatMessage, ChatThread } from "@moss/db";
import type {
  ChatActivityEventDto,
  ChatMessageDto,
  ChatSelectedToolMetadataDto,
  ChatThreadDto,
  ChatTurnOriginV1,
  ChatTurnUsageDto,
  FreshnessKind,
  SourceFreshnessEntry,
  SourceFreshnessV1
} from "@moss/shared";

import { readMeetingChatContext } from "./live/meeting-chat-runtime.js";
import { readAttachments } from "./attachments-routes.js";
import type { ShadowReport, ShadowReportRange } from "./classifier-shadow-repository.js";
import { readStoredProvenance, provenanceCards } from "./live/answer-provenance.js";
import { toIsoString } from "./memory-serializers.js";

/** Temporary shadow report (#2957): allowlisted day range, defaulting to 30. */
export function readShadowReportDays(value: unknown): ShadowReportRange {
  const record = typeof value === "object" && value !== null ? asRecord(value) : {};
  const raw = Array.isArray(record.days) ? record.days[0] : record.days;
  const days = typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : NaN;
  return days === 7 || days === 90 ? days : 30;
}

/** Temporary shadow report (#2957): owner-only counts and disagreements as plain JSON. */
export function serializeShadowReport(report: ShadowReport): {
  readonly days: ShadowReportRange;
  readonly checked: number;
  readonly pickedTool: number;
  readonly agreed: number;
  readonly comparable: number;
  readonly missedTool: number;
  readonly disagreements: readonly {
    readonly id: string;
    readonly createdAt: string;
    readonly classifierTool: string | null;
    readonly modelTool: string | null;
    readonly confidence: number | null;
  }[];
} {
  return {
    days: report.days,
    checked: report.checked,
    pickedTool: report.pickedTool,
    agreed: report.agreed,
    comparable: report.comparable,
    missedTool: report.missedTool,
    disagreements: report.disagreements.map((row) => ({
      id: row.id,
      createdAt: toIsoString(row.createdAt),
      classifierTool: row.classifierTool,
      modelTool: row.modelTool,
      confidence: row.confidence
    }))
  };
}

/** First non-blank line of a message body, capped for a list row. Never a code name or path. */
function firstLinePreview(body: string | null | undefined): string | null {
  if (!body) return null;
  const line = body
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  return line.length > 140 ? `${line.slice(0, 140).trimEnd()}…` : line;
}

export function serializeThread(
  thread: ChatThread & { readonly lastMessageBody?: string | null }
): ChatThreadDto {
  return {
    id: thread.id,
    ownerUserId: thread.owner_user_id,
    title: thread.title,
    incognito: thread.incognito,
    isMain: thread.is_main,
    createdAt: toIsoString(thread.created_at),
    updatedAt: toIsoString(thread.updated_at),
    lastActiveAt: toIsoString(thread.last_active_at),
    lastMessagePreview: firstLinePreview(thread.lastMessageBody)
  };
}

export function serializeMessage(message: ChatMessage): ChatMessageDto {
  const toolMetadata = asRecord(message.tool_metadata);
  const modelMetadata = asRecord(message.model_metadata);
  const storedProvenance = readStoredProvenance(toolMetadata);
  const answerProvenance =
    storedProvenance != null && storedProvenance.supportItems.length > 0
      ? provenanceCards(storedProvenance)
      : undefined;
  const answerProvenanceCitedIds =
    storedProvenance != null && storedProvenance.citedSupportIds.length > 0
      ? [...storedProvenance.citedSupportIds]
      : undefined;
  const elapsedMs =
    typeof toolMetadata.elapsedMs === "number"
      ? toolMetadata.elapsedMs
      : typeof modelMetadata.elapsedMs === "number"
        ? modelMetadata.elapsedMs
        : undefined;
  const usage = (toolMetadata.usage ?? modelMetadata.usage) as ChatTurnUsageDto | undefined;
  const origin = readOrigin(modelMetadata.origin);
  return {
    meetingContext: readMeetingChatContext(toolMetadata)?.coverage,
    id: message.id,
    threadId: message.thread_id,
    ownerUserId: message.owner_user_id,
    role: message.role,
    status: message.status,
    body: message.body,
    modelRoute: null,
    tools: readTools(toolMetadata.selectedTools),
    activity: readActivity(toolMetadata.activity),
    attachments: readAttachments(toolMetadata.attachments),
    sourceFreshness: readSourceFreshness(toolMetadata.sourceFreshness),
    createdAt: toIsoString(message.created_at),
    updatedAt: toIsoString(message.updated_at),
    answerProvenance,
    answerProvenanceCitedIds,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(origin !== undefined ? { origin } : {})
  };
}

/**
 * Task 4.1 (#2901) — reads the gate-origin stamp off an assistant message. Unknown shapes and all
 * pre-existing messages (which have no origin) return undefined, so old model history stays readable.
 */
export function readOrigin(value: unknown): ChatTurnOriginV1 | undefined {
  const record = asRecord(value);
  if (record.kind === "reminder" && record.version === 1) return readReminderOrigin(record);
  if (record.kind !== "classifier_gate" || record.version !== 1) return undefined;
  const outcome =
    record.outcome === "executed-success" || record.outcome === "executed-failure-or-unknown"
      ? record.outcome
      : undefined;
  if (!outcome) return undefined;
  if (typeof record.decisionId !== "string" || record.decisionId.length === 0) return undefined;
  return {
    version: 1,
    kind: "classifier_gate",
    decisionId: record.decisionId,
    moduleId: typeof record.moduleId === "string" ? record.moduleId : null,
    toolName: typeof record.toolName === "string" ? record.toolName : null,
    outcome
  };
}

function readReminderOrigin(record: Record<string, unknown>): ChatTurnOriginV1 | undefined {
  const event = record.event;
  if (event !== "saved" && event !== "refused" && event !== "delivered") return undefined;
  return {
    version: 1,
    kind: "reminder",
    event,
    reminderId: typeof record.reminderId === "string" ? record.reminderId : null,
    ...(typeof record.late === "boolean" ? { late: record.late } : {})
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readActivity(value: unknown): ChatActivityEventDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const outcome =
      record.outcome === "executed" ||
      record.outcome === "denied" ||
      record.outcome === "error" ||
      record.outcome === "allowed"
        ? record.outcome
        : undefined;
    return typeof record.kind === "string" && typeof record.text === "string"
      ? [
          {
            kind: record.kind,
            text: record.text,
            ...(typeof record.id === "string" ? { id: record.id } : {}),
            ...(typeof record.sequence === "number" ? { sequence: record.sequence } : {}),
            ...(typeof record.actionRequestId === "string"
              ? { actionRequestId: record.actionRequestId }
              : {}),
            ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
            ...(typeof record.summary === "string"
              ? { summary: record.summary.slice(0, 200) }
              : {}),
            ...(outcome ? { outcome } : {}),
            ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
            ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
            ...(record.decidedBy === "person" ||
            record.decidedBy === "policy" ||
            record.decidedBy === "timeout" ||
            record.decidedBy === "cancelled"
              ? { decidedBy: record.decidedBy }
              : {}),
            ...(typeof record.reason === "string" ? { reason: record.reason } : {})
          }
        ]
      : [];
  });
}

export function readTools(value: unknown): ChatSelectedToolMetadataDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const risk = record.risk;
    if (
      typeof record.moduleId !== "string" ||
      typeof record.moduleName !== "string" ||
      typeof record.name !== "string" ||
      typeof record.permissionId !== "string" ||
      (risk !== "read" && risk !== "write" && risk !== "outbound" && risk !== "destructive")
    ) {
      return [];
    }
    return [
      {
        moduleId: record.moduleId,
        moduleName: record.moduleName,
        name: record.name,
        permissionId: record.permissionId,
        risk
      }
    ];
  });
}

export function readSourceFreshness(value: unknown): SourceFreshnessV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (rec.version !== 1) return null;
  if (typeof rec.capturedAt !== "string") return null;
  const rawSources = Array.isArray(rec.sources) ? rec.sources : [];
  const sources: SourceFreshnessEntry[] = rawSources.flatMap((item) => {
    const r = asRecord(item);
    if (typeof r.source !== "string" || typeof r.freshnessKind !== "string") return [];
    const asOf = r.asOf === null ? null : typeof r.asOf === "string" ? r.asOf : null;
    return [{ source: r.source, freshnessKind: r.freshnessKind as FreshnessKind, asOf }];
  });
  return { version: 1, capturedAt: rec.capturedAt as string, sources };
}
