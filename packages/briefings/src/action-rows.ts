import type {
  BriefingActionRowDto,
  BriefingStructuredPayloadV1,
  TaskSuggestionMetadataV1
} from "@moss/shared";
import type { BriefingDefinition, DataContextDb } from "@moss/db";

import {
  ctxFor,
  findExecute,
  isRecord,
  type BriefingGap,
  type ComposeDeps,
  type ComposeRunInput
} from "./compose-shared.js";
import { SECTION_ITEM_CAP } from "./compose-shared.js";
import { withToolSavepoint } from "./savepoint.js";

interface SuggestedTaskShape {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly dueAt: string | null;
  readonly updatedAt: string | null;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly suggestionMetadata: TaskSuggestionMetadataV1;
}

export interface ActionRowCollection {
  readonly payload: BriefingStructuredPayloadV1;
  readonly sourceRefs: ReadonlySet<string>;
  readonly invalidMetadataCount: number;
}

export function emptyStructuredPayload(): BriefingStructuredPayloadV1 {
  return { version: 1, actionRows: [], catchUp: null };
}

function isCategory(value: unknown): value is TaskSuggestionMetadataV1["category"] {
  return value === "needs_reply" || value === "needs_action" || value === "time_sensitive_info";
}

function isResurfaceReason(value: unknown): value is TaskSuggestionMetadataV1["resurfaceReason"] {
  return value === null || value === "due_tomorrow" || value === "relevant_context";
}

function isSuggestionMetadata(value: unknown): value is TaskSuggestionMetadataV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isCategory(value.category) &&
    typeof value.sourceLabel === "string" &&
    (value.sourceHref === null || typeof value.sourceHref === "string") &&
    (value.cacheMessageId === null || typeof value.cacheMessageId === "string") &&
    typeof value.subjectSignature === "string" &&
    typeof value.computedAt === "string" &&
    isResurfaceReason(value.resurfaceReason)
  );
}

function taskShape(value: Record<string, unknown>): SuggestedTaskShape | null {
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    (value.description !== null && typeof value.description !== "string") ||
    (value.dueAt !== null && typeof value.dueAt !== "string") ||
    (value.updatedAt !== null && typeof value.updatedAt !== "string") ||
    typeof value.source !== "string" ||
    (value.sourceRef !== null && typeof value.sourceRef !== "string") ||
    !isSuggestionMetadata(value.suggestionMetadata)
  ) {
    return null;
  }
  return value as unknown as SuggestedTaskShape;
}

function primaryAction(metadata: TaskSuggestionMetadataV1) {
  if (metadata.category === "needs_reply") {
    return metadata.cacheMessageId && metadata.cacheMessageId.length > 0
      ? { kind: "reply" as const, cacheMessageId: metadata.cacheMessageId }
      : null;
  }
  const href = metadata.sourceHref;
  return href && href.trim().length > 0 ? { kind: "view" as const, href } : null;
}

function dueTimestamp(value: string | null): number {
  if (value === null) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function updatedTimestamp(value: string | null): number {
  if (value === null) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function projectActionRows(tasks: readonly unknown[]): ActionRowCollection {
  let invalidMetadataCount = 0;
  const rows = tasks.flatMap(
    (item): Array<{ row: BriefingActionRowDto; updatedAt: string | null }> => {
      if (!isRecord(item)) return [];
      if (!isSuggestionMetadata(item.suggestionMetadata)) {
        invalidMetadataCount += 1;
        return [];
      }
      const task = taskShape(item);
      if (!task || task.sourceRef === null || task.sourceRef.length === 0) return [];
      const metadata = task.suggestionMetadata;
      if (metadata.cacheMessageId === null || metadata.cacheMessageId.trim().length === 0) {
        return [];
      }
      const action = primaryAction(metadata);
      if (!action && metadata.category === "needs_reply") return [];
      return [
        {
          row: {
            taskId: task.id,
            title: task.title,
            explanation: task.description?.trim()
              ? task.description
              : "This email may need your attention.",
            category: metadata.category,
            status: "suggested",
            primaryAction: action,
            source: task.source,
            sourceLabel: metadata.sourceLabel,
            sourceRef: task.sourceRef,
            sourceHref: metadata.sourceHref,
            dueAt: task.dueAt,
            computedAt: metadata.computedAt,
            resurfaceReason: metadata.resurfaceReason
          },
          updatedAt: task.updatedAt
        }
      ];
    }
  );

  rows.sort((a, b) => {
    const due = dueTimestamp(a.row.dueAt) - dueTimestamp(b.row.dueAt);
    if (due !== 0) return due;
    const updated = updatedTimestamp(b.updatedAt) - updatedTimestamp(a.updatedAt);
    if (updated !== 0) return updated;
    return a.row.taskId.localeCompare(b.row.taskId);
  });

  const emitted = rows.slice(0, SECTION_ITEM_CAP).map(({ row }) => row);
  return {
    payload: { version: 1, actionRows: emitted, catchUp: null },
    sourceRefs: new Set(emitted.map((row) => row.sourceRef)),
    invalidMetadataCount
  };
}

export async function gatherActionRows(
  scopedDb: DataContextDb,
  definition: BriefingDefinition,
  input: ComposeRunInput,
  deps: ComposeDeps,
  gaps: BriefingGap[]
): Promise<ActionRowCollection> {
  if (!definition.selected_tool_names.includes("tasks.list")) {
    return { payload: emptyStructuredPayload(), sourceRefs: new Set(), invalidMetadataCount: 0 };
  }
  const tool = findExecute(deps.moduleManifests, "tasks.list");
  if (!tool?.execute) {
    gaps.push({ source: "action_rows", reason: "structured_payload_failed" });
    return { payload: emptyStructuredPayload(), sourceRefs: new Set(), invalidMetadataCount: 0 };
  }
  try {
    const execute = tool.execute;
    const result = await withToolSavepoint(scopedDb, () =>
      execute(scopedDb, { status: "suggested" }, ctxFor(definition, input), {})
    );
    const data = isRecord(result.data) ? result.data : {};
    const items = Array.isArray(data.items) ? data.items : [];
    const projected = projectActionRows(items);
    if (projected.invalidMetadataCount > 0) {
      deps.logger?.error(
        {
          stage: "action-row-projection",
          name: "InvalidSuggestionMetadata",
          count: projected.invalidMetadataCount
        },
        "briefing structured payload contained invalid metadata"
      );
    }
    return projected;
  } catch (error) {
    deps.logger?.error(
      {
        stage: "action-row-gather",
        name: error instanceof Error ? error.name : "UnknownError"
      },
      "briefing action-row gather failed"
    );
    gaps.push({ source: "action_rows", reason: "structured_payload_failed" });
    return { payload: emptyStructuredPayload(), sourceRefs: new Set(), invalidMetadataCount: 0 };
  }
}

export function emailSourceRefForItem(item: Record<string, unknown>): string | null {
  if (typeof item.sourceRef === "string" && item.sourceRef.length > 0) return item.sourceRef;
  const accountId =
    typeof item.connectorAccountId === "string"
      ? item.connectorAccountId
      : isRecord(item.account) && typeof item.account.connectorAccountId === "string"
        ? item.account.connectorAccountId
        : null;
  const messageKey =
    typeof item.id === "string"
      ? item.id
      : typeof item.messageKey === "string"
        ? item.messageKey
        : null;
  return accountId && messageKey ? `${accountId}:${messageKey}` : null;
}

export function filterEmailItems(
  items: readonly Record<string, unknown>[],
  actionRowSourceRefs: ReadonlySet<string>
): Record<string, unknown>[] {
  return items.filter((item) => {
    const sourceRef = emailSourceRefForItem(item);
    return sourceRef === null || !actionRowSourceRefs.has(sourceRef);
  });
}

export async function buildEmailCatchUp(
  scopedDb: DataContextDb,
  items: readonly Record<string, unknown>[],
  actionRowSourceRefs: ReadonlySet<string>,
  connectorSyncAt: ComposeDeps["connectorSyncAt"]
) {
  const eligible = filterEmailItems(items, actionRowSourceRefs).filter(
    (item) => item.actionability === "waiting_on_someone" || item.actionability === "fyi"
  );
  if (eligible.length === 0) return null;
  const summaries = eligible
    .map((item) => (typeof item.summary === "string" ? item.summary.trim() : ""))
    .filter(Boolean)
    .slice(0, 3);
  let asOf: string | null = null;
  try {
    const syncAt = connectorSyncAt
      ? await withToolSavepoint(scopedDb, () => connectorSyncAt(scopedDb, "email"))
      : null;
    asOf = syncAt?.toISOString() ?? null;
  } catch {
    // Freshness is best-effort; the count and guarded summaries remain useful.
  }
  return {
    source: "email" as const,
    itemCount: eligible.length,
    summaryText: summaries.length > 0 ? summaries.join("\n") : "No safe summary is available yet.",
    asOf
  };
}
