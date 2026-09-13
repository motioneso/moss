// Preview computation (R2.2-T03). Pure function: given a saved plan, the actor's selected
// pending changes, current task facts and (when available) live calendar busy intervals, it
// reports deterministic before/after timing, eligibility, deadline risk and conflicts. It never
// reads or writes anything itself and never mutates a proposed start or duration.
import type {
  DayPlanBlockDto,
  DayPlanCalendarAvailability,
  DayPlanDto,
  DayPlanPreviewBlockDetail,
  DayPlanPreviewConflict,
  DayPlanPreviewIneligibleReason,
  DayPlanPreviewTiming,
  PreviewDayPlanResponse
} from "@moss/shared";

import { DayPlanValidationError } from "./day-plan-model.js";

export type DayPlanPreviewTaskStatus = "done" | "archived" | "other";

// Absent from the map means the task could not be found for this actor — a missing id and an
// id owned by someone else look identical, so callers must not distinguish them (see
// day-plan-api.ts DAY_PLAN_PREVIEW_INELIGIBLE_REASONS).
export interface DayPlanPreviewTaskFact {
  readonly status: DayPlanPreviewTaskStatus;
  readonly dueAt: string | null;
}

export interface DayPlanPreviewBusyInterval {
  readonly start: string;
  readonly end: string;
  readonly title: string;
  readonly accountLabel: string;
  /** The calendar event this interval represents, when known — used to exclude a block's own event. */
  readonly eventKey: string | null;
}

export interface BuildDayPlanPreviewInput {
  readonly plan: DayPlanDto;
  readonly selectedBlockIds: readonly string[];
  /** Keyed by task id. A missing entry means the task could not be found at all. */
  readonly taskFacts: ReadonlyMap<string, DayPlanPreviewTaskFact>;
  readonly busyIntervals: readonly DayPlanPreviewBusyInterval[];
  readonly calendarAvailability: DayPlanCalendarAvailability;
  readonly calendarAsOf: string | null;
  readonly now: Date;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function timingOf(block: DayPlanBlockDto): DayPlanPreviewTiming | null {
  const placement = block.actualPlacement;
  if (!placement || placement.startsAt === null || placement.durationMinutes === null) return null;
  return { startsAt: placement.startsAt, durationMinutes: placement.durationMinutes };
}

function afterOf(block: DayPlanBlockDto): DayPlanPreviewTiming | null {
  const change = block.pendingChange;
  if (!change || change.kind === "remove") return null;
  return { startsAt: change.startsAt, durationMinutes: change.durationMinutes };
}

function endsAt(timing: DayPlanPreviewTiming): string {
  return new Date(
    new Date(timing.startsAt).getTime() + timing.durationMinutes * 60_000
  ).toISOString();
}

function eligibilityOf(
  taskId: string | null,
  taskFacts: ReadonlyMap<string, DayPlanPreviewTaskFact>
): { eligible: boolean; reason: DayPlanPreviewIneligibleReason | null } {
  if (taskId === null) return { eligible: true, reason: null };
  const fact = taskFacts.get(taskId);
  if (!fact) return { eligible: false, reason: "task_unavailable" };
  if (fact.status === "done") return { eligible: false, reason: "task_done" };
  if (fact.status === "archived") return { eligible: false, reason: "task_archived" };
  return { eligible: true, reason: null };
}

function deadlineRiskOf(
  taskId: string | null,
  after: DayPlanPreviewTiming | null,
  taskFacts: ReadonlyMap<string, DayPlanPreviewTaskFact>
): boolean {
  if (taskId === null || after === null) return false;
  const dueAt = taskFacts.get(taskId)?.dueAt ?? null;
  if (dueAt === null) return false;
  return endsAt(after) > dueAt;
}

export function buildDayPlanPreview(input: BuildDayPlanPreviewInput): PreviewDayPlanResponse {
  const blockById = new Map(input.plan.blocks.map((block) => [block.id, block]));

  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of input.selectedBlockIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const block = blockById.get(id);
    if (!block) {
      throw new DayPlanValidationError(`selected change ${id} is not part of this plan`);
    }
    if (!block.pendingChange) {
      throw new DayPlanValidationError(`selected change ${id} has no pending change`);
    }
    orderedIds.push(id);
  }

  const blocks: DayPlanPreviewBlockDetail[] = [];
  const conflicts: DayPlanPreviewConflict[] = [];
  const eligibleBlockIds: string[] = [];
  const withTiming: {
    blockId: string;
    after: DayPlanPreviewTiming;
    calendarEventRef: string | null;
  }[] = [];

  for (const id of orderedIds) {
    const block = blockById.get(id)!;
    const after = afterOf(block);
    const { eligible, reason } = eligibilityOf(block.taskId, input.taskFacts);
    blocks.push({
      blockId: id,
      taskId: block.taskId,
      changeKind: block.pendingChange!.kind,
      before: timingOf(block),
      after,
      eligible,
      ineligibleReason: reason,
      deadlineRisk: deadlineRiskOf(block.taskId, after, input.taskFacts)
    });
    if (eligible) eligibleBlockIds.push(id);
    if (after) {
      withTiming.push({
        blockId: id,
        after,
        calendarEventRef: block.actualPlacement?.calendarEventRef ?? null
      });
    }
  }

  // Selected-batch overlap: every pair of selected proposed times that overlap, reported once per side.
  for (let i = 0; i < withTiming.length; i++) {
    for (let j = i + 1; j < withTiming.length; j++) {
      const a = withTiming[i]!;
      const b = withTiming[j]!;
      if (overlaps(a.after.startsAt, endsAt(a.after), b.after.startsAt, endsAt(b.after))) {
        conflicts.push({
          blockId: a.blockId,
          kind: "selected_overlap",
          withBlockId: b.blockId,
          detail: "Overlaps another selected change in this preview",
          calendarEvent: null
        });
        conflicts.push({
          blockId: b.blockId,
          kind: "selected_overlap",
          withBlockId: a.blockId,
          detail: "Overlaps another selected change in this preview",
          calendarEvent: null
        });
      }
    }
  }

  // Calendar-busy overlap. calendarAvailability, including "unavailable", says whether an
  // ABSENCE of conflicts can be trusted (a gap or truncated read may hide more commitments than
  // these). It says nothing about the commitments that WERE returned — those are known facts and
  // always feed conflict detection, however incomplete the wider read is.
  for (const { blockId, after, calendarEventRef } of withTiming) {
    const aEnd = endsAt(after);
    for (const busy of input.busyIntervals) {
      if (calendarEventRef !== null && busy.eventKey === calendarEventRef) continue;
      if (overlaps(after.startsAt, aEnd, busy.start, busy.end)) {
        conflicts.push({
          blockId,
          kind: "calendar_busy",
          withBlockId: null,
          detail: `Overlaps "${busy.title}" on ${busy.accountLabel}`,
          calendarEvent: {
            eventKey: busy.eventKey ?? "",
            title: busy.title,
            startsAt: busy.start,
            endsAt: busy.end,
            accountLabel: busy.accountLabel
          }
        });
      }
    }
  }

  return {
    revision: input.plan.revision,
    calendarAvailability: input.calendarAvailability,
    calendarAsOf: input.calendarAsOf,
    blocks,
    eligibleBlockIds,
    conflicts
  };
}
