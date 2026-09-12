import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import {
  AuthSessionResolver,
  DataContextRunner,
  SharesRepository,
  createDatabase,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import { DayPlanRepository } from "@moss/calendar";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { BriefingsRepository } from "@moss/briefings";
import type { GetDayPlanResponse } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";
import { TasksRepository } from "@moss/tasks";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const DAY = "2026-09-12";
const ZONE = "America/Los_Angeles";
const userA: AccessContext = { actorUserId: ids.userA, requestId: "saved-read-a" };
const userB: AccessContext = { actorUserId: ids.userB, requestId: "saved-read-b" };
const { Client } = pg;

// Privileged observations are confined to the runner's disposable fixture database.
async function snapshotFixtureRows() {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const tables = [
      "day_plans",
      "day_plan_blocks",
      "day_plan_operations",
      "tasks",
      "calendar_events"
    ];
    const snapshot: Record<string, unknown[]> = {};
    for (const table of tables) {
      const result = await client.query(
        `SELECT * FROM app.${table} WHERE owner_user_id = ANY($1::uuid[]) ORDER BY id`,
        [[ids.userA, ids.userB]]
      );
      snapshot[table] = result.rows;
    }
    return snapshot;
  } finally {
    await client.end();
  }
}

describe("saved day-plan real API boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: DayPlanRepository;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    const tasks = new TasksRepository();
    repository = new DayPlanRepository({
      findTask: async (scopedDb, taskId) => {
        const task = await tasks.getById(scopedDb, taskId);
        return task ? { id: task.id, ownerUserId: task.owner_user_id } : undefined;
      }
    });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("live acceptance: authenticated enriched saved day-plan read", async () => {
    const preferences = new PreferencesRepository();
    const task = await dataContext.withDataContext(userA, (scopedDb) =>
      new TasksRepository().create(scopedDb, {
        title: "Prepare the draft",
        dueAt: "2026-09-14T18:00:00.000Z",
        doAt: "2026-09-12T16:00:00.000Z"
      })
    );
    await dataContext.withDataContext(userA, async (scopedDb) => {
      await preferences.upsert(scopedDb, "locale", { timezone: ZONE });
      await new SharesRepository().grant(scopedDb, {
        resourceType: "task",
        resourceId: task.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      });
    });
    expect(
      await dataContext.withDataContext(userB, (scopedDb) =>
        new TasksRepository().getById(scopedDb, task.id)
      )
    ).toMatchObject({ id: task.id });

    const briefings = new BriefingsRepository();
    const definition = await dataContext.withDataContext(userA, (scopedDb) =>
      briefings.createDefinition(scopedDb, {
        title: "Evening",
        briefingType: "evening",
        selectedToolNames: ["tasks.list"]
      })
    );
    const fixtureClient = new Client({ connectionString: connectionStrings.bootstrap });
    await fixtureClient.connect();
    const sourceRunId = randomUUID();
    try {
      await fixtureClient.query(
        `INSERT INTO app.briefing_runs (id, definition_id, owner_user_id, status, run_kind, briefing_type, summary_text, source_metadata)
         VALUES ($1, $2, $3, 'succeeded', 'manual', 'evening', 'Evening summary', '{}')`,
        [sourceRunId, definition.id, ids.userA]
      );
    } finally {
      await fixtureClient.end();
    }
    const initial = await dataContext.withDataContext(userA, (scopedDb) =>
      repository.createForDay(scopedDb, {
        localDay: DAY,
        timeZone: ZONE,
        sourceRunId,
        eveningIntent: {
          priorityTaskIds: [task.id],
          capacity: "light",
          notes: "Leave the afternoon open",
          corrections: [{ taskId: null, note: "The follow-up is unfinished", source: "actor" }],
          commitments: [{ taskId: task.id, decision: "defer" }]
        }
      })
    );
    const saved = await dataContext.withDataContext(userA, (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: initial.id,
        localDay: DAY,
        timeZone: ZONE,
        expectedRevision: initial.revision,
        blocks: [
          {
            kind: "focus",
            taskId: task.id,
            title: "Saved draft label",
            position: 0,
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
            position: 1,
            pendingChange: { kind: "remove" }
          }
        ]
      })
    );
    expect(saved.blocks).toHaveLength(2);
    const placementClient = new Client({ connectionString: connectionStrings.bootstrap });
    await placementClient.connect();
    try {
      // Recorded placements are fixtures, not provider effects or draft-writable fields.
      await placementClient.query(
        "UPDATE app.day_plan_blocks SET actual_placement = $1::jsonb WHERE plan_id = $2",
        [
          JSON.stringify({
            startsAt: "2026-09-12T16:00:00.000Z",
            durationMinutes: 60,
            calendarEventRef: "fixture-event"
          }),
          initial.id
        ]
      );
    } finally {
      await placementClient.end();
    }
    const expectedA = await dataContext.withDataContext(userA, (scopedDb) =>
      repository.getForDay(scopedDb, { localDay: DAY, timeZone: ZONE })
    );
    expect(expectedA?.blocks.map((block) => block.pendingChange?.kind)).toEqual(["move", "remove"]);
    expect(expectedA?.blocks[0]?.actualPlacement?.startsAt).toBe("2026-09-12T16:00:00.000Z");
    await dataContext.withDataContext(userA, (scopedDb) =>
      repository.createForDay(scopedDb, { localDay: "2026-09-13", timeZone: ZONE })
    );
    const initialB = await dataContext.withDataContext(userB, (scopedDb) =>
      repository.createForDay(scopedDb, { localDay: DAY, timeZone: ZONE, sourceRunId })
    );
    const expectedB = await dataContext.withDataContext(userB, (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: initialB.id,
        localDay: DAY,
        timeZone: ZONE,
        expectedRevision: initialB.revision,
        eveningIntent: null
      })
    );
    expect(expectedB.sourceRunId).toBe(sourceRunId);
    expect(expectedB.eveningIntent).toEqual({
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    });
    const before = await snapshotFixtureRows();

    const read = async (session: string, query: string, headers: Record<string, string> = {}) => {
      const response = await server.inject({
        method: "GET",
        url: `/api/calendar/day-plan?${query}`,
        headers: { authorization: `Bearer ${session}`, ...headers }
      });
      expect(response.statusCode).toBe(200);
      return response.json<GetDayPlanResponse>();
    };
    const query = `date=${DAY}&timeZone=${encodeURIComponent(ZONE)}`;
    const unauthenticated = await server.inject({ url: `/api/calendar/day-plan?${query}` });
    expect(unauthenticated.statusCode).toBe(401);
    const expired = await server.inject({
      url: `/api/calendar/day-plan?${query}`,
      headers: { authorization: `Bearer ${randomUUID()}` }
    });
    expect(expired.statusCode).toBe(401);

    const enrichedA = await read(ids.sessionA, query);
    expect(enrichedA.plan).toEqual(expectedA);
    expect(enrichedA.tasks.map((task) => task.id)).toEqual([task.id]);
    expect(enrichedA.tasks[0]).toMatchObject({
      id: task.id,
      title: "Prepare the draft",
      status: "todo"
    });
    expect(enrichedA.unavailableTaskIds).toEqual([]);
    expect(enrichedA.sourceRun).toMatchObject({
      id: sourceRunId,
      briefingType: "evening",
      status: "succeeded"
    });
    expect(enrichedA.sourceRunUnavailable).toBe(false);
    expect(await snapshotFixtureRows()).toEqual(before);

    // The stored snapshot stays frozen while the live projection follows the task.
    const renamed = await dataContext.withDataContext(userA, (scopedDb) =>
      new TasksRepository().update(scopedDb, task.id, { title: "Prepare the draft, renamed" })
    );
    expect(renamed?.title).toBe("Prepare the draft, renamed");
    const afterRename = await read(ids.sessionA, query);
    expect(afterRename.plan).toEqual(expectedA);
    expect(afterRename.plan?.blocks[0]).toMatchObject({
      taskId: task.id,
      title: "Saved draft label"
    });
    expect(afterRename.tasks[0]).toMatchObject({
      id: task.id,
      title: "Prepare the draft, renamed"
    });

    // Archived tasks stay visible with archived status.
    await dataContext.withDataContext(userA, (scopedDb) =>
      new TasksRepository().updateStatus(scopedDb, task.id, "archived")
    );
    const afterArchive = await read(ids.sessionA, query);
    expect(afterArchive.plan).toEqual(expectedA);
    expect(afterArchive.tasks[0]).toMatchObject({ id: task.id, status: "archived" });
    expect(afterArchive.unavailableTaskIds).toEqual([]);

    // A task deleted after the draft was saved is reported, not fatal.
    const deleteClient = new Client({ connectionString: connectionStrings.bootstrap });
    await deleteClient.connect();
    try {
      await deleteClient.query("DELETE FROM app.tasks WHERE id = $1", [task.id]);
    } finally {
      await deleteClient.end();
    }
    const afterDeleteSnapshot = await snapshotFixtureRows();
    const expectedAfterDelete = await dataContext.withDataContext(userA, (scopedDb) =>
      repository.getForDay(scopedDb, { localDay: DAY, timeZone: ZONE })
    );
    const afterDelete = await read(ids.sessionA, query);
    expect(afterDelete.plan).toEqual(expectedAfterDelete);
    expect(afterDelete.plan?.blocks[0]?.taskId).toBeNull();
    expect(afterDelete.plan?.blocks[0]?.title).toBe("Saved draft label");
    expect(afterDelete.tasks).toEqual([]);
    expect(afterDelete.unavailableTaskIds).toEqual([task.id]);

    // A source run owned by another actor is reported missing for this reader.
    const enrichedB = await read(ids.sessionB, query);
    expect(enrichedB.plan).toEqual(expectedB);
    expect(enrichedB.sourceRun).toBeNull();
    expect(enrichedB.sourceRunUnavailable).toBe(true);
    expect(await read(ids.sessionAdmin, query)).toEqual({
      plan: null,
      tasks: [],
      unavailableTaskIds: [],
      sourceRun: null,
      sourceRunUnavailable: false
    });
    expect(
      (await read(ids.sessionB, `date=2026-09-13&timeZone=${encodeURIComponent(ZONE)}`)).plan
    ).toBeNull();
    expect(
      (await read(ids.sessionB, `${query}&actorUserId=${ids.userA}&ownerUserId=${ids.userA}`)).plan
    ).toEqual(expectedB);
    expect((await read(ids.sessionA, "date=2026-09-12")).plan).toEqual(expectedAfterDelete);
    expect((await read(ids.sessionA, "date=2026-09-12", { "x-timezone": "UTC" })).plan).toBeNull();
    expect((await read(ids.sessionA, query, { "x-timezone": "Asia/Tokyo" })).plan).toEqual(
      expectedAfterDelete
    );
    // No stored locale for B: UTC fallback does not accidentally select B's LA plan.
    expect((await read(ids.sessionB, "date=2026-09-12")).plan).toBeNull();
    expect((await read(ids.sessionA, "date=2026-09-14")).plan).toBeNull();

    for (const invalid of [
      "",
      "date=tomorrow",
      "date=2026-02-30",
      "date=0000-01-01",
      `date=${DAY}&timeZone=Invalid`,
      `date=${DAY}&timeZone=`
    ]) {
      const response = await server.inject({
        url: `/api/calendar/day-plan?${invalid}`,
        headers: { authorization: `Bearer ${ids.sessionA}` }
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await snapshotFixtureRows()).toEqual(afterDeleteSnapshot);

    await dataContext.withDataContext(userA, (scopedDb) =>
      preferences.upsert(scopedDb, "locale", { timezone: "UTC" })
    );
    expect((await read(ids.sessionA, "date=2026-09-12")).plan).toBeNull();
    const rereadA = await read(ids.sessionA, query);
    expect(rereadA.plan).toEqual(expectedAfterDelete);
    expect(rereadA.tasks).toEqual([]);
    expect(rereadA.unavailableTaskIds).toEqual([task.id]);

    await server.close();
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    const restartA = await read(ids.sessionA, query);
    expect(restartA.plan).toEqual(expectedAfterDelete);
    expect(restartA.tasks).toEqual([]);
    expect(restartA.unavailableTaskIds).toEqual([task.id]);
    const restartB = await read(ids.sessionB, query);
    expect(restartB.plan).toEqual(expectedB);
    expect(restartB.sourceRun).toBeNull();
    expect(restartB.sourceRunUnavailable).toBe(true);
    expect(await snapshotFixtureRows()).toEqual(afterDeleteSnapshot);
  });
});
