import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import {
  AuthSessionResolver,
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { DayPlanRepository } from "@moss/calendar";
import { TasksRepository } from "@moss/tasks";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const TIME_ZONE = "America/Los_Angeles";

function userAContext(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:user-a-apply-batch" };
}

function userBContext(): AccessContext {
  return { actorUserId: ids.userB, requestId: "request:user-b-apply-batch" };
}

async function countOperations(): Promise<number> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM app.day_plan_operations"
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function countOperationItems(): Promise<number> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM app.day_plan_operation_items"
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

describe("apply batch reservation boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: DayPlanRepository;
  let taskId: string;
  let daySeq = 0;

  function nextDay(): string {
    daySeq += 1;
    return `2026-09-${String(11 + daySeq).padStart(2, "0")}`;
  }

  async function seedPlanWithPending(localDay: string) {
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createForDay(scopedDb, { localDay, timeZone: TIME_ZONE })
    );
    const saved = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: created.id,
        localDay,
        timeZone: TIME_ZONE,
        expectedRevision: created.revision,
        blocks: [
          {
            taskId,
            kind: "focus",
            title: "Morning write-up",
            pendingChange: {
              kind: "add",
              startsAt: "2026-09-12T16:00:00.000Z",
              durationMinutes: 30
            }
          },
          {
            taskId,
            kind: "meeting",
            title: "Sync",
            pendingChange: {
              kind: "move",
              startsAt: "2026-09-12T17:00:00.000Z",
              durationMinutes: 45
            }
          },
          {
            taskId,
            kind: "focus",
            title: "Dropped spike",
            pendingChange: { kind: "remove" }
          }
        ]
      })
    );
    const byTitle = new Map(saved.blocks.map((block) => [block.title, block]));
    return { plan: saved, byTitle };
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    const tasks = new TasksRepository();
    repository = new DayPlanRepository({
      findTask: async (scopedDb, id) => {
        const row = await tasks.getById(scopedDb, id);
        return row ? { id: row.id, ownerUserId: row.owner_user_id } : undefined;
      }
    });
    taskId = await dataContext
      .withDataContext(userAContext(), (scopedDb: DataContextDb) =>
        tasks.create(scopedDb, {
          title: "Batch fixture task",
          dueAt: "2026-09-14T18:00:00.000Z",
          doAt: "2026-09-12T16:00:00.000Z"
        })
      )
      .then((task) => task.id);
  });

  afterAll(async () => {
    await Promise.allSettled([appDb?.destroy()]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("reserves the explicit selection plus pending additions with no outside writes", async () => {
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected provider request"));
    const { plan, byTitle } = await seedPlanWithPending(nextDay());
    const moveId = byTitle.get("Sync")!.id;

    const batch = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: plan.id,
        expectedRevision: plan.revision,
        idempotencyKey: `batch-reserve-${randomUUID()}`,
        operationKey: "apply-batch-1",
        selectedBlockIds: [moveId]
      })
    );

    // Explicit move plus the pending addition; the removal stays out unselected.
    expect(batch.planId).toBe(plan.id);
    expect(batch.expectedRevision).toBe(plan.revision);
    expect(batch.operationKey).toBe("apply-batch-1");
    expect(batch.outcome).toBe("pending");
    expect(batch.selection.map((entry) => entry.blockId).sort()).toEqual(
      [byTitle.get("Morning write-up")!.id, moveId].sort()
    );
    expect(batch.items).toHaveLength(2);
    for (const item of batch.items) {
      expect(item.outcome).toBe("pending");
    }
    const addItem = batch.items.find(
      (item) => item.blockId === byTitle.get("Morning write-up")!.id
    )!;
    expect(addItem.pendingChange).toEqual({
      blockId: byTitle.get("Morning write-up")!.id,
      kind: "add",
      startsAt: "2026-09-12T16:00:00.000Z",
      durationMinutes: 30
    });

    // Reservation never touches the plan, the task, or any provider.
    const reloaded = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, plan.id)
    );
    expect(reloaded?.revision).toBe(plan.revision);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("returns the same reservation on exact replay", async () => {
    const { plan, byTitle } = await seedPlanWithPending(nextDay());
    const key = `batch-replay-${randomUUID()}`;
    const first = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: plan.id,
        expectedRevision: plan.revision,
        idempotencyKey: key,
        selectedBlockIds: [byTitle.get("Sync")!.id]
      })
    );
    const second = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: plan.id,
        expectedRevision: plan.revision,
        idempotencyKey: key,
        operationKey: first.operationKey ?? undefined,
        selectedBlockIds: [byTitle.get("Sync")!.id]
      })
    );
    expect(second.id).toBe(first.id);
    expect(second.items.map((item) => item.id).sort()).toEqual(
      first.items.map((item) => item.id).sort()
    );
    expect(await countOperations()).toBeGreaterThan(0);
  });

  it("conflicts when the replayed selection differs", async () => {
    const { plan, byTitle } = await seedPlanWithPending(nextDay());
    const key = `batch-conflict-${randomUUID()}`;
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: plan.id,
        expectedRevision: plan.revision,
        idempotencyKey: key,
        selectedBlockIds: [byTitle.get("Sync")!.id]
      })
    );
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: plan.id,
          expectedRevision: plan.revision,
          idempotencyKey: key,
          selectedBlockIds: [byTitle.get("Sync")!.id, byTitle.get("Dropped spike")!.id]
        })
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("conflicts on a stale revision and rejects unknown plans without partial rows", async () => {
    const { plan, byTitle } = await seedPlanWithPending(nextDay());
    const before = await countOperations();
    const beforeItems = await countOperationItems();
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: plan.id,
          expectedRevision: plan.revision - 1,
          idempotencyKey: `batch-stale-${randomUUID()}`
        })
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: randomUUID(),
          expectedRevision: 1,
          idempotencyKey: `batch-missing-${randomUUID()}`
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: plan.id,
          expectedRevision: plan.revision,
          idempotencyKey: `batch-badblock-${randomUUID()}`,
          selectedBlockIds: [byTitle.get("Sync")!.id, randomUUID()]
        })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await countOperations()).toBe(before);
    expect(await countOperationItems()).toBe(beforeItems);
  });

  it("keeps batches isolated per actor", async () => {
    const { plan } = await seedPlanWithPending(nextDay());
    const key = `batch-isolation-${randomUUID()}`;
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: plan.id,
        expectedRevision: plan.revision,
        idempotencyKey: key
      })
    );
    // Another actor neither reads nor reserves against this plan.
    const foreign = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: key })
    );
    expect(foreign).toBeUndefined();
    await expect(
      dataContext.withDataContext(userBContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: plan.id,
          expectedRevision: plan.revision,
          idempotencyKey: key
        })
      )
    ).rejects.toMatchObject({ statusCode: 404 });
    // The same key on the other actor's own plan reserves independently.
    const own = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.createForDay(scopedDb, { localDay: nextDay(), timeZone: TIME_ZONE })
    );
    const ownSaved = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: own.id,
        localDay: own.localDay,
        timeZone: TIME_ZONE,
        expectedRevision: own.revision,
        blocks: [
          {
            taskId: null,
            kind: "focus",
            title: "Other actor addition",
            pendingChange: {
              kind: "add",
              startsAt: "2026-09-12T16:00:00.000Z",
              durationMinutes: 30
            }
          }
        ]
      })
    );
    const ownBatch = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: own.id,
        expectedRevision: ownSaved.revision,
        idempotencyKey: key
      })
    );
    expect(ownBatch.planId).toBe(own.id);
    expect(ownBatch.items).toHaveLength(1);
  });

  it("settles concurrent reservations on one header", async () => {
    const { plan } = await seedPlanWithPending(nextDay());
    const key = `batch-race-${randomUUID()}`;
    const [left, right] = await Promise.all([
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: plan.id,
          expectedRevision: plan.revision,
          idempotencyKey: key
        })
      ),
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: plan.id,
          expectedRevision: plan.revision,
          idempotencyKey: key
        })
      )
    ]);
    expect(left.id).toBe(right.id);
    const reloaded = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: key })
    );
    expect(reloaded?.id).toBe(left.id);
    expect(reloaded?.items).toHaveLength(left.items.length);
    expect(
      await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: `nope-${key}` })
      )
    ).toBeUndefined();
  });

  it("replays the stored reservation after the plan revision advances", async () => {
    const { plan, byTitle } = await seedPlanWithPending(nextDay());
    const key = `batch-advance-${randomUUID()}`;
    const moveId = byTitle.get("Sync")!.id;
    const first = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: plan.id,
        expectedRevision: plan.revision,
        idempotencyKey: key,
        selectedBlockIds: [moveId]
      })
    );

    // An unrelated draft edit moves the plan on; the blocks are untouched.
    const advanced = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: plan.id,
        localDay: plan.localDay,
        timeZone: TIME_ZONE,
        expectedRevision: plan.revision,
        eveningIntent: { notes: "still small" }
      })
    );
    expect(advanced.revision).toBe(plan.revision + 1);

    // Exact replay returns the durable reservation unchanged.
    const replayed = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: plan.id,
        expectedRevision: plan.revision,
        idempotencyKey: key,
        selectedBlockIds: [moveId]
      })
    );
    expect(replayed.id).toBe(first.id);
    expect(replayed.items.map((item) => item.id).sort()).toEqual(
      first.items.map((item) => item.id).sort()
    );

    // Changed intent against the same key still conflicts.
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: plan.id,
          expectedRevision: plan.revision,
          idempotencyKey: key,
          selectedBlockIds: [moveId, byTitle.get("Dropped spike")!.id]
        })
      )
    ).rejects.toMatchObject({ statusCode: 409 });

    // A fresh key against the stale revision is rejected.
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: plan.id,
          expectedRevision: plan.revision,
          idempotencyKey: `batch-advance-fresh-${randomUUID()}`
        })
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rolls back header and items when item insertion fails", async () => {
    const { plan, byTitle } = await seedPlanWithPending(nextDay());
    const sentinel = `batch-probe-${randomUUID()}`;
    const suffix = sentinel.replace(/-/g, "");
    const probeFunction = `apply_batch_probe_${suffix}`;
    const probeTrigger = `apply_batch_probe_${suffix}`;
    const probe = new Client({ connectionString: connectionStrings.bootstrap });
    await probe.connect();
    try {
      await probe.query(`CREATE FUNCTION ${probeFunction}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM app.day_plan_operations
            WHERE id = NEW.operation_id AND operation_key = '${sentinel}'
          ) THEN
            RAISE EXCEPTION 'apply_batch_probe_abort:%', '${sentinel}';
          END IF;
          RETURN NEW;
        END $fn$`);
      await probe.query(
        `CREATE TRIGGER ${probeTrigger} BEFORE INSERT ON app.day_plan_operation_items ` +
          `FOR EACH ROW EXECUTE FUNCTION ${probeFunction}()`
      );
      const before = await countOperations();
      const beforeItems = await countOperationItems();
      await expect(
        dataContext.withDataContext(userAContext(), (scopedDb) =>
          repository.reserveApplyBatch(scopedDb, {
            planId: plan.id,
            expectedRevision: plan.revision,
            idempotencyKey: `batch-probe-key-${randomUUID()}`,
            operationKey: sentinel,
            selectedBlockIds: [byTitle.get("Sync")!.id]
          })
        )
      ).rejects.toThrow(sentinel);
      expect(await countOperations()).toBe(before);
      expect(await countOperationItems()).toBe(beforeItems);
    } finally {
      await probe.query(`DROP TRIGGER IF EXISTS ${probeTrigger} ON app.day_plan_operation_items`);
      await probe.query(`DROP FUNCTION IF EXISTS ${probeFunction}()`);
      await probe.end();
    }
  });

  it("rejects a reservation with nothing pending", async () => {
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createForDay(scopedDb, { localDay: nextDay(), timeZone: TIME_ZONE })
    );
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.reserveApplyBatch(scopedDb, {
          planId: created.id,
          expectedRevision: created.revision,
          idempotencyKey: `batch-empty-${randomUUID()}`
        })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
