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

  it("live acceptance: authenticated saved day-plan read", async () => {
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

    const initial = await dataContext.withDataContext(userA, (scopedDb) =>
      repository.createForDay(scopedDb, {
        localDay: DAY,
        timeZone: ZONE,
        sourceRunId: randomUUID(),
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
    const fixtureClient = new Client({ connectionString: connectionStrings.bootstrap });
    await fixtureClient.connect();
    try {
      // Recorded placements are fixtures, not provider effects or draft-writable fields.
      await fixtureClient.query(
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
      await fixtureClient.end();
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
      repository.createForDay(scopedDb, { localDay: DAY, timeZone: ZONE })
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
    expect(expectedB.sourceRunId).toBeNull();
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

    expect(await read(ids.sessionA, query)).toEqual({ plan: expectedA });
    expect(await read(ids.sessionB, query)).toEqual({ plan: expectedB });
    expect(await read(ids.sessionAdmin, query)).toEqual({ plan: null });
    expect(
      await read(ids.sessionB, `date=2026-09-13&timeZone=${encodeURIComponent(ZONE)}`)
    ).toEqual({ plan: null });
    expect(
      await read(ids.sessionB, `${query}&actorUserId=${ids.userA}&ownerUserId=${ids.userA}`)
    ).toEqual({ plan: expectedB });
    expect(await read(ids.sessionA, "date=2026-09-12")).toEqual({ plan: expectedA });
    expect(await read(ids.sessionA, "date=2026-09-12", { "x-timezone": "UTC" })).toEqual({
      plan: null
    });
    expect(await read(ids.sessionA, query, { "x-timezone": "Asia/Tokyo" })).toEqual({
      plan: expectedA
    });
    // No stored locale for B: UTC fallback does not accidentally select B's LA plan.
    expect(await read(ids.sessionB, "date=2026-09-12")).toEqual({ plan: null });
    expect(await read(ids.sessionA, "date=2026-09-14")).toEqual({ plan: null });

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
    expect(await snapshotFixtureRows()).toEqual(before);

    await dataContext.withDataContext(userA, (scopedDb) =>
      preferences.upsert(scopedDb, "locale", { timezone: "UTC" })
    );
    expect(await read(ids.sessionA, "date=2026-09-12")).toEqual({ plan: null });
    expect(await read(ids.sessionA, query)).toEqual({ plan: expectedA });

    await server.close();
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    expect(await read(ids.sessionA, query)).toEqual({ plan: expectedA });
    expect(await read(ids.sessionB, query)).toEqual({ plan: expectedB });
    expect(await snapshotFixtureRows()).toEqual(before);
  });
});
