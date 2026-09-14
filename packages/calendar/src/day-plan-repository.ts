// Day-plan storage repository (R2.2-T01). Calendar owns the draft aggregate:
// one plan per actor and local day plus typed blocks as reservations against
// canonical Tasks rows. Task reachability goes through an injected lookup
// backed by the public Tasks repository, never a direct Tasks table read.
// Draft writes are revision-guarded and never call providers.
import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type {
  ApplyItemResult,
  DayPlanActualPlacement,
  DayPlanApplyBatchDto,
  DayPlanApplyBatchInput,
  DayPlanApplySelectionEntry,
  DayPlanBlockDto,
  DayPlanBlockInput,
  DayPlanCreateInput,
  DayPlanDto,
  DayPlanEveningIntent,
  DayPlanOperationDto,
  DayPlanOperationInput,
  DayPlanOperationOutcome,
  DayPlanPendingChange,
  DayPlanSaveInput
} from "@moss/shared";
import { assertDataContextDb, type DataContextDb, type DayPlan, type DayPlanBlock } from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import {
  DAY_PLAN_APPLY_BATCH_KIND,
  applyIntentsEqual,
  applySelectionsEqual,
  normalizeApplyIntent,
  pendingChangesEqual,
  readBatchSnapshot,
  resolveApplySelection,
  toBatchDto
} from "./day-plan-apply.js";
import {
  type DayPlanPlacedBlockInput,
  DayPlanValidationError,
  emptyEveningIntent,
  mergeEveningIntent,
  normalizeBlockInput,
  normalizeEveningIntent,
  normalizeIdempotencyKey,
  normalizeLocalDay,
  normalizeOperationKind,
  normalizeOperationOutcome,
  normalizeSourceRunId,
  normalizeTimeZone
} from "./day-plan-model.js";
import { normalizeAppendBlockInput } from "./day-plan-auto.js";

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
      for (const correction of intent.corrections) {
        if (correction.taskId !== null) {
          await this.requireOwnedTask(scopedDb, actorUserId, correction.taskId, "correction");
        }
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

  async getById(scopedDb: DataContextDb, planId: string): Promise<DayPlanDto | undefined> {
    assertDataContextDb(scopedDb);
    const plan = await scopedDb.db
      .selectFrom("app.day_plans")
      .selectAll()
      .select(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
      .where("id", "=", planId)
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

  // Appends blocks with caller-chosen ids (R2.3-T06 automatic effects use
  // deterministic ids so a duplicate fire converges instead of doubling).
  // Same guards as a draft save: expected revision must match (409), block
  // tasks must be owned, and the revision bumps once. Ids already present
  // are skipped, never duplicated.
  async appendBlocks(
    scopedDb: DataContextDb,
    input: Omit<DayPlanSaveInput, "blocks"> & {
      planId: string;
      blocks?: readonly (DayPlanBlockInput | DayPlanPlacedBlockInput)[];
    }
  ): Promise<DayPlanDto> {
    assertDataContextDb(scopedDb);
    let localDay: string;
    let timeZone: string;
    let blocks: ReturnType<typeof normalizeAppendBlockInput>[];
    try {
      localDay = normalizeLocalDay(input.localDay);
      timeZone = normalizeTimeZone(input.timeZone);
      if (!Array.isArray(input.blocks)) {
        throw new DayPlanValidationError("blocks must be a list");
      }
      blocks = input.blocks.map(normalizeAppendBlockInput);
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
    await this.requireOwnedTasks(scopedDb, actorUserId, null, blocks);
    const stored = await this.loadBlocks(scopedDb, input.planId);
    const present = new Set(stored.map((row) => row.id));
    const fresh = blocks.filter((block) => block.id === undefined || !present.has(block.id));
    let position = stored.reduce((max, row) => Math.max(max, row.position), -1) + 1;
    for (const block of fresh) {
      await scopedDb.db
        .insertInto("app.day_plan_blocks")
        .values({
          id: block.id ?? randomUUID(),
          plan_id: input.planId,
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          task_id: block.taskId,
          kind: block.kind,
          title: block.title,
          actual_placement: (block.actualPlacement ?? null) as unknown as Record<
            string,
            unknown
          > | null,
          pending_change: (block.pendingChange ?? null) as unknown as Record<
            string,
            unknown
          > | null,
          position: position++
        })
        .execute();
    }
    const updated = await scopedDb.db
      .updateTable("app.day_plans")
      .set({ revision: current.revision + 1, updated_at: new Date() })
      .where("id", "=", current.id)
      .where("revision", "=", current.revision)
      .returningAll()
      .returning(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
      .executeTakeFirst();
    if (!updated) throw new HttpError(409, "day plan changed since it was read");
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

  // Reads one reserved apply batch with its per-item records. Returns undefined
  // when no batch header was reserved under this identity.
  async getApplyBatch(
    scopedDb: DataContextDb,
    input: { planId: string; idempotencyKey: string }
  ): Promise<DayPlanApplyBatchDto | undefined> {
    assertDataContextDb(scopedDb);
    const header = await scopedDb.db
      .selectFrom("app.day_plan_operations")
      .selectAll()
      .where("plan_id", "=", input.planId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    if (!header || header.kind !== DAY_PLAN_APPLY_BATCH_KIND) return undefined;
    const items = await scopedDb.db
      .selectFrom("app.day_plan_operation_items")
      .selectAll()
      .where("operation_id", "=", header.id)
      .execute();
    return toBatchDto(header, items);
  }

  // Reads one reserved apply batch by its operation id within one plan.
  // Returns undefined when no batch header exists under this identity or it
  // belongs to another plan — both look the same so operations cannot be
  // probed across plans.
  async getApplyBatchById(
    scopedDb: DataContextDb,
    input: { planId: string; operationId: string }
  ): Promise<DayPlanApplyBatchDto | undefined> {
    assertDataContextDb(scopedDb);
    const header = await scopedDb.db
      .selectFrom("app.day_plan_operations")
      .selectAll()
      .where("id", "=", input.operationId)
      .where("plan_id", "=", input.planId)
      .executeTakeFirst();
    if (!header || header.kind !== DAY_PLAN_APPLY_BATCH_KIND) return undefined;
    const items = await scopedDb.db
      .selectFrom("app.day_plan_operation_items")
      .selectAll()
      .where("operation_id", "=", header.id)
      .execute();
    return toBatchDto(header, items);
  }

  // Reserves one durable apply batch before any provider mutation: the reviewed
  // explicit selection plus every still-pending addition, frozen as an immutable
  // snapshot under one operation identity with stable per-item pending records.
  // A reservation is a durable fact: an exact replay — same actor, plan, key,
  // original expected revision, operation key and normalized intent — returns the
  // stored reservation even after the plan revision advances. Any difference
  // conflicts, and a fresh key against a stale revision is rejected. Every write
  // runs inside the caller's data-context transaction, so a failed item leaves no
  // partial rows. No route exposes this; execution belongs to later work.
  async reserveApplyBatch(
    scopedDb: DataContextDb,
    input: DayPlanApplyBatchInput
  ): Promise<DayPlanApplyBatchDto> {
    assertDataContextDb(scopedDb);
    let idempotencyKey: string;
    try {
      idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    } catch (error) {
      if (error instanceof DayPlanValidationError)
        throw new HttpError(400, (error as Error).message);
      throw error;
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new HttpError(400, "expectedRevision must be a positive integer");
    }
    if (input.selectedBlockIds !== undefined && !Array.isArray(input.selectedBlockIds)) {
      throw new HttpError(400, "selectedBlockIds must be a list");
    }
    const intent = normalizeApplyIntent(input.selectedBlockIds);
    const operationKey = input.operationKey ?? null;
    const plan = await scopedDb.db
      .selectFrom("app.day_plans")
      .selectAll()
      .select(sql<string>`to_char(local_day, 'YYYY-MM-DD')`.as("local_day"))
      .where("id", "=", input.planId)
      // Serialize reservations with draft revision updates in this transaction.
      .forUpdate()
      .executeTakeFirst();
    if (!plan) throw new HttpError(404, "day plan is not available");
    const replayed = await this.readMatchingBatch(
      scopedDb,
      plan.id,
      input.expectedRevision,
      idempotencyKey,
      operationKey,
      intent
    );
    if (replayed === null) {
      throw new HttpError(409, "idempotency key is already used for a different operation");
    }
    if (replayed !== undefined) return replayed;
    if (plan.revision !== input.expectedRevision) {
      throw new HttpError(409, "day plan changed since it was read");
    }
    const stored = await this.loadBlocks(scopedDb, plan.id);
    let selection: DayPlanApplySelectionEntry[];
    try {
      selection = resolveApplySelection(
        stored.map((row) => ({
          id: row.id,
          position: row.position,
          pendingChange: readPending(row.pending_change)
        })),
        input.selectedBlockIds
      );
    } catch (error) {
      if (error instanceof DayPlanValidationError)
        throw new HttpError(400, (error as Error).message);
      throw error;
    }
    if (selection.length === 0) {
      throw new HttpError(400, "no pending changes to reserve");
    }
    const settled = await this.settleBatchHeader(
      scopedDb,
      plan.id,
      input.expectedRevision,
      idempotencyKey,
      operationKey,
      intent,
      selection
    );
    const items = await scopedDb.db
      .selectFrom("app.day_plan_operation_items")
      .selectAll()
      .where("operation_id", "=", settled.id)
      .execute();
    return toBatchDto(settled, items);
  }

  // Returns the stored batch when the request repeats the reservation exactly,
  // undefined when no header exists under this identity, and null when a header
  // exists but differs — a conflicting reuse of the idempotency key.
  private async readMatchingBatch(
    scopedDb: DataContextDb,
    planId: string,
    expectedRevision: number,
    idempotencyKey: string,
    operationKey: string | null,
    intent: readonly string[]
  ): Promise<DayPlanApplyBatchDto | undefined | null> {
    const header = await scopedDb.db
      .selectFrom("app.day_plan_operations")
      .selectAll()
      .where("plan_id", "=", planId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (!header) return undefined;
    if (header.kind !== DAY_PLAN_APPLY_BATCH_KIND) return null;
    const snapshot = readBatchSnapshot(header.selection_snapshot);
    if (
      header.expected_revision !== expectedRevision ||
      header.operation_key !== operationKey ||
      snapshot.intent === null ||
      !applyIntentsEqual(snapshot.intent, intent)
    ) {
      return null;
    }
    const items = await scopedDb.db
      .selectFrom("app.day_plan_operation_items")
      .selectAll()
      .where("operation_id", "=", header.id)
      .execute();
    return toBatchDto(header, items);
  }

  private async settleBatchHeader(
    scopedDb: DataContextDb,
    planId: string,
    expectedRevision: number,
    idempotencyKey: string,
    operationKey: string | null,
    intent: readonly string[],
    selection: DayPlanApplySelectionEntry[]
  ) {
    const matches = (header: {
      kind: string;
      expected_revision: number;
      operation_key: string | null;
      selection_snapshot: unknown;
    }): boolean => {
      if (
        header.kind !== DAY_PLAN_APPLY_BATCH_KIND ||
        header.expected_revision !== expectedRevision ||
        header.operation_key !== operationKey
      ) {
        return false;
      }
      const snapshot = readBatchSnapshot(header.selection_snapshot);
      return (
        snapshot.intent !== null &&
        applyIntentsEqual(snapshot.intent, intent) &&
        applySelectionsEqual(snapshot.selection, selection)
      );
    };
    const existing = await scopedDb.db
      .selectFrom("app.day_plan_operations")
      .selectAll()
      .where("plan_id", "=", planId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      if (!matches(existing)) {
        throw new HttpError(409, "idempotency key is already used for a different operation");
      }
      return existing;
    }
    const inserted = await scopedDb.db
      .insertInto("app.day_plan_operations")
      .values({
        id: randomUUID(),
        plan_id: planId,
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        operation_key: operationKey,
        block_id: null,
        kind: DAY_PLAN_APPLY_BATCH_KIND,
        idempotency_key: idempotencyKey,
        expected_revision: expectedRevision,
        outcome: "pending",
        // Arrays reach node-postgres as Postgres arrays, never JSON, so the
        // snapshot is stringified on write and parsed back as jsonb on read.
        selection_snapshot: JSON.stringify({ intent, selection })
      })
      .onConflict((oc) => oc.columns(["owner_user_id", "plan_id", "idempotency_key"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) {
      await scopedDb.db
        .insertInto("app.day_plan_operation_items")
        .values(
          selection.map((entry) => ({
            id: randomUUID(),
            operation_id: inserted.id,
            plan_id: planId,
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            block_id: entry.blockId,
            kind: entry.kind,
            pending_change: entry as unknown as Record<string, unknown>,
            outcome: "pending" as const
          }))
        )
        .execute();
      return inserted;
    }
    const raced = await scopedDb.db
      .selectFrom("app.day_plan_operations")
      .selectAll()
      .where("plan_id", "=", planId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirstOrThrow();
    if (!matches(raced)) {
      throw new HttpError(409, "idempotency key is already used for a different operation");
    }
    return raced;
  }

  // Records one item's execution outcome with its typed result. Finalization
  // runs in its own short actor-scoped transaction per item.
  async recordItemResult(
    scopedDb: DataContextDb,
    input: {
      itemId: string;
      operationId: string;
      outcome: DayPlanOperationOutcome;
      result: ApplyItemResult;
    }
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    let outcome: DayPlanOperationOutcome;
    try {
      outcome = normalizeOperationOutcome(input.outcome);
    } catch (error) {
      if (error instanceof DayPlanValidationError)
        throw new HttpError(400, (error as Error).message);
      throw error;
    }
    const updated = await scopedDb.db
      .updateTable("app.day_plan_operation_items")
      .set({
        outcome,
        result: JSON.stringify(input.result),
        updated_at: new Date()
      })
      .where("id", "=", input.itemId)
      .where("operation_id", "=", input.operationId)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new HttpError(404, "day plan operation item is not available");
    }
  }

  // Mirrors a verified provider success onto the plan block only when the block
  // still carries exactly the frozen pending change: sets the recorded
  // placement and clears the proposal. A concurrently changed draft is
  // preserved and reported as a mismatch instead.
  async mirrorAppliedBlock(
    scopedDb: DataContextDb,
    input: {
      planId: string;
      blockId: string;
      expectedPending: DayPlanPendingChange | null;
      actualPlacement: DayPlanActualPlacement;
    }
  ): Promise<"mirrored" | "mismatch"> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.day_plan_blocks")
      .selectAll()
      .where("id", "=", input.blockId)
      .where("plan_id", "=", input.planId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new HttpError(404, "day plan block is not available");
    if (!pendingChangesEqual(readPending(row.pending_change), input.expectedPending)) {
      return "mismatch";
    }
    await scopedDb.db
      .updateTable("app.day_plan_blocks")
      .set({
        actual_placement: input.actualPlacement as unknown as Record<string, unknown>,
        pending_change: null,
        updated_at: new Date()
      })
      .where("id", "=", input.blockId)
      .where("plan_id", "=", input.planId)
      .execute();
    // A mirrored placement is a plan change like any draft save: the revision
    // advances in the same transaction so a stale draft can never re-propose
    // an addition that is already on the calendar. A mismatch preserves both
    // the newer draft and its revision.
    await scopedDb.db
      .updateTable("app.day_plans")
      .set({ revision: sql<number>`revision + 1` })
      .where("id", "=", input.planId)
      .execute();
    return "mirrored";
  }
}

export { DayPlanValidationError };
export type { DayPlanBlockInput };
