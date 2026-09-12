// Day-plan storage repository (R2.2-T01). Calendar owns the draft aggregate:
// one plan per actor and local day plus typed blocks as reservations against
// canonical Tasks rows. Task reachability goes through an injected lookup
// backed by the public Tasks repository, never a direct Tasks table read.
// Draft writes are revision-guarded and never call providers.
import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type {
  DayPlanActualPlacement,
  DayPlanBlockDto,
  DayPlanBlockInput,
  DayPlanCreateInput,
  DayPlanDto,
  DayPlanEveningIntent,
  DayPlanOperationDto,
  DayPlanOperationInput,
  DayPlanPendingChange,
  DayPlanSaveInput
} from "@moss/shared";
import { assertDataContextDb, type DataContextDb, type DayPlan, type DayPlanBlock } from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import {
  DayPlanValidationError,
  emptyEveningIntent,
  mergeEveningIntent,
  normalizeBlockInput,
  normalizeEveningIntent,
  normalizeIdempotencyKey,
  normalizeLocalDay,
  normalizeOperationKind,
  normalizeSourceRunId,
  normalizeTimeZone
} from "./day-plan-model.js";

export interface DayPlanTaskLookup {
  (
    scopedDb: DataContextDb,
    taskId: string
  ): Promise<{ id: string; ownerUserId: string } | undefined>;
}

export interface DayPlanRepositoryDeps {
  findTask: DayPlanTaskLookup;
}

function readPlacement(value: unknown): DayPlanActualPlacement | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    startsAt: typeof row.startsAt === "string" ? row.startsAt : null,
    durationMinutes: typeof row.durationMinutes === "number" ? row.durationMinutes : null,
    calendarEventRef: typeof row.calendarEventRef === "string" ? row.calendarEventRef : null
  };
}

function readPending(value: unknown): DayPlanPendingChange | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.kind === "remove") return { kind: "remove" };
  if (
    (row.kind === "add" || row.kind === "move") &&
    typeof row.startsAt === "string" &&
    typeof row.durationMinutes === "number"
  ) {
    return { kind: row.kind, startsAt: row.startsAt, durationMinutes: row.durationMinutes };
  }
  return null;
}

function toIntentDto(value: unknown): DayPlanEveningIntent | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return emptyEveningIntent();
  const stored = value as Record<string, unknown>;
  const merged = mergeEveningIntent(emptyEveningIntent(), {
    ...(stored.priorityTaskIds !== undefined
      ? { priorityTaskIds: stored.priorityTaskIds as string[] }
      : {}),
    ...(stored.capacity !== undefined
      ? { capacity: stored.capacity as DayPlanEveningIntent["capacity"] }
      : {}),
    ...(stored.notes !== undefined ? { notes: stored.notes as string | null } : {}),
    ...(stored.corrections !== undefined ? { corrections: stored.corrections as never } : {}),
    ...(stored.commitments !== undefined ? { commitments: stored.commitments as never } : {})
  });
  return merged ?? emptyEveningIntent();
}

function toBlockDto(row: DayPlanBlock): DayPlanBlockDto {
  return {
    id: row.id,
    kind: row.kind,
    taskId: row.task_id,
    title: row.title,
    position: row.position,
    actualPlacement: readPlacement(row.actual_placement),
    pendingChange: readPending(row.pending_change)
  };
}

function toOperationDto(row: {
  id: string;
  plan_id: string;
  kind: string;
  idempotency_key: string;
  operation_key: string | null;
  block_id: string | null;
  expected_revision: number;
  outcome: string;
}): DayPlanOperationDto {
  return {
    id: row.id,
    planId: row.plan_id,
    kind: row.kind as DayPlanOperationDto["kind"],
    idempotencyKey: row.idempotency_key,
    operationKey: row.operation_key,
    blockId: row.block_id,
    expectedRevision: row.expected_revision,
    outcome: row.outcome as DayPlanOperationDto["outcome"],
    payload: {}
  };
}

function toPlanDto(plan: DayPlan, blocks: DayPlanBlock[]): DayPlanDto {
  return {
    id: plan.id,
    localDay: plan.local_day,
    timeZone: plan.time_zone,
    revision: plan.revision,
    sourceRunId: plan.source_run_id,
    blocks: blocks.map(toBlockDto),
    eveningIntent: toIntentDto(plan.evening_intent)
  };
}

export class DayPlanRepository {
  constructor(private readonly deps: DayPlanRepositoryDeps) {}

  private async currentActor(scopedDb: DataContextDb): Promise<string> {
    const result = await sql<{
      actor: string | null;
    }>`select app.current_actor_user_id() as actor`.execute(scopedDb.db);
    const actor = result.rows[0]?.actor;
    if (!actor) throw new HttpError(500, "day plan actor is unavailable");
    return actor;
  }

  private async requireOwnedTask(
    scopedDb: DataContextDb,
    actorUserId: string,
    taskId: string,
    field: string
  ): Promise<void> {
    const task = await this.deps.findTask(scopedDb, taskId);
    if (!task || task.ownerUserId !== actorUserId) {
      throw new HttpError(404, `day plan ${field} task is not available`);
    }
  }

  private async requireOwnedTasks(
    scopedDb: DataContextDb,
    actorUserId: string,
    intent: DayPlanEveningIntent | null,
    blocks: { taskId: string | null }[] | undefined
  ): Promise<void> {
    if (intent) {
      for (const taskId of intent.priorityTaskIds) {
        await this.requireOwnedTask(scopedDb, actorUserId, taskId, "priority");
      }
      for (const commitment of intent.commitments) {
        await this.requireOwnedTask(scopedDb, actorUserId, commitment.taskId, "commitment");
      }
    }
    if (blocks) {
      for (const block of blocks) {
        if (block.taskId !== null) {
          await this.requireOwnedTask(scopedDb, actorUserId, block.taskId, "block");
        }
      }
    }
  }

  private async loadBlocks(scopedDb: DataContextDb, planId: string): Promise<DayPlanBlock[]> {
    return scopedDb.db
      .selectFrom("app.day_plan_blocks")
      .selectAll()
      .where("plan_id", "=", planId)
      .orderBy("position", "asc")
      .orderBy("id", "asc")
      .execute();
  }

  async getForDay(
    scopedDb: DataContextDb,
    input: { localDay: string; timeZone: string }
  ): Promise<DayPlanDto | undefined> {
    assertDataContextDb(scopedDb);
    let localDay: string;
    let timeZone: string;
    try {
      localDay = normalizeLocalDay(input.localDay);
      timeZone = normalizeTimeZone(input.timeZone);
    } catch (error) {
      if (error instanceof DayPlanValidationError)
        throw new HttpError(400, (error as Error).message);
      throw error;
    }
    const plan = await scopedDb.db
      .selectFrom("app.day_plans")
      .selectAll()
      .select(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
      .where("local_day", "=", localDay)
      .where("time_zone", "=", timeZone)
      .executeTakeFirst();
    if (!plan) return undefined;
    return toPlanDto(plan, await this.loadBlocks(scopedDb, plan.id));
  }

  async createForDay(scopedDb: DataContextDb, input: DayPlanCreateInput): Promise<DayPlanDto> {
    assertDataContextDb(scopedDb);
    let localDay: string;
    let timeZone: string;
    let intent: DayPlanEveningIntent | null;
    let sourceRunId: string | null;
    try {
      localDay = normalizeLocalDay(input.localDay);
      timeZone = normalizeTimeZone(input.timeZone);
      intent = normalizeEveningIntent(input.eveningIntent ?? null);
      sourceRunId = normalizeSourceRunId(input.sourceRunId ?? null);
    } catch (error) {
      if (error instanceof DayPlanValidationError)
        throw new HttpError(400, (error as Error).message);
      throw error;
    }
    const existing = await scopedDb.db
      .selectFrom("app.day_plans")
      .selectAll()
      .select(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
      .where("local_day", "=", localDay)
      .where("time_zone", "=", timeZone)
      .executeTakeFirst();
    if (existing) return toPlanDto(existing, await this.loadBlocks(scopedDb, existing.id));

    const actorUserId = await this.currentActor(scopedDb);
    await this.requireOwnedTasks(scopedDb, actorUserId, intent, undefined);

    const plan = await scopedDb.db
      .insertInto("app.day_plans")
      .values({
        id: randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        local_day: localDay,
        time_zone: timeZone,
        revision: 1,
        evening_intent: (intent ?? emptyEveningIntent()) as unknown as Record<string, unknown>,
        source_run_id: sourceRunId
      })
      .onConflict((oc) => oc.columns(["owner_user_id", "local_day", "time_zone"]).doNothing())
      .returningAll()
      .returning(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
      .executeTakeFirst();

    const settled =
      plan ??
      (await scopedDb.db
        .selectFrom("app.day_plans")
        .selectAll()
        .select(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
        .where("local_day", "=", localDay)
        .where("time_zone", "=", timeZone)
        .executeTakeFirstOrThrow());
    return toPlanDto(settled, await this.loadBlocks(scopedDb, settled.id));
  }

  async saveDraft(
    scopedDb: DataContextDb,
    input: DayPlanSaveInput & { planId: string }
  ): Promise<DayPlanDto> {
    assertDataContextDb(scopedDb);
    let localDay: string;
    let timeZone: string;
    let blocks: ReturnType<typeof normalizeBlockInput>[] | undefined;
    let intentPatch: Partial<DayPlanEveningIntent> | null | undefined;
    try {
      localDay = normalizeLocalDay(input.localDay);
      timeZone = normalizeTimeZone(input.timeZone);
      if (input.blocks !== undefined && !Array.isArray(input.blocks)) {
        throw new DayPlanValidationError("blocks must be a list");
      }
      blocks = input.blocks === undefined ? undefined : input.blocks.map(normalizeBlockInput);
      intentPatch = input.eveningIntent;
      if (intentPatch !== undefined) mergeEveningIntent(emptyEveningIntent(), intentPatch ?? null);
    } catch (error) {
      if (error instanceof DayPlanValidationError)
        throw new HttpError(400, (error as Error).message);
      throw error;
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new HttpError(400, "expectedRevision must be a positive integer");
    }
    const actorUserId = await this.currentActor(scopedDb);
    const current = await scopedDb.db
      .selectFrom("app.day_plans")
      .selectAll()
      .select(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
      .where("id", "=", input.planId)
      .executeTakeFirst();
    if (!current || current.local_day !== localDay || current.time_zone !== timeZone) {
      throw new HttpError(404, "day plan is not available");
    }
    if (current.revision !== input.expectedRevision) {
      throw new HttpError(409, "day plan changed since it was read");
    }
    const mergedIntent = mergeEveningIntent(
      toIntentDto(current.evening_intent) ?? emptyEveningIntent(),
      intentPatch
    );
    await this.requireOwnedTasks(scopedDb, actorUserId, mergedIntent, blocks);

    const updated = await scopedDb.db
      .updateTable("app.day_plans")
      .set({
        revision: current.revision + 1,
        ...(mergedIntent !== null && intentPatch !== undefined
          ? {
              evening_intent: (mergedIntent ?? emptyEveningIntent()) as unknown as Record<
                string,
                unknown
              >
            }
          : {}),
        updated_at: new Date()
      })
      .where("id", "=", current.id)
      .where("revision", "=", current.revision)
      .returningAll()
      .returning(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
      .executeTakeFirst();
    if (!updated) throw new HttpError(409, "day plan changed since it was read");

    if (blocks !== undefined) {
      await this.replaceBlocks(scopedDb, updated.id, blocks);
    }
    return toPlanDto(updated, await this.loadBlocks(scopedDb, updated.id));
  }

  private async replaceBlocks(
    scopedDb: DataContextDb,
    planId: string,
    blocks: ReturnType<typeof normalizeBlockInput>[]
  ): Promise<void> {
    const stored = await scopedDb.db
      .selectFrom("app.day_plan_blocks")
      .selectAll()
      .where("plan_id", "=", planId)
      .execute();
    const storedById = new Map(stored.map((row) => [row.id, row]));
    const seen = new Set<string>();
    for (const [index, block] of blocks.entries()) {
      const storedRow = block.id !== undefined ? storedById.get(block.id) : undefined;
      if (block.id !== undefined && !storedRow) {
        throw new HttpError(404, "day plan block is not available");
      }
      // Leave recorded placement untouched; a draft only changes the proposal.
      if (storedRow) {
        seen.add(storedRow.id);
        await scopedDb.db
          .updateTable("app.day_plan_blocks")
          .set({
            task_id: block.taskId,
            kind: block.kind,
            title: block.title,
            pending_change: (block.pendingChange ?? null) as unknown as Record<
              string,
              unknown
            > | null,
            position: index,
            updated_at: new Date()
          })
          .where("id", "=", storedRow.id)
          .where("plan_id", "=", planId)
          .execute();
      } else {
        const id = block.id ?? randomUUID();
        seen.add(id);
        await scopedDb.db
          .insertInto("app.day_plan_blocks")
          .values({
            id,
            plan_id: planId,
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            task_id: block.taskId,
            kind: block.kind,
            title: block.title,
            actual_placement: null,
            pending_change: (block.pendingChange ?? null) as unknown as Record<
              string,
              unknown
            > | null,
            position: index
          })
          .execute();
      }
    }
    for (const row of stored) {
      if (!seen.has(row.id)) {
        if (row.actual_placement !== null) {
          throw new HttpError(400, "recorded placement requires a pending removal");
        }
        await scopedDb.db.deleteFrom("app.day_plan_blocks").where("id", "=", row.id).execute();
      }
    }
  }

  // Reserves one idempotent operation slot against the stored expected
  // revision. Execution, retries and provider calls belong to later work;
  // this only records the operation so a retried request settles once.
  async reserveOperation(
    scopedDb: DataContextDb,
    input: DayPlanOperationInput
  ): Promise<DayPlanOperationDto> {
    assertDataContextDb(scopedDb);
    let kind: DayPlanOperationInput["kind"];
    let idempotencyKey: string;
    try {
      kind = normalizeOperationKind(input.kind);
      idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    } catch (error) {
      if (error instanceof DayPlanValidationError)
        throw new HttpError(400, (error as Error).message);
      throw error;
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new HttpError(400, "expectedRevision must be a positive integer");
    }
    const plan = await scopedDb.db
      .selectFrom("app.day_plans")
      .selectAll()
      .select(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
      .where("id", "=", input.planId)
      // Serialize reservations with draft revision updates in this transaction.
      .forUpdate()
      .executeTakeFirst();
    if (!plan) throw new HttpError(404, "day plan is not available");
    if (plan.revision !== input.expectedRevision) {
      throw new HttpError(409, "day plan changed since it was read");
    }
    const existing = await scopedDb.db
      .selectFrom("app.day_plan_operations")
      .selectAll()
      .where("plan_id", "=", plan.id)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    const operationKey = input.operationKey ?? null;
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.expected_revision !== input.expectedRevision ||
        existing.operation_key !== operationKey ||
        existing.block_id !== (input.blockId ?? null)
      ) {
        throw new HttpError(409, "idempotency key is already used for a different operation");
      }
      return toOperationDto(existing);
    }
    if (input.blockId !== undefined && input.blockId !== null) {
      const block = await scopedDb.db
        .selectFrom("app.day_plan_blocks")
        .selectAll()
        .where("id", "=", input.blockId)
        .executeTakeFirst();
      if (!block || block.plan_id !== plan.id) {
        throw new HttpError(404, "day plan block is not available");
      }
    }
    const inserted = await scopedDb.db
      .insertInto("app.day_plan_operations")
      .values({
        id: randomUUID(),
        plan_id: plan.id,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        operation_key: input.operationKey ?? null,
        block_id: input.blockId ?? null,
        kind,
        idempotency_key: idempotencyKey,
        expected_revision: input.expectedRevision,
        outcome: "pending"
      })
      .onConflict((oc) => oc.columns(["owner_user_id", "plan_id", "idempotency_key"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return toOperationDto(inserted);
    const raced = await scopedDb.db
      .selectFrom("app.day_plan_operations")
      .selectAll()
      .where("plan_id", "=", plan.id)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirstOrThrow();
    if (
      raced.kind !== kind ||
      raced.expected_revision !== input.expectedRevision ||
      raced.operation_key !== operationKey ||
      raced.block_id !== (input.blockId ?? null)
    ) {
      throw new HttpError(409, "idempotency key is already used for a different operation");
    }
    return toOperationDto(raced);
  }
}

export { DayPlanValidationError };
export type { DayPlanBlockInput };
