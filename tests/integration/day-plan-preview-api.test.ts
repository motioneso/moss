import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import {
  AuthSessionResolver,
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { CalendarRepository } from "@moss/calendar";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import type {
  CreateDayPlanResponse,
  GetDayPlanResponse,
  PreviewDayPlanResponse,
  SaveDayPlanResponse
} from "@moss/shared";
import { TasksRepository } from "@moss/tasks";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const DAY = "2026-09-12";
const ZONE = "America/Los_Angeles";
const userA: AccessContext = { actorUserId: ids.userA, requestId: "preview-a" };
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

async function setBlockActualPlacement(
  blockId: string,
  placement: { startsAt: string; durationMinutes: number; calendarEventRef: string | null }
): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      "UPDATE app.day_plan_blocks SET actual_placement = $1::jsonb WHERE id = $2",
      [JSON.stringify(placement), blockId]
    );
  } finally {
    await client.end();
  }
}

// The calendar module builds one GoogleApiClient at server startup and keeps it for every
// request, so it captures whatever `globalThis.fetch` is AT THAT MOMENT — a later per-test
// `vi.spyOn` has no effect on a client already holding the old reference. Faking a Google
// read through the real HTTP boundary means installing the fetch stand-in before the server
// is built, then having each test point `liveFetchHandler` at its own scenario.
let liveFetchHandler: typeof fetch = (async () => {
  throw new Error("unexpected calendar fetch in a test that did not set one up");
}) as typeof fetch;

describe("saved day-plan preview real API boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    vi.spyOn(globalThis, "fetch").mockImplementation((...args) => liveFetchHandler(...args));
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 8 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    liveFetchHandler = (async () => {
      throw new Error("unexpected calendar fetch in a test that did not set one up");
    }) as typeof fetch;
  });

  it("live acceptance: authenticated revision-checked preview with zero writes", async () => {
    const task = await dataContext.withDataContext(userA, (scopedDb) =>
      new TasksRepository().create(scopedDb, {
        title: "Write the report",
        dueAt: "2026-09-14T18:00:00.000Z",
        doAt: "2026-09-12T16:00:00.000Z"
      })
    );

    const created = await server.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { date: DAY, timeZone: ZONE }
    });
    expect(created.statusCode).toBe(200);
    const plan = created.json<CreateDayPlanResponse>().plan;

    const draft = await server.inject({
      method: "PATCH",
      url: `/api/calendar/day-plans/${plan.id}/draft`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        date: DAY,
        timeZone: ZONE,
        expectedRevision: 1,
        blocks: [
          {
            kind: "focus",
            taskId: task.id,
            title: "Write the report",
            pendingChange: {
              kind: "add",
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
      }
    });
    expect(draft.statusCode).toBe(200);
    const savedPlan = draft.json<SaveDayPlanResponse>().plan;
    expect(savedPlan.revision).toBe(2);
    const [focusBlockId, breakBlockId] = savedPlan.blocks.map((block) => block.id);
    if (!focusBlockId || !breakBlockId) throw new Error("server did not assign block ids");

    const preview = async (
      session: string | undefined,
      payload: Record<string, unknown>,
      planRef = plan.id
    ) =>
      server.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${planRef}/preview`,
        payload,
        ...(session ? { headers: { authorization: `Bearer ${session}` } } : {})
      });

    expect(
      (await preview(undefined, { expectedRevision: 2, selectedChangeBlockIds: [focusBlockId] }))
        .statusCode
    ).toBe(401);

    const wrongOwner = await preview(ids.sessionB, {
      expectedRevision: 2,
      selectedChangeBlockIds: [focusBlockId]
    });
    expect(wrongOwner.statusCode).toBe(404);

    const missingPlan = await preview(
      ids.sessionA,
      {
        expectedRevision: 2,
        selectedChangeBlockIds: [focusBlockId]
      },
      randomUUID()
    );
    expect(missingPlan.statusCode).toBe(404);

    const staleRevision = await preview(ids.sessionA, {
      expectedRevision: 1,
      selectedChangeBlockIds: [focusBlockId]
    });
    expect(staleRevision.statusCode).toBe(409);

    const unknownField = await preview(ids.sessionA, {
      expectedRevision: 2,
      selectedChangeBlockIds: [focusBlockId],
      extraField: true
    });
    expect(unknownField.statusCode).toBe(400);

    const unknownBlock = await preview(ids.sessionA, {
      expectedRevision: 2,
      selectedChangeBlockIds: [randomUUID()]
    });
    expect(unknownBlock.statusCode).toBe(400);

    const before = await server.inject({
      method: "GET",
      url: `/api/calendar/day-plan?date=${DAY}&timeZone=${encodeURIComponent(ZONE)}`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    const beforeBody = before.json<GetDayPlanResponse>();

    const success = await preview(ids.sessionA, {
      expectedRevision: 2,
      selectedChangeBlockIds: [focusBlockId, breakBlockId]
    });
    expect(success.statusCode).toBe(200);
    const body = success.json<PreviewDayPlanResponse>();
    expect(body.revision).toBe(2);
    // No connected calendar account exists for this actor, so preview must report unavailable
    // rather than silently treating the calendar as free.
    expect(body.calendarAvailability).toBe("unavailable");
    expect(body.conflicts.filter((conflict) => conflict.kind === "calendar_busy")).toEqual([]);
    expect(body.blocks).toEqual([
      {
        blockId: focusBlockId,
        taskId: task.id,
        changeKind: "add",
        before: null,
        after: { startsAt: "2026-09-12T17:00:00.000Z", durationMinutes: 60 },
        eligible: true,
        ineligibleReason: null,
        deadlineRisk: false
      },
      {
        blockId: breakBlockId,
        taskId: null,
        changeKind: "add",
        before: null,
        after: { startsAt: "2026-09-12T18:00:00.000Z", durationMinutes: 30 },
        eligible: true,
        ineligibleReason: null,
        deadlineRisk: false
      }
    ]);
    expect(body.eligibleBlockIds).toEqual([focusBlockId, breakBlockId]);

    const after = await server.inject({
      method: "GET",
      url: `/api/calendar/day-plan?date=${DAY}&timeZone=${encodeURIComponent(ZONE)}`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(after.json<GetDayPlanResponse>()).toEqual(beforeBody);
  });

  it("resolves done, archived and invisible tasks to their preview eligibility", async () => {
    const doneTask = await dataContext.withDataContext(userA, (scopedDb) =>
      new TasksRepository().create(scopedDb, { title: "Already done", status: "done" })
    );
    const archivedTask = await dataContext.withDataContext(userA, (scopedDb) =>
      new TasksRepository().create(scopedDb, { title: "Archived", status: "archived" })
    );
    const invisibleTask = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "preview-task-state-b" },
      (scopedDb) => new TasksRepository().create(scopedDb, { title: "Owned by someone else" })
    );

    const day = "2026-09-13";
    const created = await server.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { date: day, timeZone: ZONE }
    });
    expect(created.statusCode).toBe(200);
    const plan = created.json<CreateDayPlanResponse>().plan;

    const blockFor = (taskId: string, startsAt: string) => ({
      kind: "focus" as const,
      taskId,
      title: "A task",
      pendingChange: { kind: "add" as const, startsAt, durationMinutes: 30 }
    });

    const draft = await server.inject({
      method: "PATCH",
      url: `/api/calendar/day-plans/${plan.id}/draft`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        date: day,
        timeZone: ZONE,
        expectedRevision: 1,
        blocks: [
          blockFor(doneTask.id, "2026-09-13T16:00:00.000Z"),
          blockFor(archivedTask.id, "2026-09-13T17:00:00.000Z")
        ]
      }
    });
    expect(draft.statusCode).toBe(200);
    const savedPlan = draft.json<SaveDayPlanResponse>().plan;
    const [doneBlockId, archivedBlockId] = savedPlan.blocks.map((block) => block.id);
    if (!doneBlockId || !archivedBlockId) throw new Error("server did not assign block ids");

    // The save route itself refuses a block whose task isn't owned by the actor (a task that
    // never existed is refused the same way, for the same reason — see the missing/invisible
    // case already proved in the unit tests for buildDayPlanPreview). So a block naming a task
    // the actor can't see is seeded directly, the only way such a row can ever exist for preview
    // to face.
    const invisibleBlockId = randomUUID();
    const rawClient = new Client({ connectionString: connectionStrings.bootstrap });
    await rawClient.connect();
    try {
      await rawClient.query(
        `
          INSERT INTO app.day_plan_blocks
            (id, plan_id, owner_user_id, task_id, kind, title, pending_change, position)
          VALUES ($1, $2, $3, $4, 'focus', 'A task', $5::jsonb, 2)
        `,
        [
          invisibleBlockId,
          plan.id,
          ids.userA,
          invisibleTask.id,
          JSON.stringify({
            kind: "add",
            startsAt: "2026-09-13T18:00:00.000Z",
            durationMinutes: 30
          })
        ]
      );
    } finally {
      await rawClient.end();
    }

    const preview = await server.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/preview`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        expectedRevision: 2,
        selectedChangeBlockIds: [doneBlockId, archivedBlockId, invisibleBlockId]
      }
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json<PreviewDayPlanResponse>();
    const reasonFor = (blockId: string) =>
      body.blocks.find((block) => block.blockId === blockId)?.ineligibleReason;
    expect(reasonFor(doneBlockId)).toBe("task_done");
    expect(reasonFor(archivedBlockId)).toBe("task_archived");
    expect(reasonFor(invisibleBlockId)).toBe("task_unavailable");
    expect(body.eligibleBlockIds).toEqual([]);
  });

  it("checks a live-read calendar conflict by the actor-visible event, and excludes a block's own event", async () => {
    const cipher = createConnectorSecretCipher();
    const connectorsRepo = new ConnectorsRepository();
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed-google-live" },
      (scopedDb) =>
        connectorsRepo.upsertGoogleAccount(scopedDb, {
          scopes: [CALENDAR_SCOPE],
          encryptedSecret: cipher.encryptJson({
            kind: "google-oauth",
            clientId: "cid",
            clientSecret: "csecret",
            accessToken: "atoken",
            refreshToken: "rtoken",
            tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
            grantedScopes: [CALENDAR_SCOPE]
          })
        })
    );

    const day = "2026-09-14";
    const created = await server.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { date: day, timeZone: ZONE }
    });
    const plan = created.json<CreateDayPlanResponse>().plan;

    const draft = await server.inject({
      method: "PATCH",
      url: `/api/calendar/day-plans/${plan.id}/draft`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        date: day,
        timeZone: ZONE,
        expectedRevision: 1,
        blocks: [
          {
            kind: "focus",
            taskId: null,
            title: "Overlaps a real meeting",
            pendingChange: {
              kind: "add",
              startsAt: "2026-09-14T16:00:00.000Z",
              durationMinutes: 60
            }
          },
          {
            kind: "focus",
            taskId: null,
            title: "Overlaps its own event, which must not count",
            pendingChange: {
              kind: "add",
              startsAt: "2026-09-14T18:00:00.000Z",
              durationMinutes: 60
            }
          }
        ]
      }
    });
    expect(draft.statusCode).toBe(200);
    const savedPlan = draft.json<SaveDayPlanResponse>().plan;
    const [conflictBlockId, ownEventBlockId] = savedPlan.blocks.map((block) => block.id);
    if (!conflictBlockId || !ownEventBlockId) throw new Error("server did not assign block ids");

    // Give the second block an already-scheduled calendar event matching the mocked event
    // below, so the preview must recognize it as the block's own placement, not a conflict.
    await setBlockActualPlacement(ownEventBlockId, {
      startsAt: "2026-09-14T18:00:00.000Z",
      durationMinutes: 60,
      calendarEventRef: "evt-own"
    });

    liveFetchHandler = (async (url: string) => {
      if (String(url).includes("/calendars/") && String(url).includes("/events")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: "evt-real-meeting",
                summary: "Board sync",
                start: { dateTime: "2026-09-14T16:30:00.000Z" },
                end: { dateTime: "2026-09-14T17:00:00.000Z" }
              },
              {
                id: "evt-own",
                summary: "Overlaps its own event, which must not count",
                start: { dateTime: "2026-09-14T18:00:00.000Z" },
                end: { dateTime: "2026-09-14T19:00:00.000Z" }
              }
            ]
          })
        } as Response;
      }
      throw new Error(`unexpected fetch in live-conflict test: ${String(url)}`);
    }) as typeof fetch;

    const preview = await server.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/preview`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        expectedRevision: 2,
        selectedChangeBlockIds: [conflictBlockId, ownEventBlockId]
      }
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json<PreviewDayPlanResponse>();
    expect(body.calendarAvailability).toBe("available");
    const conflicts = body.conflicts.filter((conflict) => conflict.kind === "calendar_busy");
    expect(conflicts).toEqual([
      {
        blockId: conflictBlockId,
        kind: "calendar_busy",
        withBlockId: null,
        detail: 'Overlaps "Board sync" on Google',
        calendarEvent: {
          eventKey: "evt-real-meeting",
          title: "Board sync",
          startsAt: "2026-09-14T16:30:00.000Z",
          endsAt: "2026-09-14T17:00:00.000Z",
          accountLabel: "Google"
        }
      }
    ]);
  });

  it("falls back to the last synced calendar state when the live read fails, and still names a stale conflict", async () => {
    const cipher = createConnectorSecretCipher();
    const connectorsRepo = new ConnectorsRepository();
    const account = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed-google-stale" },
      (scopedDb) =>
        connectorsRepo.upsertGoogleAccount(scopedDb, {
          scopes: [CALENDAR_SCOPE],
          encryptedSecret: cipher.encryptJson({
            kind: "google-oauth",
            clientId: "cid",
            clientSecret: "csecret",
            accessToken: "atoken",
            refreshToken: "rtoken",
            tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
            grantedScopes: [CALENDAR_SCOPE]
          })
        })
    );
    const finishedAt = new Date("2026-09-14T12:00:00.000Z");
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed-google-stale-sync" },
      (scopedDb) =>
        connectorsRepo.markSyncFinished(scopedDb, account.id, {
          finishedAt,
          status: "success",
          error: null,
          counts: {}
        })
    );
    const calendarRepo = new CalendarRepository();
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "seed-google-stale-event" },
      (scopedDb) =>
        calendarRepo.upsertCachedEvent(scopedDb, {
          connectorAccountId: account.id,
          externalId: "evt-cached-stale",
          title: "Cached board sync",
          startsAt: new Date("2026-09-15T16:30:00.000Z"),
          endsAt: new Date("2026-09-15T17:00:00.000Z")
        })
    );

    const day = "2026-09-15";
    const created = await server.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { date: day, timeZone: ZONE }
    });
    const plan = created.json<CreateDayPlanResponse>().plan;
    const draft = await server.inject({
      method: "PATCH",
      url: `/api/calendar/day-plans/${plan.id}/draft`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        date: day,
        timeZone: ZONE,
        expectedRevision: 1,
        blocks: [
          {
            kind: "focus",
            taskId: null,
            title: "Overlaps the cached meeting",
            pendingChange: {
              kind: "add",
              startsAt: "2026-09-15T16:00:00.000Z",
              durationMinutes: 60
            }
          }
        ]
      }
    });
    expect(draft.statusCode).toBe(200);
    const savedPlan = draft.json<SaveDayPlanResponse>().plan;
    const blockId = savedPlan.blocks[0]?.id;
    if (!blockId) throw new Error("server did not assign block id");

    liveFetchHandler = (async (url: string) => {
      if (String(url).includes("/calendars/") && String(url).includes("/events")) {
        throw new Error("read ECONNRESET");
      }
      throw new Error(`unexpected fetch in stale-cache test: ${String(url)}`);
    }) as typeof fetch;

    const preview = await server.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/preview`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        expectedRevision: 2,
        selectedChangeBlockIds: [blockId]
      }
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json<PreviewDayPlanResponse>();
    expect(body.calendarAvailability).toBe("stale");
    expect(body.calendarAsOf).toBe(finishedAt.toISOString());
    expect(body.conflicts.filter((conflict) => conflict.kind === "calendar_busy")).toEqual([
      {
        blockId,
        kind: "calendar_busy",
        withBlockId: null,
        detail: 'Overlaps "Cached board sync" on Google',
        calendarEvent: {
          eventKey: "evt-cached-stale",
          title: "Cached board sync",
          startsAt: "2026-09-15T16:30:00.000Z",
          endsAt: "2026-09-15T17:00:00.000Z",
          accountLabel: "Google"
        }
      }
    ]);
  });

  it("keeps the saved plan and its preview stable after the server restarts against the same database", async () => {
    const task = await dataContext.withDataContext(userA, (scopedDb) =>
      new TasksRepository().create(scopedDb, {
        title: "Survive a restart",
        dueAt: "2026-09-17T18:00:00.000Z",
        doAt: "2026-09-16T16:00:00.000Z"
      })
    );
    const day = "2026-09-16";
    const created = await server.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { date: day, timeZone: ZONE }
    });
    const plan = created.json<CreateDayPlanResponse>().plan;
    const draft = await server.inject({
      method: "PATCH",
      url: `/api/calendar/day-plans/${plan.id}/draft`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        date: day,
        timeZone: ZONE,
        expectedRevision: 1,
        blocks: [
          {
            kind: "focus",
            taskId: task.id,
            title: "Survive a restart",
            pendingChange: {
              kind: "add",
              startsAt: "2026-09-16T17:00:00.000Z",
              durationMinutes: 60
            }
          }
        ]
      }
    });
    expect(draft.statusCode).toBe(200);
    const blockId = draft.json<SaveDayPlanResponse>().plan.blocks[0]?.id;
    if (!blockId) throw new Error("server did not assign block id");

    const previewBefore = await server.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/preview`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { expectedRevision: 2, selectedChangeBlockIds: [blockId] }
    });
    expect(previewBefore.statusCode).toBe(200);

    // Simulate a process restart: a brand-new server instance attached to the same database,
    // with no in-memory state carried over from the instance above.
    const restarted = createApiServer({ appDb, boss, logger: false });
    await restarted.ready();
    try {
      const getAfterRestart = await restarted.inject({
        method: "GET",
        url: `/api/calendar/day-plan?date=${day}&timeZone=${encodeURIComponent(ZONE)}`,
        headers: { authorization: `Bearer ${ids.sessionA}` }
      });
      expect(getAfterRestart.statusCode).toBe(200);
      const planAfterRestart = getAfterRestart.json<GetDayPlanResponse>().plan;
      if (!planAfterRestart) throw new Error("plan not found after restart");
      expect(planAfterRestart.blocks).toEqual(draft.json<SaveDayPlanResponse>().plan.blocks);

      const previewAfterRestart = await restarted.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${plan.id}/preview`,
        headers: { authorization: `Bearer ${ids.sessionA}` },
        payload: { expectedRevision: 2, selectedChangeBlockIds: [blockId] }
      });
      expect(previewAfterRestart.statusCode).toBe(200);
      expect(previewAfterRestart.json<PreviewDayPlanResponse>()).toEqual(
        previewBefore.json<PreviewDayPlanResponse>()
      );
    } finally {
      await restarted.close();
    }
  });
});
