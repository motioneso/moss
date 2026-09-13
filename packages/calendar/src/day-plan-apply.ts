// Apply-batch selection and stored-batch mapping (R2.2-T04A). Pure functions:
// given a plan's blocks and an explicitly reviewed selection, they resolve the
// full batch selection; given durable operation rows, they map them back to
// batch DTOs. This module never reads or writes anything itself and never
// calls a provider.
import { HttpError } from "@moss/module-sdk";
import type {
  ApplyItemResult,
  DayPlanApplyBatchDto,
  DayPlanApplySelectionEntry,
  DayPlanOperationOutcome,
  DayPlanPendingChange
} from "@moss/shared";

import { requireSelectedPlanBlock } from "./day-plan-model.js";

// The operations-row kind marking a batch header. Single-slot reservations keep
// the shared add/move/remove kinds; only reserveApplyBatch writes this value.
export const DAY_PLAN_APPLY_BATCH_KIND = "apply" as const;

export interface DayPlanApplyResolvableBlock {
  readonly id: string;
  readonly position: number;
  readonly pendingChange: DayPlanPendingChange | null;
}

// Normalizes the client's requested intent: trimmed, blanks dropped, deduped,
// sorted. Omitted and empty selections normalize identically.
export function normalizeApplyIntent(selectedBlockIds?: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const rawId of selectedBlockIds ?? []) {
    const id = rawId.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
  }
  return [...seen].sort();
}

export function applyIntentsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

function entryOf(block: DayPlanApplyResolvableBlock): DayPlanApplySelectionEntry {
  const change = block.pendingChange!;
  return {
    blockId: block.id,
    kind: change.kind,
    startsAt: change.kind === "remove" ? null : change.startsAt,
    durationMinutes: change.kind === "remove" ? null : change.durationMinutes
  };
}

// Resolves the reviewed explicit selection plus every still-pending addition,
// ordered by plan position so the snapshot is stable. Unknown ids and blocks
// without a pending change fail exactly like the preview authority.
export function resolveApplySelection(
  blocks: readonly DayPlanApplyResolvableBlock[],
  selectedBlockIds?: readonly string[]
): DayPlanApplySelectionEntry[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const explicit = new Map<string, DayPlanApplySelectionEntry>();
  for (const id of normalizeApplyIntent(selectedBlockIds)) {
    if (explicit.has(id)) continue;
    explicit.set(id, entryOf(requireSelectedPlanBlock(byId, id)));
  }
  for (const block of blocks) {
    if (explicit.has(block.id)) continue;
    if (block.pendingChange?.kind === "add") explicit.set(block.id, entryOf(block));
  }
  return [...explicit.values()].sort((a, b) => {
    const pa = byId.get(a.blockId)!.position;
    const pb = byId.get(b.blockId)!.position;
    if (pa !== pb) return pa - pb;
    return a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0;
  });
}

export interface PendingChangeShape {
  readonly kind: string;
  readonly startsAt?: string | null;
  readonly durationMinutes?: number | null;
}

export function pendingChangesEqual(
  a: PendingChangeShape | null,
  b: PendingChangeShape | null
): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "remove" || b.kind === "remove") return true;
  return a.startsAt === b.startsAt && a.durationMinutes === b.durationMinutes;
}

export function applySelectionsEqual(
  a: readonly DayPlanApplySelectionEntry[],
  b: readonly DayPlanApplySelectionEntry[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (entry, index) =>
      entry.blockId === b[index]!.blockId &&
      entry.kind === b[index]!.kind &&
      entry.startsAt === b[index]!.startsAt &&
      entry.durationMinutes === b[index]!.durationMinutes
  );
}

function readSelectionEntry(value: unknown): DayPlanApplySelectionEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(500, "stored apply batch is unreadable");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.blockId !== "string" ||
    (row.kind !== "add" && row.kind !== "move" && row.kind !== "remove")
  ) {
    throw new HttpError(500, "stored apply batch is unreadable");
  }
  return {
    blockId: row.blockId,
    kind: row.kind,
    startsAt: typeof row.startsAt === "string" ? row.startsAt : null,
    durationMinutes: typeof row.durationMinutes === "number" ? row.durationMinutes : null
  };
}

function readItemResult(value: unknown): ApplyItemResult | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(500, "stored apply batch is unreadable");
  }
  const row = value as Record<string, unknown>;
  if (row.status === "applied") {
    if (
      typeof row.providerEventId !== "string" ||
      typeof row.startsAt !== "string" ||
      typeof row.durationMinutes !== "number" ||
      (row.calendarMirror !== "written" &&
        row.calendarMirror !== "skipped-rls" &&
        row.calendarMirror !== "skipped-error" &&
        row.calendarMirror !== "not-checked" &&
        row.calendarMirror !== "not-cached") ||
      (row.blockMirror !== "mirrored" && row.blockMirror !== "mismatch-preserved")
    ) {
      throw new HttpError(500, "stored apply batch is unreadable");
    }
    return row as unknown as ApplyItemResult;
  }
  if (row.status === "failed" || row.status === "unknown") {
    if (typeof row.reason !== "string") {
      throw new HttpError(500, "stored apply batch is unreadable");
    }
    return row as unknown as ApplyItemResult;
  }
  throw new HttpError(500, "stored apply batch is unreadable");
}

interface StoredBatchSnapshot {
  // Null for snapshots written before request intent was stored; those never
  // replay and always conflict, which is the safe direction.
  readonly intent: readonly string[] | null;
  readonly selection: readonly DayPlanApplySelectionEntry[];
}

export function readBatchSnapshot(value: unknown): StoredBatchSnapshot {
  if (Array.isArray(value)) {
    return { intent: null, selection: value.map(readSelectionEntry) };
  }
  if (typeof value !== "object" || value === null) {
    throw new HttpError(500, "stored apply batch is unreadable");
  }
  const row = value as Record<string, unknown>;
  if (
    !Array.isArray(row.intent) ||
    !row.intent.every((id): id is string => typeof id === "string") ||
    !Array.isArray(row.selection)
  ) {
    throw new HttpError(500, "stored apply batch is unreadable");
  }
  return { intent: [...row.intent], selection: row.selection.map(readSelectionEntry) };
}

export function toBatchDto(
  header: {
    id: string;
    plan_id: string;
    idempotency_key: string;
    operation_key: string | null;
    expected_revision: number;
    outcome: DayPlanOperationOutcome;
    selection_snapshot: unknown;
  },
  items: {
    id: string;
    block_id: string | null;
    kind: string;
    pending_change: unknown;
    outcome: DayPlanOperationOutcome;
    result: unknown;
  }[]
): DayPlanApplyBatchDto {
  const selection = readBatchSnapshot(header.selection_snapshot).selection;
  const order = new Map(selection.map((entry, index) => [entry.blockId, index]));
  const sorted = [...items].sort(
    (a, b) =>
      (order.get(a.block_id ?? "") ?? items.length) - (order.get(b.block_id ?? "") ?? items.length)
  );
  return {
    id: header.id,
    planId: header.plan_id,
    idempotencyKey: header.idempotency_key,
    operationKey: header.operation_key,
    expectedRevision: header.expected_revision,
    outcome: header.outcome,
    selection: [...selection],
    items: sorted.map((item) => {
      if (item.kind !== "add" && item.kind !== "move" && item.kind !== "remove") {
        throw new HttpError(500, "stored apply batch is unreadable");
      }
      return {
        id: item.id,
        blockId: item.block_id,
        kind: item.kind,
        pendingChange: readSelectionEntry(item.pending_change),
        outcome: item.outcome,
        result: readItemResult(item.result)
      };
    })
  };
}
