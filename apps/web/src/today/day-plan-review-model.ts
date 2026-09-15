import type {
  ApplyConfirmationRequiredResponse,
  ApplyExecutionItemReport,
  ApplyExecutionReport,
  DayPlanBlockDto,
  DayPlanBlockKind,
  DayPlanChangeSetEntry,
  DayPlanDto,
  DayPlanPendingChange,
  DayPlanPreviewConflict,
  LocaleSettingsDto
} from "@moss/shared";

import { localDay } from "@moss/shared";

import { zonedClockParts } from "../locale/locale-format.js";
import { REVIEW_TRANSIENT_LABELS, timeLabel } from "./today-labels.js";

export type ReviewPlacement = "add" | "keep-proposed" | "leave" | "keep" | "move" | "remove";

export interface BlockChoice {
  readonly placement: ReviewPlacement;
  /** Full ISO instant for add/move; null when the row keeps the saved state. */
  readonly startsAt: string | null;
}

export interface PendingApproval {
  readonly operationId: string;
  readonly approvalId: string;
  readonly changes: readonly DayPlanChangeSetEntry[];
  readonly selection: readonly string[];
  readonly idempotencyKey: string;
}

/** Wall-clock HH:MM of an instant in the plan zone, for the time control. */
export function isoToLocalTime(iso: string, timeZone: string): string {
  const parts = zonedClockParts(iso, timeZone);
  if (!parts) return "";
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** UTC instant for a plan-zone wall time on the plan day; null on bad input. */
export function localTimeToIso(day: string, time: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const target = Date.parse(`${day}T${time}:00Z`);
  let guess = target;
  if (Number.isNaN(guess)) return null;
  for (let i = 0; i < 2; i++) {
    const parts = zonedClockParts(guess, timeZone);
    if (!parts) return null;
    const wallDay = localDay(new Date(guess), timeZone);
    const diff = target - Date.parse(`${wallDay}T${pad2(parts.hour)}:${pad2(parts.minute)}:00Z`);
    if (diff === 0) return new Date(guess).toISOString();
    guess += diff;
  }
  return new Date(guess).toISOString();
}

/** Duration always comes from the block's stored timing, never invented. */
export function blockDuration(block: DayPlanBlockDto): number | null {
  const pending = block.pendingChange;
  if (pending && pending.kind !== "remove") {
    return pending.durationMinutes ?? block.actualPlacement?.durationMinutes ?? null;
  }
  return block.actualPlacement?.durationMinutes ?? null;
}

export function defaultChoiceFor(block: DayPlanBlockDto): BlockChoice {
  // Neutral until Ben touches the row: keep mirrors the saved pending change
  // without selecting it, so untouched proposals never join a preview or apply.
  if (block.pendingChange !== null || block.actualPlacement?.startsAt != null) {
    return { placement: block.taskId !== null ? "keep-proposed" : "keep", startsAt: null };
  }
  return { placement: block.taskId !== null ? "keep-proposed" : "leave", startsAt: null };
}

/** Effective pending change; null clears, undefined matches the saved state. */
export function effectivePending(
  block: DayPlanBlockDto,
  choice: BlockChoice
): DayPlanPendingChange | null | undefined {
  const saved = block.pendingChange ?? null;
  switch (choice.placement) {
    case "add":
    case "move": {
      const duration = blockDuration(block);
      if (choice.startsAt === null || duration === null) return undefined;
      return { kind: choice.placement, startsAt: choice.startsAt, durationMinutes: duration };
    }
    case "remove":
      return { kind: "remove" };
    case "leave":
      return null;
    case "keep-proposed":
    case "keep":
      return saved === null ? undefined : saved;
  }
}

export function samePending(
  a: DayPlanPendingChange | null,
  b: DayPlanPendingChange | null
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Draft rows: every block, since a draft save replaces the whole list. */
export function draftBlocksFor(
  plan: DayPlanDto,
  choiceFor: (block: DayPlanBlockDto) => BlockChoice
): {
  id: string;
  kind: DayPlanBlockKind;
  taskId: string | null;
  title: string | null;
  pendingChange: DayPlanPendingChange | null;
}[] {
  return plan.blocks.map((block) => {
    const effective = effectivePending(block, choiceFor(block));
    return {
      id: block.id,
      kind: block.kind,
      taskId: block.taskId,
      title: block.title,
      pendingChange: effective === undefined ? (block.pendingChange ?? null) : effective
    };
  });
}

/** Preview selection: touched rows carrying an add, move or removal. */
export function previewSelectionFor(
  plan: DayPlanDto,
  choiceFor: (block: DayPlanBlockDto) => BlockChoice,
  touchedIds: readonly string[]
): string[] {
  const touched = new Set(touchedIds);
  return plan.blocks
    .filter((block) => {
      if (!touched.has(block.id)) return false;
      const effective = effectivePending(block, choiceFor(block));
      return effective !== undefined && effective !== null;
    })
    .map((block) => block.id);
}

/** Accept All selection: proposed additions only (saved or touched with a time). */
export function acceptAllSelectionFor(
  plan: DayPlanDto,
  choiceFor: (block: DayPlanBlockDto) => BlockChoice,
  touchedIds: readonly string[]
): string[] {
  return plan.blocks
    .filter((block) => {
      if (block.taskId === null) return false;
      if (block.actualPlacement?.startsAt != null) return false;
      const choice = choiceFor(block);
      if (choice.placement === "leave") return false;
      const effective = effectivePending(block, choice);
      return effective !== undefined && effective !== null && effective.kind === "add";
    })
    .map((block) => block.id);
}

/** Gate for Accept All: saved moves/removals, or touched moves/removals/retimes. */
export function hasOtherPendingEdits(
  plan: DayPlanDto,
  choiceFor: (block: DayPlanBlockDto) => BlockChoice,
  touchedIds: readonly string[]
): boolean {
  const touched = new Set(touchedIds);
  return plan.blocks.some((block) => {
    if (block.pendingChange?.kind === "move" || block.pendingChange?.kind === "remove") return true;
    if (!touched.has(block.id)) return false;
    const effective = effectivePending(block, choiceFor(block));
    return (
      effective !== undefined &&
      effective !== null &&
      (effective.kind === "move" || effective.kind === "remove")
    );
  });
}

/** One idempotency key per selection attempt: repeats retry as one batch. */
export function selectionKey(planId: string, revision: number, selection: string): string {
  let hash = 0x811c9dc5;
  const input = `${planId}|${revision}|${selection}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `review-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function isConfirmationRequired(
  response: ApplyExecutionReport | ApplyConfirmationRequiredResponse
): response is ApplyConfirmationRequiredResponse {
  return "status" in response && response.status === "confirmation-required";
}

export function changedBlockIds(plan: DayPlanDto, next: DayPlanDto): string[] {
  const before = new Map(plan.blocks.map((block) => [block.id, JSON.stringify(block)]));
  return next.blocks
    .filter((block) => before.get(block.id) !== JSON.stringify(block))
    .map((block) => block.id);
}

/** Saved-schedule words come from the view model; unsaved deltas read transient. */
export function transientWord(
  changed: boolean,
  kind: "add" | "move" | "remove" | undefined,
  onCalendar: boolean
): string | null {
  if (!changed) return null;
  if (kind === "remove") return REVIEW_TRANSIENT_LABELS.willRemove;
  return onCalendar ? REVIEW_TRANSIENT_LABELS.timeChange : REVIEW_TRANSIENT_LABELS.toSchedule;
}

export function outcomeWord(item: ApplyExecutionItemReport): string {
  if (item.outcome === "applied") return "Applied";
  if (item.outcome === "pending") return "Pending";
  if (item.outcome !== "failed") return "Needs check";
  const reason = item.result && "reason" in item.result ? item.result.reason : null;
  return reason ? `Failed: ${reason.replace(/-/g, " ")}` : "Failed";
}

/** Unresolved outcome keys (blockId/itemId) and their itemIds, for a retry batch. */
export function retryableOutcomes(outcomes: Readonly<Record<string, ApplyExecutionItemReport>>): {
  keys: string[];
  ids: string[];
} {
  const entries = Object.entries(outcomes).filter(
    ([, item]) => item.itemId !== null && !["applied", "pending"].includes(item.outcome)
  );
  return {
    keys: entries.map(([key]) => key),
    ids: entries.map(([, item]) => item.itemId as string)
  };
}

export function conflictText(conflict: DayPlanPreviewConflict, locale: LocaleSettingsDto): string {
  const event = conflict.calendarEvent;
  if (event) {
    return `Overlaps ${event.title}, ${timeLabel(event.startsAt, locale)} to ${timeLabel(event.endsAt, locale)}`;
  }
  return conflict.detail || "Overlaps another selected block";
}

export function ineligibleWord(reason: string | null): string {
  if (reason === "task_done") return "Task is done";
  if (reason === "task_archived") return "Task is archived";
  if (reason === "task_unavailable") return "Task no longer available";
  return reason ?? "Not eligible";
}
