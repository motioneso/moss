import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import {
  AuthSessionResolver,
  DataContextRunner,
  createDatabase,
  SharesRepository,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { CreateDayPlanResponse, GetDayPlanResponse, SaveDayPlanResponse } from "@moss/shared";
import { TasksRepository } from "@moss/tasks";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const DAY = "2026-09-12";
const ZONE = "America/Los_Angeles";
const userA: AccessContext = { actorUserId: ids.userA, requestId: "saved-draft-a" };
const userB: AccessContext = { actorUserId: ids.userB, requestId: "saved-draft-b" };
const { Client } = pg;

async function snapshotUnrelatedRows() {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const tables = ["tasks", "briefing_runs", "calendar_events", "day_plan_operations"];
    const snapshot: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of tables) {
      const result = await client.query(
        `SELECT * FROM app.${table} WHERE owner_user_id = ANY($1::uuid[]) ORDER BY id`,
        [[ids.userA, ids.userB]]
      );
      snapshot[table] = result.rows;
    }
    const providerState = await client.query(
      "SELECT * FROM app.provider_install_state ORDER BY provider"
    );
    snapshot.provider_install_state = providerState.rows;
    return snapshot;
  } finally {
    await client.end();
  }
}

describe("saved day-plan draft real API boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 8 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("live acceptance: authenticated revision-checked day-plan draft save", async () => {
    const task = await dataContext.withDataContext(userA, (scopedDb) =>
      new TasksRepository().create(scopedDb, {
        title: "Write the draft",
        dueAt: "2026-09-14T18:00:00.000Z",
        doAt: "2026-09-12T16:00:00.000Z"
      })
    );
    const taskB = await dataContext.withDataContext(userB, (scopedDb) =>
      new TasksRepository().create(scopedDb, {
        title: "Actor B task",
        dueAt: "2026-09-14T18:00:00.000Z",
        doAt: "2026-09-12T16:00:00.000Z"
      })
    );
    await dataContext.withDataContext(userA, (scopedDb) =>
      new SharesRepository().grant(scopedDb, {
        resourceType: "task",
        resourceId: task.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      })
    );
    const unrelatedBefore = await snapshotUnrelatedRows();
    const planResponse = await server.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { date: DAY, timeZone: ZONE }
    });
    expect(planResponse.statusCode).toBe(200);
    const initial = planResponse.json<CreateDayPlanResponse>().plan;
    expect(initial.revision).toBe(1);
    expect(initial.blocks).toEqual([]);

    const actorBPlanResponse = await server.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { date: DAY, timeZone: ZONE }
    });
    expect(actorBPlanResponse.statusCode).toBe(200);
    const actorBPlan = actorBPlanResponse.json<CreateDayPlanResponse>().plan;
    const actorBBlockResponse = await server.inject({
      method: "PATCH",
      url: `/api/calendar/day-plans/${actorBPlan.id}/draft`,
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: {
        date: DAY,
        timeZone: ZONE,
        expectedRevision: 1,
        blocks: [{ kind: "break", taskId: null, title: "Actor B block" }]
      }
    });
    expect(actorBBlockResponse.statusCode).toBe(200);
    const foreignBlockId = actorBBlockResponse.json<SaveDayPlanResponse>().plan.blocks[0]?.id;
    if (!foreignBlockId) throw new Error("actor B block was not stored");

    const patch = async (
      session: string | undefined,
      payload: Record<string, unknown>,
      planRef = initial.id
    ) =>
      server.inject({
        method: "PATCH",
        url: `/api/calendar/day-plans/${planRef}/draft`,
        payload,
        ...(session ? { headers: { authorization: `Bearer ${session}` } } : {})
      });
    const read = async (session: string) => {
      const response = await server.inject({
        method: "GET",
        url: `/api/calendar/day-plan?date=${DAY}&timeZone=${encodeURIComponent(ZONE)}`,
        headers: { authorization: `Bearer ${session}` }
      });
      expect(response.statusCode).toBe(200);
      return response.json<GetDayPlanResponse>();
    };

    expect(
      (
        await patch(undefined, {
          date: DAY,
          timeZone: ZONE,
          expectedRevision: 1,
          eveningIntent: null
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await patch(randomUUID(), {
          date: DAY,
          timeZone: ZONE,
          expectedRevision: 1,
          eveningIntent: null
        })
      ).statusCode
    ).toBe(401);

    const intentResponse = await patch(ids.sessionA, {
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 1,
      eveningIntent: {
        priorityTaskIds: [task.id],
        capacity: "full",
        notes: "Keep the afternoon open",
        corrections: [{ taskId: null, note: "Follow up later", source: "actor" }],
        commitments: [{ taskId: task.id, decision: "defer" }]
      }
    });
    expect(intentResponse.statusCode).toBe(200);
    const intentSaved = intentResponse.json<SaveDayPlanResponse>().plan;
    expect(intentSaved.revision).toBe(2);
    expect(intentSaved.eveningIntent).toMatchObject({
      priorityTaskIds: [task.id],
      capacity: "full",
      notes: "Keep the afternoon open"
    });

    const blocksResponse = await patch(ids.sessionA, {
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 2,
      blocks: [
        {
          kind: "focus",
          taskId: task.id,
          title: "Write the draft",
          pendingChange: {
            kind: "move",
            startsAt: "2026-09-12T17:00:00.000Z",
            durationMinutes: 60
          }
        },
        {
          kind: "break",
          taskId: null,
          title: "Pause",
          pendingChange: {
            kind: "add",
            startsAt: "2026-09-12T18:00:00.000Z",
            durationMinutes: 30
          }
        }
      ]
    });
    expect(blocksResponse.statusCode).toBe(200);
    const blocksSaved = blocksResponse.json<SaveDayPlanResponse>().plan;
    const initialBlockId = blocksSaved.blocks[0]?.id;
    if (!initialBlockId) throw new Error("server did not assign a block id");
    expect(blocksSaved.revision).toBe(3);
    expect(blocksSaved.blocks).toHaveLength(2);
    expect(blocksSaved.blocks[0]).toMatchObject({ id: initialBlockId, position: 0 });
    expect(blocksSaved.blocks[0]?.pendingChange).toEqual({
      kind: "move",
      startsAt: "2026-09-12T17:00:00.000Z",
      durationMinutes: 60
    });
    expect(blocksSaved.blocks[1]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(blocksSaved.blocks[1]?.pendingChange).toEqual({
      kind: "add",
      startsAt: "2026-09-12T18:00:00.000Z",
      durationMinutes: 30
    });

    const retainResponse = await patch(ids.sessionA, {
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 3,
      eveningIntent: { notes: "Leave the afternoon open" }
    });
    expect(retainResponse.statusCode).toBe(200);
    const retained = retainResponse.json<SaveDayPlanResponse>().plan;
    expect(retained.revision).toBe(4);
    expect(retained.blocks).toHaveLength(2);
    expect(retained.blocks[0]?.pendingChange?.kind).toBe("move");

    const clearResponse = await patch(ids.sessionA, {
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 4,
      blocks: []
    });
    expect(clearResponse.statusCode).toBe(200);
    const cleared = clearResponse.json<SaveDayPlanResponse>().plan;
    expect(cleared.revision).toBe(5);
    expect(cleared.blocks).toEqual([]);
    expect(cleared.eveningIntent?.notes).toBe("Leave the afternoon open");

    const addFreshResponse = await patch(ids.sessionA, {
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 5,
      blocks: [
        {
          kind: "focus",
          taskId: task.id,
          title: "Write the draft"
        }
      ]
    });
    expect(addFreshResponse.statusCode).toBe(200);
    const freshBlock = addFreshResponse.json<SaveDayPlanResponse>().plan;
    const freshBlockId = freshBlock.blocks[0]?.id;
    if (!freshBlockId) throw new Error("server did not assign a fresh block id");
    expect(freshBlock.revision).toBe(6);

    const fixtureClient = new Client({ connectionString: connectionStrings.bootstrap });
    await fixtureClient.connect();
    try {
      await fixtureClient.query(
        "UPDATE app.day_plan_blocks SET actual_placement = $1::jsonb WHERE id = $2",
        [
          JSON.stringify({
            startsAt: "2026-09-12T16:00:00.000Z",
            durationMinutes: 60,
            calendarEventRef: "fixture-event"
          }),
          freshBlockId
        ]
      );
    } finally {
      await fixtureClient.end();
    }

    const placed = await read(ids.sessionA);
    expect(placed.plan?.blocks[0]).toMatchObject({
      id: freshBlockId,
      actualPlacement: {
        startsAt: "2026-09-12T16:00:00.000Z",
        durationMinutes: 60,
        calendarEventRef: "fixture-event"
      },
      pendingChange: null
    });
    const movePlacedResponse = await patch(ids.sessionA, {
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 6,
      blocks: [
        {
          id: freshBlockId,
          kind: "focus",
          taskId: task.id,
          title: "Write the draft",
          pendingChange: {
            kind: "move",
            startsAt: "2026-09-12T17:30:00.000Z",
            durationMinutes: 45
          }
        }
      ]
    });
    expect(movePlacedResponse.statusCode).toBe(200);
    const movedPlaced = movePlacedResponse.json<SaveDayPlanResponse>().plan;
    expect(movedPlaced.revision).toBe(7);
    expect(movedPlaced.blocks[0]).toMatchObject({
      id: freshBlockId,
      actualPlacement: {
        startsAt: "2026-09-12T16:00:00.000Z",
        durationMinutes: 60,
        calendarEventRef: "fixture-event"
      },
      pendingChange: {
        kind: "move",
        startsAt: "2026-09-12T17:30:00.000Z",
        durationMinutes: 45
      }
    });
    const removePlacedResponse = await patch(ids.sessionA, {
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 7,
      blocks: [
        {
          id: freshBlockId,
          kind: "focus",
          taskId: task.id,
          title: "Write the draft",
          pendingChange: { kind: "remove" }
        }
      ]
    });
    expect(removePlacedResponse.statusCode).toBe(200);
    const removedPlaced = removePlacedResponse.json<SaveDayPlanResponse>().plan;
    expect(removedPlaced.revision).toBe(8);
    expect(removedPlaced.blocks[0]).toMatchObject({
      id: freshBlockId,
      actualPlacement: {
        startsAt: "2026-09-12T16:00:00.000Z",
        durationMinutes: 60,
        calendarEventRef: "fixture-event"
      },
      pendingChange: { kind: "remove" }
    });
    const omittedPlaced = await patch(ids.sessionA, {
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 8,
      blocks: []
    });
    expect(omittedPlaced.statusCode).toBe(400);
    const afterRejectedOmission = await read(ids.sessionA);
    expect(afterRejectedOmission.plan?.revision).toBe(8);
    expect(afterRejectedOmission.plan?.blocks[0]?.pendingChange?.kind).toBe("remove");
    expect(afterRejectedOmission.plan?.blocks[0]?.actualPlacement?.calendarEventRef).toBe(
      "fixture-event"
    );

    const expectRejectedUnchanged = async (
      payload: Record<string, unknown>,
      expectedStatus = 400,
      session: string = ids.sessionA,
      planRef: string = initial.id
    ) => {
      const before = await read(ids.sessionA);
      const response = await patch(session, payload, planRef);
      expect(response.statusCode).toBe(expectedStatus);
      expect(await read(ids.sessionA)).toEqual(before);
    };

    await expectRejectedUnchanged(
      {
        date: DAY,
        timeZone: ZONE,
        expectedRevision: 8,
        eveningIntent: null
      },
      404,
      ids.sessionB
    );
    await expectRejectedUnchanged(
      { date: DAY, timeZone: ZONE, expectedRevision: 8, eveningIntent: null },
      404,
      ids.sessionA,
      randomUUID()
    );
    await expectRejectedUnchanged(
      {
        date: "2026-09-11",
        timeZone: ZONE,
        expectedRevision: 8,
        eveningIntent: null
      },
      404
    );
    await expectRejectedUnchanged(
      {
        date: DAY,
        timeZone: "UTC",
        expectedRevision: 8,
        eveningIntent: null
      },
      404
    );
    await expectRejectedUnchanged({
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 8.5,
      eveningIntent: null
    });

    for (const taskReference of [
      { priorityTaskIds: ["not-a-uuid"] },
      { corrections: [{ taskId: "not-a-uuid", note: "Bad", source: "actor" }] },
      { commitments: [{ taskId: "not-a-uuid", decision: "defer" }] },
      { blocks: [{ kind: "focus", taskId: "not-a-uuid", title: "Bad" }] }
    ]) {
      await expectRejectedUnchanged({
        date: DAY,
        timeZone: ZONE,
        expectedRevision: 8,
        ...("blocks" in taskReference
          ? { blocks: taskReference.blocks }
          : { eveningIntent: taskReference })
      });
    }
    await expectRejectedUnchanged(
      {
        date: DAY,
        timeZone: ZONE,
        expectedRevision: 8,
        eveningIntent: { priorityTaskIds: [randomUUID()] }
      },
      404
    );
    await expectRejectedUnchanged(
      {
        date: DAY,
        timeZone: ZONE,
        expectedRevision: 8,
        eveningIntent: { priorityTaskIds: [taskB.id] }
      },
      404
    );
    await expectRejectedUnchanged(
      {
        date: DAY,
        timeZone: ZONE,
        expectedRevision: 8,
        eveningIntent: { priorityTaskIds: [task.id] }
      },
      404,
      ids.sessionB
    );
    await expectRejectedUnchanged(
      {
        date: DAY,
        timeZone: ZONE,
        expectedRevision: 8,
        blocks: [{ id: randomUUID(), kind: "focus", taskId: null, title: "Missing" }]
      },
      404
    );
    await expectRejectedUnchanged(
      {
        date: DAY,
        timeZone: ZONE,
        expectedRevision: 8,
        blocks: [{ id: foreignBlockId, kind: "focus", taskId: null, title: "Foreign" }]
      },
      404
    );
    for (const correctionTaskId of [randomUUID(), taskB.id]) {
      await expectRejectedUnchanged(
        {
          date: DAY,
          timeZone: ZONE,
          expectedRevision: 8,
          eveningIntent: {
            corrections: [{ taskId: correctionTaskId, note: "Unavailable", source: "actor" }]
          }
        },
        404
      );
    }

    const baseInvalid = { date: DAY, timeZone: ZONE, expectedRevision: 8 };
    for (const eveningIntent of [
      {},
      { corrections: {} },
      { commitments: {} },
      { priorityTaskIds: [task.id], capacity: "nope" }
    ]) {
      await expectRejectedUnchanged({ ...baseInvalid, eveningIntent });
    }
    for (const pendingChange of [
      { kind: "unknown" },
      { kind: "add" },
      { kind: "move", startsAt: "2026-09-12T17:00:00.000Z" },
      { kind: "move", durationMinutes: 30 },
      { kind: "move", startsAt: "tomorrow", durationMinutes: 30 },
      { kind: "move", startsAt: "2026-09-12T17:00:00.000Z", durationMinutes: 0 },
      { kind: "move", startsAt: "2026-09-12T17:00:00.000Z", durationMinutes: 60.5 },
      { kind: "move", startsAt: "2026-09-12T17:00:00.000Z", durationMinutes: 721 },
      { kind: "remove", startsAt: "2026-09-12T17:00:00.000Z" }
    ]) {
      await expectRejectedUnchanged({
        ...baseInvalid,
        blocks: [{ kind: "focus", taskId: null, title: "Bad", pendingChange }]
      });
    }
    for (const field of [
      "actor",
      "owner",
      "sourceRunId",
      "operation",
      "taskFacts",
      "providerAccount",
      "calendarEvent"
    ]) {
      await expectRejectedUnchanged({ ...baseInvalid, eveningIntent: null, [field]: "forbidden" });
    }
    await expectRejectedUnchanged({
      ...baseInvalid,
      blocks: [{ kind: "focus", taskId: null, title: "Bad", actualPlacement: null }]
    });
    await expectRejectedUnchanged({
      ...baseInvalid,
      blocks: [{ kind: "focus", taskId: null, title: "Bad", readOnly: true }]
    });
    await expectRejectedUnchanged({
      ...baseInvalid,
      blocks: [{ kind: "focus", taskId: null, title: "Bad", position: 4 }]
    });

    const concurrentPayload = (notes: string) => ({
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 8,
      eveningIntent: { notes },
      blocks: [
        {
          id: freshBlockId,
          kind: "focus",
          taskId: task.id,
          title: `${notes} block`,
          pendingChange: {
            kind: "move",
            startsAt:
              notes === "winner A" ? "2026-09-12T19:00:00.000Z" : "2026-09-12T20:00:00.000Z",
            durationMinutes: 30
          }
        }
      ]
    });
    const [concurrentA, concurrentB] = await Promise.all([
      patch(ids.sessionA, concurrentPayload("winner A")),
      patch(ids.sessionA, concurrentPayload("winner B"))
    ]);
    expect([concurrentA.statusCode, concurrentB.statusCode].sort()).toEqual([200, 409]);
    const winner = concurrentA.statusCode === 200 ? concurrentA : concurrentB;
    const loser = concurrentA.statusCode === 409 ? concurrentA : concurrentB;
    const winningPlan = winner.json<SaveDayPlanResponse>().plan;
    expect(winningPlan.revision).toBe(9);
    expect(loser.json()).toHaveProperty("error");
    const stale = await patch(ids.sessionA, concurrentPayload("too late"));
    expect(stale.statusCode).toBe(409);
    const afterConcurrent = await read(ids.sessionA);
    expect(afterConcurrent).toEqual({ plan: winningPlan });

    const reset = await patch(ids.sessionA, {
      date: DAY,
      timeZone: ZONE,
      expectedRevision: 9,
      eveningIntent: null
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<SaveDayPlanResponse>().plan.eveningIntent).toEqual({
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    });

    const unrelatedAfter = await snapshotUnrelatedRows();
    expect(unrelatedAfter).toEqual(unrelatedBefore);
  });
});
