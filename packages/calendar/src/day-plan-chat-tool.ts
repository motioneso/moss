// Single chat write for the evening interview (R3.1-T21). Saves typed intent
// and untimed additions to tomorrow's plan draft. It never touches the
// calendar: there is no preview, apply, confirm or retry path here, and new
// tasks land as the same dateless proposal rows the dialog writes when the
// day has no room. A time is only ever given later in the dialog review.
import { assertDataContextDb } from "@moss/db";
import { HttpError, type ToolContext, type ToolExecute, type ToolResult } from "@moss/module-sdk";
import type { DayPlanBlockInput, DayPlanEveningIntent } from "@moss/shared";

import { DayPlanValidationError, normalizeEveningIntent } from "./day-plan-model.js";
import type { DayPlanRepository } from "./day-plan-repository.js";

export const DAY_PLAN_DRAFT_TOOL_NAME = "calendar.dayPlanDraft";

// Times, moves, removals and recorded placement stay dialog-only. Any of
// these keys in the tool input is rejected so a chat turn cannot smuggle a
// calendar effect past the input schema.
const FORBIDDEN_TOP_LEVEL_KEYS = new Set([
  "startsAt",
  "endsAt",
  "durationMinutes",
  "pendingChange",
  "actualPlacement",
  "kind",
  "position",
  "blocks",
  "move",
  "remove",
  "times",
  "placement"
]);

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "planId",
  "expectedRevision",
  "eveningIntent",
  "additions"
]);

interface DraftAddition {
  readonly taskId: string;
  readonly title: string | null;
}

function invalid(message: string): HttpError {
  return new HttpError(400, message);
}

function readAdditions(value: unknown): DraftAddition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("additions must be a list");
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw invalid(`additions[${index}] must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== "taskId" && key !== "title") {
        throw invalid(`additions[${index}] must only carry taskId and title`);
      }
    }
    const record = entry as Record<string, unknown>;
    const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
    if (!taskId) throw invalid(`additions[${index}] must reference a task`);
    const title =
      record.title === null || record.title === undefined
        ? null
        : String(record.title).trim() || null;
    return { taskId, title };
  });
}

function localDayOf(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

function nextLocalDayOf(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + 1, 12)).toISOString().slice(0, 10);
}

function actorDayWindow(ctx: ToolContext, planTimeZone: string): Set<string> {
  const zone = ctx.localTimezone ?? planTimeZone;
  let today: string;
  try {
    today = localDayOf(new Date(), zone);
  } catch {
    today = localDayOf(new Date(), planTimeZone);
  }
  return new Set([today, nextLocalDayOf(today)]);
}

async function runDraft(
  repository: DayPlanRepository,
  scopedDb: unknown,
  rawInput: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  assertDataContextDb(scopedDb);
  for (const key of Object.keys(rawInput)) {
    if (FORBIDDEN_TOP_LEVEL_KEYS.has(key)) {
      throw invalid(`${key} is not accepted from chat; times and placement stay in the dialog`);
    }
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) throw invalid(`${key} is not a plan-draft field`);
  }
  const planId = typeof rawInput.planId === "string" ? rawInput.planId.trim() : "";
  if (!planId) throw invalid("planId is required");
  if (!Number.isInteger(rawInput.expectedRevision) || (rawInput.expectedRevision as number) < 1) {
    throw invalid("expectedRevision must be a positive integer");
  }
  const additions = readAdditions(rawInput.additions);
  if (rawInput.eveningIntent !== undefined) {
    try {
      normalizeEveningIntent(rawInput.eveningIntent);
    } catch (error) {
      if (error instanceof DayPlanValidationError) throw invalid(error.message);
      throw error;
    }
  }

  const plan = await repository.getById(scopedDb, planId);
  if (!plan) throw new HttpError(404, "day plan is not available");
  if (!actorDayWindow(ctx, plan.timeZone).has(plan.localDay)) {
    throw invalid(`day plan for ${plan.localDay} is outside the current chat window`);
  }
  const covered = new Set(
    plan.blocks.map((block) => block.taskId).filter((id): id is string => id !== null)
  );
  for (const addition of additions) {
    if (covered.has(addition.taskId)) {
      throw invalid(`task ${addition.taskId} already has a block in this plan`);
    }
  }

  const blocks: DayPlanBlockInput[] = plan.blocks.map((block) => ({
    id: block.id,
    kind: block.kind,
    taskId: block.taskId,
    title: block.title,
    pendingChange: block.pendingChange
  }));
  for (const addition of additions) {
    blocks.push({
      kind: "focus",
      taskId: addition.taskId,
      title: addition.title,
      pendingChange: null
    });
  }
  const saved = await repository.saveDraft(scopedDb, {
    planId,
    localDay: plan.localDay,
    timeZone: plan.timeZone,
    expectedRevision: rawInput.expectedRevision as number,
    ...(rawInput.eveningIntent !== undefined
      ? { eveningIntent: rawInput.eveningIntent as Partial<DayPlanEveningIntent> | null }
      : {}),
    blocks
  });
  return {
    data: {
      planId: saved.id,
      revision: saved.revision,
      addedCount: additions.length,
      message:
        `Draft saved for review as revision ${saved.revision}. ` +
        `New tasks are untimed proposals; accept them in the Plan tomorrow dialog ` +
        `and its review to schedule anything.`
    }
  };
}

let wiredRepository: DayPlanRepository | null = null;

// Composition wires the shared day-plan repository at startup, so this
// module never imports the tasks store directly.
export function setDayPlanDraftRepository(repository: DayPlanRepository): void {
  wiredRepository = repository;
}

export function createDayPlanDraftExecute(repository: DayPlanRepository): ToolExecute {
  return async (scopedDb, input, ctx) => runDraft(repository, scopedDb, input, ctx);
}

export const dayPlanDraftExecute: ToolExecute = async (scopedDb, input, ctx) => {
  if (!wiredRepository) throw new HttpError(503, "day plan draft tool is unavailable");
  return runDraft(wiredRepository, scopedDb, input, ctx);
};

export function summarizeDayPlanDraft(input: Record<string, unknown>): string {
  const count = Array.isArray(input.additions) ? input.additions.length : 0;
  const intent = input.eveningIntent !== undefined ? "intent" : null;
  const parts = [intent, count === 1 ? "1 addition" : `${count} additions`].filter(
    (part): part is string => part !== null
  );
  return `Save ${parts.length > 0 ? parts.join(" and ") : "no changes"} to the day-plan draft for review (no calendar change).`;
}
