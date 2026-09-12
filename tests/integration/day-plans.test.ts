import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import {
  AuthSessionResolver,
  DataContextRunner,
  SharesRepository,
  createDatabase,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { DayPlanRepository } from "@moss/calendar";
import { TasksRepository } from "@moss/tasks";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const LOCAL_DAY = "2026-09-12";
const TIME_ZONE = "America/Los_Angeles";

function userAContext(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:user-a-day-plans" };
}

function userBContext(): AccessContext {
  return { actorUserId: ids.userB, requestId: "request:user-b-day-plans" };
}

async function createTaskFor(scopedDb: DataContextDb, title: string) {
  return new TasksRepository().create(scopedDb, {
    title,
    dueAt: "2026-09-14T18:00:00.000Z",
    doAt: "2026-09-12T16:00:00.000Z"
  });
}

async function seedActualBlock(
  planId: string,
  blockId: string,
  taskId: string,
  ownerUserId: string
): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `
        INSERT INTO app.day_plan_blocks
          (id, plan_id, owner_user_id, task_id, kind, title, actual_placement, position)
        VALUES ($1, $2, $3, $4, 'focus', 'Write the draft', $5::jsonb, 0)
      `,
      [
        blockId,
        planId,
        ownerUserId,
        taskId,
        JSON.stringify({
          startsAt: "2026-09-12T16:00:00.000Z",
          durationMinutes: 60,
          calendarEventRef: "fixture-event"
        })
      ]
    );
  } finally {
    await client.end();
  }
}

async function countCalendarEvents(ownerUserId: string): Promise<number> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM app.calendar_events WHERE owner_user_id = $1",
      [ownerUserId]
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

describe("day plan storage boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: DayPlanRepository;
  let sharesRepository: SharesRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    const tasks = new TasksRepository();
    repository = new DayPlanRepository({
      findTask: async (scopedDb, taskId) => {
        const row = await tasks.getById(scopedDb, taskId);
        return row ? { id: row.id, ownerUserId: row.owner_user_id } : undefined;
      }
    });
    sharesRepository = new SharesRepository();
  });

  afterAll(async () => {
    await Promise.allSettled([appDb?.destroy()]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("live acceptance", async () => {
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected provider request"));
    // Canonical task first: the plan only ever reserves against Tasks rows.
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      createTaskFor(scopedDb, "Write the draft")
    );
    const beforeTask = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      new TasksRepository().getById(scopedDb, task.id)
    );
    const beforeCalendarEvents = await countCalendarEvents(ids.userA);
    const sourceRunId = randomUUID();

    // Duplicate creation for one actor and day settles on a single plan.
    const first = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createForDay(scopedDb, {
        localDay: LOCAL_DAY,
        timeZone: TIME_ZONE,
        sourceRunId,
        eveningIntent: {
          priorityTaskIds: [task.id],
          capacity: "light",
          notes: "keep it small",
          corrections: [{ taskId: task.id, note: "moved from morning", source: "planner" }],
          commitments: [{ taskId: task.id, decision: "commit" }]
        }
      })
    );
    const second = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createForDay(scopedDb, { localDay: LOCAL_DAY, timeZone: TIME_ZONE })
    );
    expect(second.id).toBe(first.id);
    expect(first.localDay).toBe(LOCAL_DAY);
    expect(second.localDay).toBe(LOCAL_DAY);
    expect(second.revision).toBe(first.revision);
    expect(first.eveningIntent?.priorityTaskIds).toEqual([task.id]);
    expect(first.eveningIntent?.commitments).toEqual([{ taskId: task.id, decision: "commit" }]);
    expect(first.sourceRunId).toBe(sourceRunId);

    // Actual placement is seeded by the trusted fixture; draft input can only propose a change.
    const seededBlockId = randomUUID();
    await seedActualBlock(first.id, seededBlockId, task.id, ids.userA);
    const saved = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: first.id,
        localDay: LOCAL_DAY,
        timeZone: TIME_ZONE,
        expectedRevision: first.revision,
        blocks: [
          {
            id: seededBlockId,
            taskId: task.id,
            kind: "focus",
            title: "Write the draft",
            pendingChange: {
              kind: "move",
              startsAt: "2026-09-12T17:00:00.000Z",
              durationMinutes: 60
            }
          }
        ]
      })
    );
    expect(saved.revision).toBe(first.revision + 1);
    expect(saved.blocks).toHaveLength(1);
    expect(saved.blocks[0]?.id).toBe(seededBlockId);
    expect(saved.blocks[0]?.actualPlacement?.startsAt).toBe("2026-09-12T16:00:00.000Z");
    expect(saved.blocks[0]?.pendingChange).toEqual({
      kind: "move",
      startsAt: "2026-09-12T17:00:00.000Z",
      durationMinutes: 60
    });

    // A fresh context sees the same saved state.
    const reloaded = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getForDay(scopedDb, { localDay: LOCAL_DAY, timeZone: TIME_ZONE })
    );
    expect(reloaded?.id).toBe(first.id);
    expect(reloaded?.revision).toBe(saved.revision);
    expect(reloaded?.blocks[0]?.actualPlacement?.durationMinutes).toBe(60);
    expect(reloaded?.blocks[0]?.pendingChange?.kind).toBe("move");
    expect(reloaded?.eveningIntent?.notes).toBe("keep it small");
    expect(reloaded?.sourceRunId).toBe(sourceRunId);

    // A draft attempting to overwrite actual placement is rejected.
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.saveDraft(scopedDb, {
          planId: first.id,
          localDay: LOCAL_DAY,
          timeZone: TIME_ZONE,
          expectedRevision: saved.revision,
          blocks: [
            {
              id: seededBlockId,
              taskId: task.id,
              kind: "focus",
              title: "Write the draft",
              actualPlacement: {
                startsAt: "2026-09-12T18:00:00.000Z",
                durationMinutes: 30,
                calendarEventRef: null
              }
            } as never
          ]
        })
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    // An intent-only save preserves every block.
    const intentOnly = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: first.id,
        localDay: LOCAL_DAY,
        timeZone: TIME_ZONE,
        expectedRevision: saved.revision,
        eveningIntent: { notes: "still small" }
      })
    );
    expect(intentOnly.revision).toBe(saved.revision + 1);
    expect(intentOnly.blocks).toHaveLength(1);
    expect(intentOnly.blocks[0]?.pendingChange?.kind).toBe("move");
    expect(intentOnly.eveningIntent?.notes).toBe("still small");
    expect(intentOnly.eveningIntent?.capacity).toBe("light");

    // An explicit null clears one nullable field and keeps the rest.
    const clearedNote = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: first.id,
        localDay: LOCAL_DAY,
        timeZone: TIME_ZONE,
        expectedRevision: intentOnly.revision,
        eveningIntent: { notes: null }
      })
    );
    expect(clearedNote.eveningIntent?.notes).toBeNull();
    expect(clearedNote.eveningIntent?.capacity).toBe("light");
    expect(clearedNote.blocks).toHaveLength(1);

    // A null patch resets the complete intent, including values omitted by the caller.
    const resetIntent = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: first.id,
        localDay: LOCAL_DAY,
        timeZone: TIME_ZONE,
        expectedRevision: clearedNote.revision,
        eveningIntent: null
      })
    );
    expect(resetIntent.eveningIntent).toEqual({
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    });
    expect(resetIntent.blocks).toHaveLength(1);

    // Competing saves against the same revision lose, and the rejected save
    // leaves the aggregate unchanged.
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.saveDraft(scopedDb, {
          planId: first.id,
          localDay: LOCAL_DAY,
          timeZone: TIME_ZONE,
          expectedRevision: saved.revision,
          blocks: []
        })
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    const afterConflict = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getForDay(scopedDb, { localDay: LOCAL_DAY, timeZone: TIME_ZONE })
    );
    expect(afterConflict?.revision).toBe(resetIntent.revision);
    expect(afterConflict?.blocks).toHaveLength(1);

    // Block replacement is atomic with the revision update.
    const unknownBlockId = randomUUID();
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.saveDraft(scopedDb, {
          planId: first.id,
          localDay: LOCAL_DAY,
          timeZone: TIME_ZONE,
          expectedRevision: resetIntent.revision,
          blocks: [
            { id: seededBlockId, taskId: task.id, kind: "focus", title: "must roll back" },
            { id: unknownBlockId, taskId: null, kind: "break", title: null }
          ]
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    const afterRollback = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getForDay(scopedDb, { localDay: LOCAL_DAY, timeZone: TIME_ZONE })
    );
    expect(afterRollback?.revision).toBe(resetIntent.revision);
    expect(afterRollback?.blocks.map((block) => block.id)).toEqual([seededBlockId]);
    expect(afterRollback?.blocks).toEqual(resetIntent.blocks);

    // The canonical task keeps its identity, status and dates throughout.
    const afterTask = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      new TasksRepository().getById(scopedDb, task.id)
    );
    expect(afterTask?.id).toBe(beforeTask?.id);
    expect(afterTask?.status).toBe(beforeTask?.status);
    expect(afterTask?.due_at?.toISOString() ?? null).toBe(
      beforeTask?.due_at?.toISOString() ?? null
    );
    expect(afterTask?.do_at?.toISOString() ?? null).toBe(beforeTask?.do_at?.toISOString() ?? null);

    // Missing task links fail without implying success or touching canonical rows.
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.saveDraft(scopedDb, {
          planId: first.id,
          localDay: LOCAL_DAY,
          timeZone: TIME_ZONE,
          expectedRevision: resetIntent.revision,
          blocks: [{ taskId: randomUUID(), kind: "focus", title: null }]
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });

    // One idempotent operation slot per actor, plan and key.
    const operation = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveOperation(scopedDb, {
        planId: first.id,
        expectedRevision: resetIntent.revision,
        kind: "move",
        idempotencyKey: "op-move-1",
        operationKey: "apply-move-1",
        blockId: saved.blocks[0]?.id
      })
    );
    expect(operation.outcome).toBe("pending");
    expect(operation.planId).toBe(first.id);
    expect(operation.blockId).toBe(saved.blocks[0]?.id);
    const duplicate = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveOperation(scopedDb, {
        planId: first.id,
        expectedRevision: resetIntent.revision,
        kind: "move",
        idempotencyKey: "op-move-1",
        operationKey: "apply-move-1",
        blockId: saved.blocks[0]?.id
      })
    );
    expect(duplicate.id).toBe(operation.id);
    expect(duplicate.kind).toBe("move");
    for (const conflict of [
      { kind: "remove" as const },
      { operationKey: "other-operation" },
      { blockId: null }
    ]) {
      await expect(
        dataContext.withDataContext(userAContext(), (scopedDb) =>
          repository.reserveOperation(scopedDb, {
            planId: first.id,
            expectedRevision: resetIntent.revision,
            kind: "move",
            idempotencyKey: "op-move-1",
            operationKey: "apply-move-1",
            blockId: seededBlockId,
            ...conflict
          })
        )
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    const operationCount = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      scopedDb.db
        .selectFrom("app.day_plan_operations")
        .select(({ fn }) => [fn.countAll().as("count")])
        .where("plan_id", "=", first.id)
        .executeTakeFirstOrThrow()
    );
    expect(Number(operationCount.count)).toBe(1);

    // Another actor gets their own plan, but nothing of this one.
    const foreignPlan = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.createForDay(scopedDb, { localDay: LOCAL_DAY, timeZone: TIME_ZONE })
    );
    expect(foreignPlan.id).not.toBe(first.id);
    expect(foreignPlan.sourceRunId).toBeNull();
    const foreignRead = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.getForDay(scopedDb, { localDay: LOCAL_DAY, timeZone: TIME_ZONE })
    );
    expect(foreignRead?.id).toBe(foreignPlan.id);
    await expect(
      dataContext.withDataContext(userBContext(), (scopedDb) =>
        repository.saveDraft(scopedDb, {
          planId: first.id,
          localDay: LOCAL_DAY,
          timeZone: TIME_ZONE,
          expectedRevision: resetIntent.revision,
          blocks: []
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      dataContext.withDataContext(userBContext(), (scopedDb) =>
        repository.reserveOperation(scopedDb, {
          planId: first.id,
          expectedRevision: resetIntent.revision,
          kind: "move",
          idempotencyKey: "op-foreign-1"
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });

    // Direct database writes against another actor's hidden plan fail at the
    // ownership constraint, for both blocks and operations.
    await expect(
      dataContext.withDataContext(userBContext(), (scopedDb) =>
        scopedDb.db
          .insertInto("app.day_plan_blocks")
          .values({
            id: randomUUID(),
            plan_id: first.id,
            owner_user_id: ids.userB,
            task_id: null,
            kind: "focus",
            title: null,
            position: 0,
            updated_at: new Date()
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      dataContext.withDataContext(userBContext(), (scopedDb) =>
        scopedDb.db
          .insertInto("app.day_plan_operations")
          .values({
            id: randomUUID(),
            plan_id: first.id,
            owner_user_id: ids.userB,
            operation_key: null,
            block_id: null,
            kind: "move",
            idempotency_key: "op-direct-1",
            expected_revision: 1,
            outcome: "pending"
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        scopedDb.db
          .updateTable("app.day_plan_blocks")
          .set({ plan_id: foreignPlan.id })
          .where("id", "=", saved.blocks[0]?.id ?? "")
          .execute()
      )
    ).rejects.toMatchObject({ code: "23503" });

    // A task shared with another actor still grants no access to this plan,
    // and the shared task cannot be linked from the other actor's own plan.
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      sharesRepository.grant(scopedDb, {
        resourceType: "task",
        resourceId: task.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      })
    );
    await expect(
      dataContext.withDataContext(userBContext(), (scopedDb) =>
        repository.saveDraft(scopedDb, {
          planId: foreignPlan.id,
          localDay: LOCAL_DAY,
          timeZone: TIME_ZONE,
          expectedRevision: foreignPlan.revision,
          blocks: [{ taskId: task.id, kind: "focus", title: null }]
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      dataContext.withDataContext(userBContext(), (scopedDb) =>
        repository.createForDay(scopedDb, {
          localDay: "2026-09-13",
          timeZone: TIME_ZONE,
          eveningIntent: { priorityTaskIds: [task.id] }
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });

    // Bad day, zone and duration fail closed.
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.createForDay(scopedDb, { localDay: "not-a-day", timeZone: TIME_ZONE })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.createForDay(scopedDb, { localDay: LOCAL_DAY, timeZone: "Not/AZone" })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.saveDraft(scopedDb, {
          planId: first.id,
          localDay: LOCAL_DAY,
          timeZone: TIME_ZONE,
          expectedRevision: resetIntent.revision,
          blocks: [
            {
              taskId: null,
              kind: "focus",
              title: null,
              pendingChange: {
                kind: "move",
                startsAt: "2026-09-12T17:00:00.000Z",
                durationMinutes: 3
              }
            }
          ]
        })
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    // Omitting recorded placement rejects the whole save, including intent/revision writes.
    for (const blocks of [
      [],
      [{ taskId: null, kind: "break" as const, title: "must roll back" }]
    ]) {
      await expect(
        dataContext.withDataContext(userAContext(), (scopedDb) =>
          repository.saveDraft(scopedDb, {
            planId: first.id,
            localDay: LOCAL_DAY,
            timeZone: TIME_ZONE,
            expectedRevision: resetIntent.revision,
            eveningIntent: { notes: "must roll back" },
            blocks
          })
        )
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(
        await dataContext.withDataContext(userAContext(), (scopedDb) =>
          repository.getForDay(scopedDb, { localDay: LOCAL_DAY, timeZone: TIME_ZONE })
        )
      ).toEqual(resetIntent);
    }

    // A pending removal keeps the actual event; only unplaced draft blocks can be omitted.
    const recordedBlock = {
      id: seededBlockId,
      taskId: task.id,
      kind: "focus" as const,
      title: "Write the draft",
      pendingChange: { kind: "remove" as const }
    };
    const pendingRemoval = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: first.id,
        localDay: LOCAL_DAY,
        timeZone: TIME_ZONE,
        expectedRevision: resetIntent.revision,
        blocks: [recordedBlock, { taskId: null, kind: "break", title: "unplaced draft" }]
      })
    );
    expect(pendingRemoval.blocks).toHaveLength(2);
    const cleared = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: first.id,
        localDay: LOCAL_DAY,
        timeZone: TIME_ZONE,
        expectedRevision: pendingRemoval.revision,
        blocks: [recordedBlock]
      })
    );
    expect(cleared.blocks).toHaveLength(1);
    expect(cleared.blocks[0]?.actualPlacement).toEqual(resetIntent.blocks[0]?.actualPlacement);
    expect(cleared.blocks[0]?.actualPlacement?.calendarEventRef).toBe("fixture-event");
    expect(cleared.blocks[0]?.pendingChange).toEqual({ kind: "remove" });
    expect(
      await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.getForDay(scopedDb, { localDay: LOCAL_DAY, timeZone: TIME_ZONE })
      )
    ).toEqual(cleared);

    // Empty replacement still clears a plan containing only unplaced drafts.
    const foreignDraft = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: foreignPlan.id,
        localDay: LOCAL_DAY,
        timeZone: TIME_ZONE,
        expectedRevision: foreignPlan.revision,
        blocks: [{ taskId: null, kind: "break", title: "unplaced draft" }]
      })
    );
    expect(foreignDraft.blocks).toHaveLength(1);
    const emptyDraft = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: foreignPlan.id,
        localDay: LOCAL_DAY,
        timeZone: TIME_ZONE,
        expectedRevision: foreignDraft.revision,
        blocks: []
      })
    );
    expect(emptyDraft.blocks).toEqual([]);
    const retained = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      new TasksRepository().getById(scopedDb, task.id)
    );
    expect(retained?.id).toBe(task.id);
    expect(retained?.status).toBe(task.status);
    expect(retained?.due_at).toEqual(beforeTask?.due_at);
    expect(retained?.do_at).toEqual(beforeTask?.do_at);

    // Neither a new key nor a previously reserved key can bypass a stale revision.
    for (const idempotencyKey of ["op-stale-new", "op-move-1"]) {
      await expect(
        dataContext.withDataContext(userAContext(), (scopedDb) =>
          repository.reserveOperation(scopedDb, {
            planId: first.id,
            expectedRevision: resetIntent.revision,
            kind: "move",
            idempotencyKey,
            operationKey: "apply-move-1",
            blockId: seededBlockId
          })
        )
      ).rejects.toMatchObject({ statusCode: 409 });
    }

    // Storage effects and fetch invocations are separate assertions.
    const retainedOperation = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      scopedDb.db
        .selectFrom("app.day_plan_operations")
        .select(["plan_id", "block_id"])
        .where("id", "=", operation.id)
        .executeTakeFirstOrThrow()
    );
    expect(retainedOperation).toEqual({ plan_id: first.id, block_id: seededBlockId });
    expect(await countCalendarEvents(ids.userA)).toBe(beforeCalendarEvents);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
