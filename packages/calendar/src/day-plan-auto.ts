// Automatic plan effects for scheduled briefing runs (R2.3-T06).
//
// Composition emits typed intents only. This module turns block_time intents
// into plan blocks inside the generation transaction through public
// DayPlanRepository methods, then reserves one durable apply batch for the
// new blocks. Suggest-mode signals become proposal blocks with no reservation
// and no dispatch. Off-mode signals produce nothing.
import { createHash } from "node:crypto";

import type { DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import type { DayPlanRepository } from "./day-plan-repository.js";

export interface AutoPlanSignal {
  readonly type?: string;
  readonly summary: string;
  readonly suggestedActions: readonly string[];
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly followThrough?: {
    readonly targetRef: string;
    readonly taskId?: string;
    readonly intents?: readonly {
      readonly kind: "create_task" | "block_time";
      readonly targetRef: string;
      readonly title: string;
      readonly window?: {
        readonly start: string;
        readonly end: string;
        readonly durationMinutes: number;
      };
    }[];
  };
}

export interface ReserveAutoPlanInput {
  readonly runId: string;
  readonly definitionId: string;
  readonly localDay: string;
  readonly timeZone: string;
  readonly signals: readonly AutoPlanSignal[];
}

export interface ReserveAutoPlanResult {
  readonly planId: string;
  readonly autoBlockIds: readonly string[];
  readonly suggestBlockIds: readonly string[];
  // Null when nothing was reserved: suggest-only runs, or a revision race
  // where an interactive write landed first (the run still commits).
  readonly operationId: string | null;
  readonly batchKey: string | null;
  readonly revisionRace: boolean;
}

// Durable batch identity for one scheduled run. A duplicate fire reuses the
// key to resume the unfinished batch instead of composing another block.
export function dayPlanAutoBatchKey(runId: string): string {
  return `day-plan-auto:${runId}`;
}

// Deterministic block identity for one automatic effect, so a duplicate
// scheduled fire that reaches the plan step still converges on the same row.
export function dayPlanAutoBlockId(
  definitionId: string,
  localDay: string,
  targetRef: string
): string {
  const digest = createHash("sha256")
    .update(`${definitionId}|${localDay}|${targetRef}`)
    .digest("hex");
  return (
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-` +
    `8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  );
}

interface PlannedBlock {
  readonly id: string;
  readonly title: string;
  readonly taskId: string | null;
  readonly startsAt: string;
  readonly durationMinutes: number;
}

// Suggest-mode window from the signal itself. Mirrors the follow-through
// window rules: prep signals take the hour before the meeting, other signals
// are capped to the meeting window.
function suggestWindow(signal: AutoPlanSignal): {
  readonly startsAt: string;
  readonly durationMinutes: number;
} | null {
  const start = signal.startsAt ? new Date(signal.startsAt) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  if (signal.type === "prep_needed") {
    const prepStart = new Date(start.getTime() - 60 * 60_000);
    return { startsAt: prepStart.toISOString(), durationMinutes: 60 };
  }
  const end = signal.endsAt ? new Date(signal.endsAt) : null;
  if (!end || Number.isNaN(end.getTime()) || end <= start) return null;
  const durationMinutes = Math.min(
    120,
    Math.max(15, Math.floor((end.getTime() - start.getTime()) / 60_000))
  );
  return { startsAt: start.toISOString(), durationMinutes };
}

export async function reserveAutoPlanBlocks(
  repository: Pick<
    DayPlanRepository,
    "getForDay" | "createForDay" | "appendBlocks" | "reserveApplyBatch"
  >,
  scopedDb: DataContextDb,
  input: ReserveAutoPlanInput
): Promise<ReserveAutoPlanResult | null> {
  const auto: PlannedBlock[] = [];
  const suggest: PlannedBlock[] = [];
  for (const signal of input.signals) {
    const followThrough = signal.followThrough;
    const blockIntents = (followThrough?.intents ?? []).filter(
      (intent) => intent.kind === "block_time" && intent.window
    );
    for (const intent of blockIntents) {
      auto.push({
        id: dayPlanAutoBlockId(input.definitionId, input.localDay, intent.targetRef),
        title: signal.summary,
        taskId: followThrough?.taskId ?? null,
        startsAt: intent.window!.start,
        durationMinutes: intent.window!.durationMinutes
      });
    }
    if (blockIntents.length === 0 && signal.suggestedActions.includes("suggest_time_block")) {
      const window = suggestWindow(signal);
      if (!window) continue;
      const targetRef = followThrough?.targetRef ?? `suggest:${signal.type}:${signal.summary}`;
      suggest.push({
        id: dayPlanAutoBlockId(input.definitionId, input.localDay, targetRef),
        title: signal.summary,
        taskId: followThrough?.taskId ?? null,
        startsAt: window.startsAt,
        durationMinutes: window.durationMinutes
      });
    }
  }
  if (auto.length === 0 && suggest.length === 0) return null;

  const existing =
    (await repository.getForDay(scopedDb, {
      localDay: input.localDay,
      timeZone: input.timeZone
    })) ??
    (await repository.createForDay(scopedDb, {
      localDay: input.localDay,
      timeZone: input.timeZone,
      sourceRunId: input.runId
    }));

  // Skip blocks already present (deterministic ids converge duplicates).
  const present = new Set(existing.blocks.map((block) => block.id));
  const freshAuto = auto.filter((block) => !present.has(block.id));
  const freshSuggest = suggest.filter((block) => !present.has(block.id));
  if (freshAuto.length === 0 && freshSuggest.length === 0) {
    return {
      planId: existing.id,
      autoBlockIds: [],
      suggestBlockIds: [],
      operationId: null,
      batchKey: null,
      revisionRace: false
    };
  }

  // An interactive draft save can commit between the plan read above and
  // this append (the read holds no row lock). Its 409 is the real revision
  // race: like a reservation race, the run still commits with its facts and
  // nothing is dispatched. Anything else propagates and rolls the run back.
  let drafted;
  try {
    drafted = await repository.appendBlocks(scopedDb, {
      planId: existing.id,
      localDay: existing.localDay,
      timeZone: existing.timeZone,
      expectedRevision: existing.revision,
      blocks: [...freshAuto, ...freshSuggest].map((block) => ({
        id: block.id,
        kind: "focus" as const,
        taskId: block.taskId,
        title: block.title,
        pendingChange: {
          kind: "add" as const,
          startsAt: block.startsAt,
          durationMinutes: block.durationMinutes
        }
      }))
    });
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) {
      return {
        planId: existing.id,
        autoBlockIds: [],
        suggestBlockIds: [],
        operationId: null,
        batchKey: null,
        revisionRace: true
      };
    }
    throw error;
  }

  if (freshAuto.length === 0) {
    return {
      planId: drafted.id,
      autoBlockIds: [],
      suggestBlockIds: freshSuggest.map((block) => block.id),
      operationId: null,
      batchKey: null,
      revisionRace: false
    };
  }

  const batchKey = dayPlanAutoBatchKey(input.runId);
  const autoIds = freshAuto.map((block) => block.id);
  try {
    const batch = await repository.reserveApplyBatch(scopedDb, {
      planId: drafted.id,
      expectedRevision: drafted.revision,
      idempotencyKey: batchKey,
      selectedBlockIds: autoIds
    });
    return {
      planId: drafted.id,
      autoBlockIds: autoIds,
      suggestBlockIds: freshSuggest.map((block) => block.id),
      operationId: batch.id,
      batchKey,
      revisionRace: false
    };
  } catch (error) {
    // An interactive draft save that advanced the plan first wins: the run
    // still commits with its facts, and no provider event is ever created
    // twice for one block.
    if (error instanceof HttpError && error.statusCode === 409) {
      return {
        planId: drafted.id,
        autoBlockIds: autoIds,
        suggestBlockIds: freshSuggest.map((block) => block.id),
        operationId: null,
        batchKey: null,
        revisionRace: true
      };
    }
    throw error;
  }
}

// An unfinished batch for one scheduled run, if any: pending or unknown
// items still need the apply job; anything else stays settled.
export async function findUnfinishedAutoBatch(
  repository: Pick<DayPlanRepository, "getApplyBatch">,
  scopedDb: DataContextDb,
  input: { planId: string; batchKey: string }
): Promise<{ operationId: string } | undefined> {
  const batch = await repository.getApplyBatch(scopedDb, {
    planId: input.planId,
    idempotencyKey: input.batchKey
  });
  if (!batch) return undefined;
  const unfinished = batch.items.some(
    (item) => item.outcome === "pending" || item.outcome === "unknown"
  );
  return unfinished ? { operationId: batch.id } : undefined;
}

export interface DayPlanAutoPort {
  reserveAutoPlan(
    scopedDb: DataContextDb,
    input: ReserveAutoPlanInput
  ): Promise<ReserveAutoPlanResult | null>;
  findUnfinishedBatch(
    scopedDb: DataContextDb,
    input: { planId: string; batchKey: string }
  ): Promise<{ operationId: string } | undefined>;
}

// Adapts the module functions to the structural port the briefing worker
// consumes (briefings never imports this package, so the shapes match by
// structure, not by import).
export function buildDayPlanAutoPort(
  repository: Pick<
    DayPlanRepository,
    "getForDay" | "createForDay" | "appendBlocks" | "reserveApplyBatch" | "getApplyBatch"
  >
): DayPlanAutoPort {
  return {
    reserveAutoPlan: (scopedDb, input) => reserveAutoPlanBlocks(repository, scopedDb, input),
    findUnfinishedBatch: (scopedDb, input) => findUnfinishedAutoBatch(repository, scopedDb, input)
  };
}
