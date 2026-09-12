import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessContext, BriefingRun, DataContextDb, Task } from "@moss/db";
import type { DayPlanRepository } from "@moss/calendar";
import type { DayPlanDto, GetDayPlanResponse } from "@moss/shared";

import { registerDayPlanRoutes } from "../../packages/calendar/src/day-plan-routes.js";

const actor: AccessContext = { actorUserId: "actor-a", requestId: "saved-read" };
const snapshot: DayPlanDto = {
  id: "plan-a",
  localDay: "2026-09-12",
  timeZone: "America/Los_Angeles",
  revision: 3,
  sourceRunId: "run-a",
  eveningIntent: {
    priorityTaskIds: ["task-a"],
    capacity: "light",
    notes: "Keep the afternoon open",
    corrections: [{ taskId: null, note: "The follow-up is unfinished", source: "actor" }],
    commitments: [{ taskId: "task-a", decision: "defer" }]
  },
  blocks: [
    {
      id: "block-a",
      kind: "focus",
      taskId: "task-a",
      title: "Saved task title",
      position: 0,
      actualPlacement: {
        startsAt: "2026-09-12T16:00:00.000Z",
        durationMinutes: 60,
        calendarEventRef: "fixture-event"
      },
      pendingChange: { kind: "move", startsAt: "2026-09-12T17:00:00.000Z", durationMinutes: 60 }
    },
    {
      id: "block-b",
      kind: "break",
      taskId: null,
      title: null,
      position: 1,
      actualPlacement: { startsAt: null, durationMinutes: null, calendarEventRef: null },
      pendingChange: { kind: "remove" }
    },
    {
      id: "block-c",
      kind: "prep",
      taskId: null,
      title: "Prepare",
      position: 2,
      actualPlacement: null,
      pendingChange: { kind: "add", startsAt: "2026-09-12T18:00:00.000Z", durationMinutes: 30 }
    }
  ]
};

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const visibleTask: Task = {
  id: "task-a",
  owner_user_id: "actor-a",
  list_id: "list-a",
  parent_task_id: null,
  title: "Current task title",
  description: null,
  status: "done",
  priority: 1,
  position: 0,
  due_at: new Date("2026-09-14T18:00:00.000Z"),
  do_at: new Date("2026-09-12T16:00:00.000Z"),
  completed_at: null,
  effort: "medium",
  source: "manual",
  source_ref: null,
  external_key: null,
  recurrence: null,
  recurrence_series_id: null,
  suggestion_metadata: null,
  created_at: new Date("2026-09-12T15:00:00.000Z"),
  updated_at: new Date("2026-09-12T15:00:00.000Z")
};

const visibleRun: BriefingRun = {
  id: "run-a",
  definition_id: "definition-a",
  owner_user_id: "actor-a",
  status: "succeeded",
  run_kind: "manual",
  briefing_type: "evening",
  summary_text: "Evening summary",
  source_metadata: {},
  created_at: new Date("2026-09-12T10:00:00.000Z")
};

function buildApp(
  plan: DayPlanDto | undefined = snapshot,
  options: { run?: BriefingRun | null; tasks?: Map<string, Task | undefined> } = {}
) {
  const app = Fastify();
  servers.push(app);
  const contexts: AccessContext[] = [];
  const scopedDb = {} as DataContextDb;
  const read = vi.fn<DayPlanRepository["getForDay"]>().mockResolvedValue(plan);
  const resolveTimeZone = vi.fn(async () => "America/Los_Angeles");
  const resolveAccessContext = vi.fn(async () => actor);
  const taskStore = options.tasks ?? new Map<string, Task | undefined>([["task-a", visibleTask]]);
  const findTask = vi.fn(async (_db: DataContextDb, taskId: string) => taskStore.get(taskId));
  const findRun = vi.fn(async () =>
    options.run === undefined ? visibleRun : (options.run ?? undefined)
  );
  registerDayPlanRoutes(app, {
    resolveAccessContext,
    resolveTimeZone,
    dayPlanRepository: {
      getForDay: read,
      createForDay: async () => undefined as never,
      saveDraft: async () => undefined as never
    },
    findSourceRun: async () => undefined,
    findTask,
    findRun,
    dataContext: {
      withDataContext: async <T>(
        context: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ) => {
        contexts.push(context);
        return work(scopedDb);
      }
    }
  });
  return { app, read, contexts, scopedDb, resolveTimeZone, resolveAccessContext };
}

describe("saved day-plan read route", () => {
  it("serializes the full stored snapshot using only the authenticated actor", async () => {
    const { app, read, contexts, scopedDb } = buildApp();
    const response = await app.inject({
      url: "/api/calendar/day-plan?date=2026-09-12&actorUserId=actor-b&ownerUserId=actor-b"
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<GetDayPlanResponse>();
    expect(body.plan).toEqual(snapshot);
    expect(body.tasks).toEqual([
      {
        id: "task-a",
        title: "Current task title",
        status: "done",
        dueAt: "2026-09-14T18:00:00.000Z",
        doAt: "2026-09-12T16:00:00.000Z",
        effort: "medium"
      }
    ]);
    expect(body.unavailableTaskIds).toEqual([]);
    expect(body.sourceRun).toEqual({
      id: "run-a",
      briefingType: "evening",
      status: "succeeded",
      createdAt: "2026-09-12T10:00:00.000Z"
    });
    expect(body.sourceRunUnavailable).toBe(false);
    expect(read).toHaveBeenCalledExactlyOnceWith(scopedDb, {
      localDay: "2026-09-12",
      timeZone: "America/Los_Angeles"
    });
    expect(contexts).toEqual([actor]);
  });

  it("keeps stored content identical while projecting changed task facts", async () => {
    const changed = new Map<string, Task | undefined>([
      ["task-a", { ...visibleTask, title: "Renamed by the owner", status: "archived" as const }]
    ]);
    const { app } = buildApp(snapshot, { tasks: changed });
    const response = await app.inject({ url: "/api/calendar/day-plan?date=2026-09-12" });
    expect(response.statusCode).toBe(200);
    const body = response.json<GetDayPlanResponse>();
    expect(body.plan).toEqual(snapshot);
    expect(body.plan?.blocks[0]).toMatchObject({ taskId: "task-a", title: "Saved task title" });
    expect(body.tasks).toEqual([
      {
        id: "task-a",
        title: "Renamed by the owner",
        status: "archived",
        dueAt: "2026-09-14T18:00:00.000Z",
        doAt: "2026-09-12T16:00:00.000Z",
        effort: "medium"
      }
    ]);
    expect(body.unavailableTaskIds).toEqual([]);
  });

  it("reports missing tasks without failing the read", async () => {
    const missing = new Map<string, Task | undefined>([["task-a", undefined]]);
    const { app } = buildApp(snapshot, { tasks: missing });
    const response = await app.inject({ url: "/api/calendar/day-plan?date=2026-09-12" });
    expect(response.statusCode).toBe(200);
    const body = response.json<GetDayPlanResponse>();
    expect(body.plan).toEqual(snapshot);
    expect(body.tasks).toEqual([]);
    expect(body.unavailableTaskIds).toEqual(["task-a"]);
    expect(body.sourceRun).not.toBeNull();
    expect(body.sourceRunUnavailable).toBe(false);
  });

  it("reports a missing source run without failing the read", async () => {
    const { app } = buildApp(snapshot, { run: null });
    const response = await app.inject({ url: "/api/calendar/day-plan?date=2026-09-12" });
    expect(response.statusCode).toBe(200);
    const body = response.json<GetDayPlanResponse>();
    expect(body.plan).toEqual(snapshot);
    expect(body.sourceRun).toBeNull();
    expect(body.sourceRunUnavailable).toBe(true);
  });

  it("returns a null source run without flagging it missing", async () => {
    const noSource: DayPlanDto = { ...snapshot, sourceRunId: null };
    const { app } = buildApp(noSource);
    const response = await app.inject({ url: "/api/calendar/day-plan?date=2026-09-12" });
    expect(response.statusCode).toBe(200);
    const body = response.json<GetDayPlanResponse>();
    expect(body.plan).toEqual(noSource);
    expect(body.sourceRun).toBeNull();
    expect(body.sourceRunUnavailable).toBe(false);
  });

  it("fails closed when a read returns undeclared storage fields", async () => {
    const storageValue = { ...snapshot, legacy_0229_notes: "fixture-only private marker" };
    const { app } = buildApp(storageValue);
    const response = await app.inject({ url: "/api/calendar/day-plan?date=2026-09-12" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(storageValue.legacy_0229_notes);
  });

  it("returns null when the repository has no plan, without creating one", async () => {
    const { app, read } = buildApp();
    read.mockResolvedValue(undefined);
    const response = await app.inject({ url: "/api/calendar/day-plan?date=2026-09-12" });
    expect(response.statusCode).toBe(200);
    expect(response.json<GetDayPlanResponse>()).toEqual({
      plan: null,
      tasks: [],
      unavailableTaskIds: [],
      sourceRun: null,
      sourceRunUnavailable: false
    });
    expect(read).toHaveBeenCalledOnce();
  });

  it("retains null intent, references and pending state", async () => {
    const nullablePlan: DayPlanDto = {
      ...snapshot,
      sourceRunId: null,
      eveningIntent: null,
      blocks: snapshot.blocks.map((block) => ({ ...block, pendingChange: null }))
    };
    const { app } = buildApp(nullablePlan);
    const response = await app.inject({ url: "/api/calendar/day-plan?date=2026-09-12" });
    expect(response.statusCode).toBe(200);
    const body = response.json<GetDayPlanResponse>();
    expect(body.plan).toEqual(nullablePlan);
    expect(body.tasks.map((task) => task.id)).toEqual(["task-a"]);
    expect(body.unavailableTaskIds).toEqual([]);
    expect(body.sourceRun).toBeNull();
    expect(body.sourceRunUnavailable).toBe(false);
  });

  it("uses an explicit original timezone instead of the current locale", async () => {
    const { app, read, scopedDb, resolveTimeZone } = buildApp();
    const response = await app.inject({
      url: "/api/calendar/day-plan?date=2026-09-12&timeZone=Asia%2FTokyo"
    });
    expect(response.statusCode).toBe(200);
    expect(read).toHaveBeenCalledExactlyOnceWith(scopedDb, {
      localDay: "2026-09-12",
      timeZone: "Asia/Tokyo"
    });
    expect(resolveTimeZone).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "?date=tomorrow",
    "?date=2026-02-30",
    "?date=0000-01-01",
    "?date=2026-09-12&timeZone=Not%2FAZone",
    "?date=2026-09-12&timeZone=",
    "?date=2026-09-12&date=2026-09-13"
  ])("rejects invalid queries before reading: %s", async (query) => {
    const { app, read, contexts } = buildApp();
    const response = await app.inject({ url: `/api/calendar/day-plan${query}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(read).not.toHaveBeenCalled();
    expect(contexts).toEqual([]);
  });

  it("does not read without an authenticated actor", async () => {
    const { app, read, resolveAccessContext } = buildApp();
    resolveAccessContext.mockRejectedValue(new Error("Session is missing or expired"));
    const response = await app.inject({ url: "/api/calendar/day-plan?date=2026-09-12" });
    expect(response.statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns a scrubbed error when the saved read fails", async () => {
    const { app, read } = buildApp();
    read.mockRejectedValue(new Error("fixture database internals"));
    const response = await app.inject({ url: "/api/calendar/day-plan?date=2026-09-12" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
  });
});
