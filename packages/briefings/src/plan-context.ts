import {
  localDay,
  type BriefingPlanBlockV1,
  type BriefingPlanCommitmentV1,
  type BriefingPlanContextV1,
  type BriefingPlanEveningIntentV1,
  type BriefingPlanIntentCorrectionV1,
  type DayPlanBlockDto,
  type DayPlanDto,
  type DayPlanEveningIntent
} from "@moss/shared";
import type { BriefingDefinition, DataContextDb } from "@moss/db";

import type { BriefingGap, ComposeDeps } from "./compose-shared.js";
import { withToolSavepoint } from "./savepoint.js";
import { timezoneFor } from "./schedule.js";
import { sanitizeExternal } from "./trust-boundary.js";

/** Structural read port for the actor's saved day plan. The calendar repository satisfies it. */
export interface DayPlanReadPort {
  getForDay(
    scopedDb: DataContextDb,
    input: { readonly localDay: string; readonly timeZone: string }
  ): Promise<DayPlanDto | undefined>;
}

const BLOCK_CAP = 24;
const PRIORITY_TASK_ID_CAP = 8;
const CORRECTION_CAP = 8;
const COMMITMENT_CAP = 16;
const NOTES_CAP = 400;
const CORRECTION_NOTE_CAP = 200;
const BLOCK_TITLE_CAP = 120;

function cut(value: string, max: number): string {
  const points = Array.from(value);
  return points.length > max ? points.slice(0, max).join("") : value;
}

function projectBlock(block: DayPlanBlockDto): BriefingPlanBlockV1 {
  const pending = block.pendingChange?.kind;
  const timed =
    block.pendingChange?.kind === "add" || block.pendingChange?.kind === "move"
      ? block.pendingChange
      : null;
  return {
    id: block.id,
    kind: block.kind,
    taskId: block.taskId,
    title: block.title === null ? null : cut(sanitizeExternal(block.title), BLOCK_TITLE_CAP),
    position: block.position,
    actualPlacement: block.actualPlacement
      ? {
          startsAt: block.actualPlacement.startsAt,
          durationMinutes: block.actualPlacement.durationMinutes,
          calendarEventRef: block.actualPlacement.calendarEventRef
        }
      : null,
    pendingChange: pending === "add" || pending === "move" || pending === "remove" ? pending : null,
    ...(timed
      ? { pendingStartsAt: timed.startsAt, pendingDurationMinutes: timed.durationMinutes }
      : {})
  };
}

function projectIntent(intent: DayPlanEveningIntent): BriefingPlanEveningIntentV1 {
  const corrections: BriefingPlanIntentCorrectionV1[] = intent.corrections
    .slice(0, CORRECTION_CAP)
    .map((correction) => ({
      taskId: correction.taskId,
      note: cut(sanitizeExternal(correction.note), CORRECTION_NOTE_CAP),
      source: correction.source
    }));
  const commitments: BriefingPlanCommitmentV1[] = intent.commitments
    .slice(0, COMMITMENT_CAP)
    .map((commitment) => ({ taskId: commitment.taskId, decision: commitment.decision }));
  return {
    priorityTaskIds: intent.priorityTaskIds.slice(0, PRIORITY_TASK_ID_CAP),
    capacity: intent.capacity,
    notes: intent.notes === null ? null : cut(sanitizeExternal(intent.notes), NOTES_CAP),
    corrections,
    commitments
  };
}

/**
 * Pure projection of a saved plan into briefing context. Bounded and
 * sanitized; carries no task body, email or calendar content.
 */
export function projectPlanContext(plan: DayPlanDto): BriefingPlanContextV1 {
  return {
    version: 1,
    planId: plan.id,
    revision: plan.revision,
    localDay: plan.localDay,
    timeZone: plan.timeZone,
    sourceRunId: plan.sourceRunId,
    eveningIntent: plan.eveningIntent ? projectIntent(plan.eveningIntent) : null,
    blocks: plan.blocks.slice(0, BLOCK_CAP).map(projectBlock)
  };
}

export interface ResolvedPlanContext {
  /** True when a port was supplied, so the payload carries the key even when null. */
  readonly present: boolean;
  readonly planContext: BriefingPlanContextV1 | null;
  readonly planSnapshot?: BriefingPlanContextV1;
}

/**
 * Resolve the actor's saved plan for the run's local day. Absent port keeps
 * the output byte-identical to the base. No plan yields null with no gap; a
 * thrown read yields null plus exactly one day_plan/tool_failed gap. The run
 * always succeeds. The read is a scoped database read inside the generation
 * transaction; it performs no write and no network call.
 */
export async function resolvePlanContext(
  scopedDb: DataContextDb,
  definition: BriefingDefinition,
  now: Date,
  deps: ComposeDeps,
  gaps: BriefingGap[]
): Promise<ResolvedPlanContext> {
  const port: DayPlanReadPort | undefined = deps.dayPlanRead;
  if (!port) {
    return { present: false, planContext: null };
  }
  const timeZone = timezoneFor(definition.schedule_metadata);
  const day = localDay(now, timeZone);
  let plan: DayPlanDto | undefined;
  try {
    plan = await withToolSavepoint(scopedDb, () =>
      port.getForDay(scopedDb, { localDay: day, timeZone })
    );
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    deps.logger?.error(
      {
        event: "briefing_tool_failed",
        tool: "day_plan.read",
        error: e.name,
        message: e.message.slice(0, 200)
      },
      "briefing day plan read failed"
    );
    gaps.push({ source: "day_plan", reason: "tool_failed" });
    return { present: true, planContext: null };
  }
  if (!plan) {
    return { present: true, planContext: null };
  }
  const planContext = projectPlanContext(plan);
  return { present: true, planContext, planSnapshot: planContext };
}
