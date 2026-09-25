import type {
  CalendarEventDto,
  DayPlanBlockDto,
  DayPlanBlockInput,
  DayPlanDto,
  DayPlanEveningIntent,
  DayPlanIntentCapacity,
  TaskDto,
  TaskEffort
} from "@moss/shared";

import { localDay } from "@moss/shared";

import { localTimeToIso } from "./day-plan-review-model.js";

export type CommitmentDecision = "tomorrow" | "another-date" | "unscheduled" | null;

export interface CommitmentRow {
  readonly task: TaskDto;
  readonly decided: CommitmentDecision;
  /** Done, archived or unreadable tasks carry no choice. */
  readonly marked: "done" | "archived" | "unavailable" | null;
}

const TASK_EFFORT_MINUTES: Record<TaskEffort, number> = {
  quick: 30,
  medium: 60,
  large: 120
};

/** Proposed minutes for a task: its effort mapping, 60 when unset. */
export function effortMinutes(effort: TaskEffort | null): number {
  return effort === null ? 60 : TASK_EFFORT_MINUTES[effort];
}

/** Rows for the commitments section, deduplicated by task and decided by due date or saved intent. */
/** A loaded null plan means missing: the real read returns 200 with `plan: null`, never a 404. */
export function tomorrowPlanMissing(
  data: { plan: DayPlanDto | null } | undefined,
  error: unknown
): boolean {
  if (data !== undefined) return data.plan === null;
  return (error as { status?: number } | null)?.status === 404;
}

export function commitmentRowsFor(
  todayPlan: DayPlanDto | null,
  tomorrowPlan: DayPlanDto | null,
  tasks: readonly TaskDto[],
  unavailableTaskIds: readonly string[],
  tomorrowKey: string,
  timeZone: string
): CommitmentRow[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const todayKey = new Date(Date.parse(`${tomorrowKey}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const take = (taskId: string | null, closedOk: boolean) => {
    if (taskId === null || seen.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task || (task.status !== "todo" && !closedOk)) return;
    seen.add(taskId);
    ordered.push(taskId);
  };
  for (const block of todayPlan?.blocks ?? []) take(block.taskId, true);
  for (const task of tasks) {
    if (task.status !== "todo" || task.dueAt === null) continue;
    const due = localDay(task.dueAt, timeZone);
    if (due !== todayKey && due !== tomorrowKey) continue;
    take(task.id, false);
  }
  const saved = new Map(
    (tomorrowPlan?.eveningIntent?.commitments ?? []).map((entry) => [entry.taskId, entry.decision])
  );
  return ordered.flatMap((taskId): CommitmentRow[] => {
    const task = byId.get(taskId);
    if (!task) return [];
    if (task.status === "done") return [{ task, decided: null, marked: "done" as const }];
    if (task.status === "archived") return [{ task, decided: null, marked: "archived" as const }];
    if (unavailableTaskIds.includes(task.id))
      return [{ task, decided: null, marked: "unavailable" as const }];
    if (task.dueAt !== null && localDay(task.dueAt, timeZone) === tomorrowKey)
      return [{ task, decided: "tomorrow" as const, marked: null }];
    const decision = saved.get(task.id);
    if (decision === "commit") return [{ task, decided: "tomorrow" as const, marked: null }];
    if (decision === "defer") return [{ task, decided: "another-date" as const, marked: null }];
    if (decision === "drop") return [{ task, decided: "unscheduled" as const, marked: null }];
    return [{ task, decided: null, marked: null }];
  });
}

function overlaps(startMs: number, endMs: number, event: CalendarEventDto): boolean {
  return startMs < Date.parse(event.endsAt) && Date.parse(event.startsAt) < endMs;
}

/** First start at or after `fromMs` that fits `minutes` without an event, else null. */
function fitStart(
  fromMs: number,
  minutes: number,
  events: readonly CalendarEventDto[],
  tomorrowKey: string,
  timeZone: string
): number | null {
  let start = fromMs;
  for (let round = 0; round <= events.length; round++) {
    if (localDay(new Date(start), timeZone) !== tomorrowKey) return null;
    const clash = events.find((event) => overlaps(start, start + minutes * 60_000, event));
    if (!clash) return start;
    start = Date.parse(clash.endsAt);
  }
  return localDay(new Date(start), timeZone) === tomorrowKey ? start : null;
}

/** Full draft block list: kept rows pass through, saved proposals are replaced by fresh ones. */
export function proposeTomorrowBlocks(
  existingBlocks: readonly DayPlanBlockDto[],
  committedTaskIds: readonly string[],
  priorityTaskIds: readonly string[],
  capacity: DayPlanIntentCapacity,
  startWallTime: string,
  tasks: readonly TaskDto[],
  events: readonly CalendarEventDto[],
  tomorrowKey: string,
  timeZone: string,
  touchedIds: readonly string[] = []
): DayPlanBlockInput[] {
  const committed = new Set(committedTaskIds);
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  const orderedEvents = [...events].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const kept: DayPlanBlockInput[] = [];
  for (const block of existingBlocks) {
    if (block.actualPlacement?.startsAt == null) {
      if (block.pendingChange?.kind !== "move" && block.pendingChange?.kind !== "remove") continue;
    }
    kept.push({
      id: block.id,
      kind: block.kind,
      taskId: block.taskId,
      title: block.title,
      pendingChange: block.pendingChange ?? null
    });
  }
  const touched = new Set(
    existingBlocks.filter((block) => touchedIds.includes(block.id)).map((block) => block.taskId)
  );
  const covered = new Set(
    [...kept.map((block) => block.taskId), ...touched].filter(
      (taskId): taskId is string => taskId !== null
    )
  );
  const priorityCommitments = priorityTaskIds.filter((taskId) => committed.has(taskId));
  const followThroughCommitments = committedTaskIds.filter(
    (taskId) => !priorityTaskIds.includes(taskId)
  );
  const orderedCommitments = [...priorityCommitments, ...followThroughCommitments];
  // The steady-day choice means one main task plus one follow-through block.
  // Full day uses the open time for every selected commitment; light keeps its one priority block.
  const ordered =
    capacity === "light"
      ? priorityCommitments.slice(0, 1)
      : capacity === "normal"
        ? orderedCommitments.slice(0, 2)
        : orderedCommitments;
  let cursor = localTimeToIso(tomorrowKey, startWallTime, timeZone);
  const out = [...kept];
  for (const taskId of ordered) {
    if (covered.has(taskId)) continue;
    const minutes = effortMinutes(byTask.get(taskId)?.effort ?? null);
    let startsAt: string | null = null;
    if (cursor !== null) {
      const fit = fitStart(Date.parse(cursor), minutes, orderedEvents, tomorrowKey, timeZone);
      if (fit !== null) {
        startsAt = new Date(fit).toISOString();
        cursor = new Date(fit + minutes * 60_000).toISOString();
      }
    }
    // New rows carry no id; the draft assigns one, so a re-save never 404s.
    out.push({
      kind: "focus",
      taskId,
      title: null,
      pendingChange: startsAt === null ? null : { kind: "add", startsAt, durationMinutes: minutes }
    });
  }
  return out;
}

export interface EveningIntentChanges {
  readonly corrections: { taskId: string; note: string }[];
  readonly commitments: { taskId: string; decision: "tomorrow" | "another-date" | "unscheduled" }[];
  readonly capacity: DayPlanIntentCapacity | null;
  readonly priorityTaskIds: readonly string[] | null;
  readonly notes: string | null;
}

/**
 * Intent patch with only the fields the actor changed: corrections append to
 * the saved list, commitments merge by task, the rest send when dirty.
 */
export function eveningIntentPatchFor(
  saved: DayPlanEveningIntent | null,
  changes: EveningIntentChanges
): Partial<DayPlanEveningIntent> {
  const patch: Partial<DayPlanEveningIntent> = {};
  if (changes.corrections.length > 0) {
    patch.corrections = [
      ...(saved?.corrections ?? []),
      ...changes.corrections.map((entry) => ({ ...entry, source: "actor" as const }))
    ];
  }
  if (changes.commitments.length > 0) {
    const merged = new Map(
      (saved?.commitments ?? []).map((entry) => [entry.taskId, entry.decision])
    );
    for (const entry of changes.commitments) {
      if (entry.decision === "tomorrow") merged.set(entry.taskId, "commit");
      else if (entry.decision === "another-date") merged.set(entry.taskId, "defer");
      else merged.set(entry.taskId, "drop");
    }
    patch.commitments = [...merged].map(([taskId, decision]) => ({ taskId, decision }));
  }
  if (changes.capacity !== null) patch.capacity = changes.capacity;
  if (changes.priorityTaskIds !== null) patch.priorityTaskIds = [...changes.priorityTaskIds];
  if (changes.notes !== null) patch.notes = changes.notes;
  return patch;
}

export interface SaveStatusInput {
  readonly mode: "off" | "suggest" | "auto";
  readonly saved: boolean;
  readonly applied: number;
  readonly failed: number;
  readonly pending: number;
  readonly deniedReason: string | null;
  readonly needsConfirm: boolean;
}

/** Footer status line from the save result and this activation's counts. */
export function saveStatusLine(input: SaveStatusInput): string {
  if (!input.saved) return "Not saved yet.";
  if (input.needsConfirm) return "Confirm the calendar changes to finish saving.";
  if (input.deniedReason !== null) return `The calendar refused the batch: ${input.deniedReason}`;
  if (input.mode === "off") return "Saved. The calendar is off, so nothing was written to it.";
  if (input.mode === "suggest") return "Saved. The blocks are proposed for the morning.";
  if (input.failed + input.pending > 0)
    return `Saved. Applied ${input.applied}; ${input.failed} failed; ${input.pending} pending.`;
  return "Tomorrow is ready.";
}
