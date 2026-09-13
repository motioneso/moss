// Apply-batch selection (R2.2-T04A). Pure functions: given a plan's blocks and an
// explicitly reviewed selection, they resolve the full batch selection. This module
// never reads or writes anything itself and never calls a provider.
import type { DayPlanApplySelectionEntry, DayPlanPendingChange } from "@moss/shared";

import { DayPlanValidationError } from "./day-plan-model.js";

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
    const block = byId.get(id);
    if (!block) {
      throw new DayPlanValidationError(`selected change ${id} is not part of this plan`);
    }
    if (!block.pendingChange) {
      throw new DayPlanValidationError(`selected change ${id} has no pending change`);
    }
    explicit.set(id, entryOf(block));
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
