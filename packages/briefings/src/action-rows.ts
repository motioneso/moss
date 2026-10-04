import type {
  BriefingActionRowDto,
  BriefingCatchUpDto,
  BriefingCatchUpEntryDto,
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
import { catchUpEntryId } from "./feedback-targets.js";
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

export const CATCH_UP_ENTRY_CAP = 8;

/** The mail the catch-up digest covers: a start time for the label, and the membership test. */
export interface CatchUpWindow {
  readonly since: Date | null;
  readonly includes: (receivedAt: unknown) => boolean;
}

/** Morning: everything since the previous morning run, else the last 24 hours. */
export function catchUpWindowSince(since: Date): CatchUpWindow {
  return {
    since,
    includes: (receivedAt) => {
      const at = typeof receivedAt === "string" ? Date.parse(receivedAt) : Number.NaN;
      return Number.isFinite(at) && at >= since.getTime();
    }
  };
}

const LEFT_OUT_ACTIONABILITY = new Set(["noise", "receipt_or_notice"]);

/**
 * Important informational mail for the Today catch-up digest (#3028).
 *
 * Shows fyi and waiting-on-someone mail from the window that is not already an action row,
 * not low importance, not list mail unless marked high, and has a guarded summary. Counts the
 * in-window mail it leaves out as newsletters, receipts and notifications; unsorted mail is
 * neither shown nor counted.
 */
export async function buildEmailCatchUp(
  scopedDb: DataContextDb,
  items: readonly Record<string, unknown>[],
  actionRowSourceRefs: ReadonlySet<string>,
  connectorSyncAt: ComposeDeps["connectorSyncAt"],
  window: CatchUpWindow
): Promise<BriefingCatchUpDto | null> {
  const candidates = filterEmailItems(items, actionRowSourceRefs).filter((item) =>
    window.includes(item.receivedAt)
  );
  const eligible: Record<string, unknown>[] = [];
  let leftOutCount = 0;
  for (const item of candidates) {
    const actionability = item.actionability;
    if (typeof actionability === "string" && LEFT_OUT_ACTIONABILITY.has(actionability)) {
      leftOutCount += 1;
      continue;
    }
    if (actionability !== "fyi" && actionability !== "waiting_on_someone") continue;
    if (item.awaitingJudgement === true || summaryOf(item) === null) continue;
    if (item.importance === "low" || (item.bulk === true && item.importance !== "high")) {
      leftOutCount += 1;
      continue;
    }
    eligible.push(item);
  }
  const entries = eligible
    .sort(compareCatchUpItems)
    .flatMap((item) => {
      const entry = catchUpEntry(item);
      return entry ? [entry] : [];
    })
    .slice(0, CATCH_UP_ENTRY_CAP);
  if (entries.length === 0) return null;
  let asOf: string | null = null;
  try {
    const syncAt = connectorSyncAt
      ? await withToolSavepoint(scopedDb, () => connectorSyncAt(scopedDb, "email"))
      : null;
    asOf = syncAt?.toISOString() ?? null;
  } catch {
    // Freshness is best-effort; the entries remain useful.
  }
  return {
    source: "email",
    itemCount: entries.length,
    since: window.since?.toISOString() ?? null,
    leftOutCount,
    asOf,
    entries
  };
}

function summaryOf(item: Record<string, unknown>): string | null {
  if (typeof item.summary !== "string") return null;
  const summary = decodeEntities(item.summary).replace(/\s+/g, " ").trim();
  return summary.length > 0 ? summary : null;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "\u2026",
  ldquo: "\u201c",
  lsquo: "\u2018",
  lt: "<",
  mdash: "\u2014",
  nbsp: " ",
  ndash: "\u2013",
  quot: '"',
  rdquo: "\u201d",
  rsquo: "\u2019"
};

/** Summaries and sender names can carry HTML entities from the message; the UI renders plain text. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, reference: string) => {
    if (reference.startsWith("#")) {
      const codePoint = reference.toLowerCase().startsWith("#x")
        ? Number.parseInt(reference.slice(2), 16)
        : Number.parseInt(reference.slice(1), 10);
      const valid =
        Number.isInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff &&
        (codePoint < 0xd800 || codePoint > 0xdfff);
      return valid ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES[reference.toLowerCase()] ?? entity;
  });
}

function catchUpRank(item: Record<string, unknown>): number {
  if (item.importance === "high") return 0;
  return item.actionability === "waiting_on_someone" ? 1 : 2;
}

function compareCatchUpItems(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const rank = catchUpRank(a) - catchUpRank(b);
  if (rank !== 0) return rank;
  return receivedMs(b) - receivedMs(a);
}

function receivedMs(item: Record<string, unknown>): number {
  const at = typeof item.receivedAt === "string" ? Date.parse(item.receivedAt) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

function catchUpEntry(item: Record<string, unknown>): BriefingCatchUpEntryDto | null {
  const sourceRef = emailSourceRefForItem(item);
  const summary = summaryOf(item);
  if (sourceRef === null || summary === null || typeof item.receivedAt !== "string") return null;
  return {
    id: catchUpEntryId(sourceRef),
    senderName: senderDisplayName(item.sender),
    summary,
    receivedAt: item.receivedAt,
    reason:
      item.importance === "high"
        ? "important"
        : item.actionability === "waiting_on_someone"
          ? "waiting_on_them"
          : null,
    cacheMessageId:
      typeof item.cacheMessageId === "string" && item.cacheMessageId.length > 0
        ? item.cacheMessageId
        : null,
    openHref: httpsHref(item.sourceHref)
  };
}

/** Display name from a From header, else the address local part. */
export function senderDisplayName(sender: unknown): string {
  const raw = typeof sender === "string" ? decodeEntities(sender).trim() : "";
  const angled = /^(.*?)<([^>]*)>\s*$/.exec(raw);
  const name = (angled?.[1] ?? "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  if (name.length > 0) return name;
  const address = (angled?.[2] ?? raw).trim();
  const at = address.indexOf("@");
  const local = at > 0 ? address.slice(0, at) : address;
  return local.length > 0 ? local : "Unknown sender";
}

function httpsHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
