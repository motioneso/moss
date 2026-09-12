import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { BriefingsRepository } from "@moss/briefings";
import { DayPlanRepository } from "@moss/calendar";
import {
  AuthSessionResolver,
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import type { CreateDayPlanResponse } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import { createApiServer } from "../../apps/api/src/server.js";
import { makeComposeDeps } from "./briefings.helpers.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const DAY = "2026-09-12";
const ZONE = "America/Los_Angeles";
const userA: AccessContext = { actorUserId: ids.userA, requestId: "saved-create-a" };
const userB: AccessContext = { actorUserId: ids.userB, requestId: "saved-create-b" };
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
      "calendar_events",
      "briefing_runs"
    ];
    const snapshot: Record<string, Array<Record<string, unknown>>> = {};
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

describe("saved day-plan creation boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: DayPlanRepository;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 8 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    repository = new DayPlanRepository({
      findTask: async () => undefined
    });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("live acceptance: authenticated saved day-plan creation", async () => {
    const preferences = new PreferencesRepository();
    const briefings = new BriefingsRepository();
    await dataContext.withDataContext(userA, (scopedDb) =>
      preferences.upsert(scopedDb, "locale", { timezone: ZONE })
    );

    const seedRun = async (context: AccessContext) => {
      const definition = await dataContext.withDataContext(context, (scopedDb) =>
        briefings.createDefinition(scopedDb, {
          title: "Source definition",
          selectedToolNames: ["tasks.list"]
        })
      );
      const outcome = await dataContext.withDataContext(context, (scopedDb) =>
        briefings.generateRun(scopedDb, definition.id, {
          moduleManifests: getBuiltInModuleManifests(),
          runKind: "manual",
          composeDeps: makeComposeDeps(async () => ({ text: "source narrative" }))
        })
      );
      return outcome?.run;
    };

    const runA = await seedRun(userA);
    expect(runA?.id).toBeTruthy();
    const runB = await seedRun(userB);
    expect(runB?.id).toBeTruthy();
    const staleRun = await dataContext.withDataContext(userA, (scopedDb) =>
      briefings.createDefinition(scopedDb, {
        title: "Older source",
        selectedToolNames: ["tasks.list"]
      })
    );
    const staleOutcome = await dataContext.withDataContext(userA, (scopedDb) =>
      briefings.generateRun(scopedDb, staleRun.id, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "manual",
        composeDeps: makeComposeDeps(async () => ({ text: "older narrative" }))
      })
    );
    const fixtureClient = new Client({ connectionString: connectionStrings.bootstrap });
    await fixtureClient.connect();
    try {
      await fixtureClient.query(
        "UPDATE app.briefing_runs SET status = 'failed', created_at = now() - interval '30 days' WHERE id = $1",
        [staleOutcome?.run.id]
      );
    } finally {
      await fixtureClient.end();
    }

    const create = async (
      session: string | undefined,
      payload: Record<string, unknown>,
      headers: Record<string, string> = {}
    ) => {
      const response = await server.inject({
        method: "POST",
        url: "/api/calendar/day-plans",
        payload,
        ...(session ? { headers: { authorization: `Bearer ${session}`, ...headers } } : { headers })
      });
      return response;
    };

    const unauthenticated = await create(undefined, { date: DAY });
    expect(unauthenticated.statusCode).toBe(401);
    const expired = await create(randomUUID(), { date: DAY });
    expect(expired.statusCode).toBe(401);

    // Omitted timezone follows stored locale; explicit zone selects a distinct key.
    const firstResponse = await create(ids.sessionA, { date: DAY, sourceRunId: runA?.id });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json<CreateDayPlanResponse>().plan;
    expect(first.revision).toBe(1);
    expect(first.localDay).toBe(DAY);
    expect(first.timeZone).toBe(ZONE);
    expect(first.sourceRunId).toBe(runA?.id);
    expect(first.blocks).toEqual([]);
    expect(first.eveningIntent).toEqual({
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    });

    const tokyoResponse = await create(ids.sessionA, {
      date: DAY,
      timeZone: "Asia/Tokyo",
      sourceRunId: null
    });
    expect(tokyoResponse.statusCode).toBe(200);
    const tokyo = tokyoResponse.json<CreateDayPlanResponse>().plan;
    expect(tokyo.timeZone).toBe("Asia/Tokyo");
    expect(tokyo.sourceRunId).toBeNull();
    expect(tokyo.id).not.toBe(first.id);

    // Omitted and null sources both create without provenance.
    const nullSource = await create(ids.sessionB, { date: "2026-09-13", sourceRunId: null });
    expect(nullSource.statusCode).toBe(200);
    const omittedSource = await create(ids.sessionB, { date: "2026-09-14" });
    expect(omittedSource.statusCode).toBe(200);

    // Idempotent repeat keeps the same identity, revision and source.
    const repeat = await create(ids.sessionA, { date: DAY, sourceRunId: runA?.id });
    expect(repeat.statusCode).toBe(200);
    const repeated = repeat.json<CreateDayPlanResponse>().plan;
    expect(repeated.id).toBe(first.id);
    expect(repeated.revision).toBe(1);
    expect(repeated.sourceRunId).toBe(runA?.id);

    const repeatNull = await create(ids.sessionA, {
      date: DAY,
      timeZone: "Asia/Tokyo",
      sourceRunId: null
    });
    expect(repeatNull.json<CreateDayPlanResponse>().plan.id).toBe(tokyo.id);

    // A repeat naming a different valid actor-owned source keeps the original source.
    const runA2 = await seedRun(userA);
    expect(runA2?.id).toBeTruthy();
    const repeatOther = await create(ids.sessionA, { date: DAY, sourceRunId: runA2?.id });
    expect(repeatOther.statusCode).toBe(200);
    const repeatedOther = repeatOther.json<CreateDayPlanResponse>().plan;
    expect(repeatedOther.id).toBe(first.id);
    expect(repeatedOther.revision).toBe(1);
    expect(repeatedOther.sourceRunId).toBe(runA?.id);

    // A repeat with a bad or foreign source fails even though the plan exists.
    expect((await create(ids.sessionA, { date: DAY, sourceRunId: "not-a-uuid" })).statusCode).toBe(
      400
    );
    const missingSource = await create(ids.sessionA, { date: DAY, sourceRunId: randomUUID() });
    expect(missingSource.statusCode).toBe(404);
    const foreignSource = await create(ids.sessionA, { date: DAY, sourceRunId: runB?.id });
    expect(foreignSource.statusCode).toBe(404);
    expect(foreignSource.json()).toEqual(missingSource.json());

    // Older non-success runs remain valid provenance, not fresh or successful.
    const staleCreate = await create(ids.sessionA, {
      date: "2026-09-15",
      sourceRunId: staleOutcome?.run.id
    });
    expect(staleCreate.statusCode).toBe(200);
    expect(staleCreate.json<CreateDayPlanResponse>().plan.sourceRunId).toBe(staleOutcome?.run.id);

    // Strict body: caller-owned identity and draft fields are rejected.
    for (const payload of [
      { date: DAY, actorUserId: ids.userA },
      { date: DAY, ownerUserId: ids.userA },
      { date: DAY, expectedRevision: 1 },
      { date: DAY, revision: 1 },
      { date: DAY, blocks: [] },
      { date: DAY, eveningIntent: null },
      { date: DAY, sourceRunId: 42 },
      { date: "tomorrow" },
      { date: "2026-02-30" },
      { date: "0000-01-01" },
      { date: DAY, timeZone: "Invalid" }
    ]) {
      const response = await create(ids.sessionA, payload);
      expect(response.statusCode).toBe(400);
    }

    // Actor B creates only their own same-day plan and cannot touch Actor A's.
    const actorB = await create(ids.sessionB, { date: DAY });
    expect(actorB.statusCode).toBe(200);
    const planB = actorB.json<CreateDayPlanResponse>().plan;
    expect(planB.id).not.toBe(first.id);
    expect(planB.sourceRunId).toBeNull();

    // Reads through the merged endpoint observe without mutation.
    const readA = await server.inject({
      method: "GET",
      url: `/api/calendar/day-plan?date=${DAY}&timeZone=${encodeURIComponent(ZONE)}`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(readA.statusCode).toBe(200);
    expect(readA.json().plan.id).toBe(first.id);
    expect(readA.json().plan.sourceRunId).toBe(runA?.id);

    const before = await snapshotFixtureRows();
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        create(ids.sessionB, { date: "2026-09-16", timeZone: ZONE, sourceRunId: runB?.id })
      )
    );
    for (const response of concurrent) {
      expect(response.statusCode).toBe(200);
    }
    const settledIds = new Set(concurrent.map((r) => r.json<CreateDayPlanResponse>().plan.id));
    expect(settledIds.size).toBe(1);
    const settledResponse = concurrent[0];
    expect(settledResponse).toBeDefined();
    const settled = settledResponse!.json<CreateDayPlanResponse>().plan;
    expect(settled.revision).toBe(1);
    expect(settled.sourceRunId).toBe(runB?.id);

    const after = await snapshotFixtureRows();
    expect(after.day_plans?.length).toBe((before.day_plans?.length ?? 0) + 1);
    expect(after.briefing_runs).toEqual(before.briefing_runs);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.calendar_events).toEqual(before.calendar_events);
    expect(after.day_plan_operations).toEqual(before.day_plan_operations);
    expect(after.day_plan_blocks).toEqual(before.day_plan_blocks);
    for (const row of after.day_plan_blocks as { plan_id: string }[]) {
      expect((after.day_plans as { id: string }[]).some((plan) => plan.id === row.plan_id)).toBe(
        true
      );
    }
    const createdRow = after.day_plans?.find((row) => row.id === settled.id);
    expect(createdRow).toBeTruthy();

    // Direct repository calls only inspect; the HTTP boundary above is the proof.
    const inspected = await dataContext.withDataContext(userB, (scopedDb) =>
      repository.getForDay(scopedDb, { localDay: "2026-09-16", timeZone: ZONE })
    );
    expect(inspected?.id).toBe(settled.id);
  });
});
