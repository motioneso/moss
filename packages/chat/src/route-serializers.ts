import type { ChatMessage, ChatThread } from "@moss/db";
import type {
  ChatActivityEventDto,
  ChatMessageDto,
  ChatSelectedToolMetadataDto,
  ChatThreadDto,
  FreshnessKind,
  SourceFreshnessEntry,
  SourceFreshnessV1
} from "@moss/shared";

import { readAttachments } from "./attachments-routes.js";
import { readStoredProvenance, provenanceCards } from "./live/answer-provenance.js";
import { toIsoString } from "./memory-serializers.js";

export function serializeThread(thread: ChatThread): ChatThreadDto {
  return {
    id: thread.id,
    ownerUserId: thread.owner_user_id,
    title: thread.title,
    incognito: thread.incognito,
    createdAt: toIsoString(thread.created_at),
    updatedAt: toIsoString(thread.updated_at)
  };
}

export function serializeMessage(message: ChatMessage): ChatMessageDto {
  const toolMetadata = asRecord(message.tool_metadata);
  const storedProvenance = readStoredProvenance(toolMetadata);
  const answerProvenance =
    storedProvenance != null && storedProvenance.supportItems.length > 0
      ? provenanceCards(storedProvenance)
      : undefined;
  const answerProvenanceCitedIds =
    storedProvenance != null && storedProvenance.citedSupportIds.length > 0
      ? [...storedProvenance.citedSupportIds]
      : undefined;
  return {
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
    answerProvenanceCitedIds
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
            ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
            ...(outcome ? { outcome } : {})
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
