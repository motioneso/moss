import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb } from "@moss/db";
import type { DayPlanRepository } from "@moss/calendar";
import type { CreateDayPlanResponse, DayPlanDto } from "@moss/shared";

import { registerDayPlanRoutes } from "../../packages/calendar/src/day-plan-routes.js";
import { calendarModuleManifest } from "../../packages/calendar/src/manifest.js";

const actor: AccessContext = { actorUserId: "actor-a", requestId: "saved-create" };
const emptyPlan: DayPlanDto = {
  id: "plan-a",
  localDay: "2026-09-12",
  timeZone: "America/Los_Angeles",
  revision: 1,
  sourceRunId: "11111111-1111-4111-8111-111111111111",
  eveningIntent: {
    priorityTaskIds: [],
    capacity: null,
    notes: null,
    corrections: [],
    commitments: []
  },
  blocks: []
};

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function buildApp(
  options: {
    plan?: DayPlanDto;
    run?: unknown;
  } = {}
) {
  const app = Fastify();
  servers.push(app);
  const contexts: AccessContext[] = [];
  const scopedDb = {} as DataContextDb;
  const create = vi
    .fn<DayPlanRepository["createForDay"]>()
    .mockResolvedValue(options.plan ?? emptyPlan);
  // An explicitly passed missing run stays missing; only an omitted key means present.
  const findSourceRun = vi.fn<(scopedDb: DataContextDb, runId: string) => Promise<unknown>>(
    async () => ("run" in options ? options.run : { id: "run" })
  );
  const resolveTimeZone = vi.fn(async () => "America/Los_Angeles");
  const resolveAccessContext = vi.fn(async () => actor);
  registerDayPlanRoutes(app, {
    resolveAccessContext,
    resolveTimeZone,
    dayPlanRepository: {
      getForDay: async () => undefined,
      createForDay: create,
      saveDraft: async () => undefined as never
    },
    findSourceRun,
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
  return { app, create, findSourceRun, contexts, scopedDb, resolveTimeZone, resolveAccessContext };
}

describe("saved day-plan creation route", () => {
  it("creates an empty plan with an owned source run using only the authenticated actor", async () => {
    const { app, create, findSourceRun, contexts, scopedDb } = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      payload: {
        date: "2026-09-12",
        timeZone: "America/Los_Angeles",
        sourceRunId: "11111111-1111-4111-8111-111111111111"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<CreateDayPlanResponse>()).toEqual({ plan: emptyPlan });
    expect(findSourceRun).toHaveBeenCalledExactlyOnceWith(
      scopedDb,
      "11111111-1111-4111-8111-111111111111"
    );
    expect(create).toHaveBeenCalledExactlyOnceWith(scopedDb, {
      localDay: "2026-09-12",
      timeZone: "America/Los_Angeles",
      sourceRunId: "11111111-1111-4111-8111-111111111111"
    });
    expect(findSourceRun.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      create.mock.invocationCallOrder[0] ?? 0
    );
    expect(contexts).toEqual([actor]);
  });

  it("defaults the zone through the resolver and accepts omitted and null sources", async () => {
    const noSource = { ...emptyPlan, sourceRunId: null };
    const { app, create, findSourceRun } = buildApp({ plan: noSource });
    for (const payload of [{ date: "2026-09-12" }, { date: "2026-09-12", sourceRunId: null }]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/calendar/day-plans",
        payload
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ plan: noSource });
    }
    expect(create).toHaveBeenCalledTimes(2);
    expect(findSourceRun).not.toHaveBeenCalled();
  });

  it("repeats creation without replacing the source", async () => {
    const { app, create, findSourceRun, scopedDb } = buildApp();
    const payload = {
      date: "2026-09-12",
      sourceRunId: "11111111-1111-4111-8111-111111111111"
    };
    const first = await app.inject({ method: "POST", url: "/api/calendar/day-plans", payload });
    const second = await app.inject({ method: "POST", url: "/api/calendar/day-plans", payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ plan: emptyPlan });
    expect(create).toHaveBeenCalledTimes(2);
    expect(findSourceRun).toHaveBeenCalledTimes(2);
    for (const call of findSourceRun.mock.calls) {
      expect(call[0]).toBe(scopedDb);
      expect(call[1]).toBe("11111111-1111-4111-8111-111111111111");
    }
    for (const call of create.mock.calls) {
      expect(call[0]).toBe(scopedDb);
      expect(call[1]).toEqual({
        localDay: "2026-09-12",
        timeZone: "America/Los_Angeles",
        sourceRunId: "11111111-1111-4111-8111-111111111111"
      });
    }
  });

  it.each([
    {},
    { date: "2026-09-12", sourceRunId: 42 },
    { date: "2026-09-12", actorUserId: "actor-b" },
    { date: "2026-09-12", ownerUserId: "actor-b" },
    { date: "2026-09-12", revision: 9 },
    { date: "2026-09-12", expectedRevision: 1 },
    { date: "2026-09-12", blocks: [] },
    { date: "2026-09-12", eveningIntent: null }
  ])("rejects schema-invalid bodies before authentication: %j", async (payload) => {
    const { app, create, contexts } = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/calendar/day-plans", payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(create).not.toHaveBeenCalled();
    expect(contexts).toEqual([]);
  });

  it.each([
    { date: "tomorrow" },
    { date: "2026-02-30" },
    { date: "0000-01-01" },
    { date: "2026-09-12", timeZone: "Not/AZone" },
    { date: "2026-09-12", timeZone: "" },
    { date: "2026-09-12", sourceRunId: "not-a-uuid" },
    { date: "2026-09-12", sourceRunId: "" }
  ])("rejects semantically invalid bodies without touching storage: %j", async (payload) => {
    const { app, create } = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/calendar/day-plans", payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing or foreign source without revealing which", async () => {
    for (const run of [undefined, null]) {
      const { app, create, findSourceRun } = buildApp({ run });
      const response = await app.inject({
        method: "POST",
        url: "/api/calendar/day-plans",
        payload: { date: "2026-09-12", sourceRunId: "22222222-2222-4222-8222-222222222222" }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toHaveProperty("error");
      expect(findSourceRun).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("does not create without an authenticated actor", async () => {
    const { app, create, resolveAccessContext } = buildApp();
    resolveAccessContext.mockRejectedValue(new Error("Session is missing or expired"));
    const response = await app.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      payload: { date: "2026-09-12" }
    });
    expect(response.statusCode).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("declares the creation route and keeps planning and writeback coming soon", async () => {
    const postRoute = calendarModuleManifest.routes.find(
      (route) => route.method === "POST" && route.path === "/api/calendar/day-plans"
    );
    expect(postRoute?.permissionId).toBe("calendar.manage");
    const manage = calendarModuleManifest.permissions.find(
      (permission) => permission.id === "calendar.manage"
    );
    expect(manage?.description).toMatch(/saved day plan/i);
    const behaviors = calendarModuleManifest.sourceBehaviors.flatMap(
      (source) => source.behaviors ?? []
    );
    expect(behaviors.find((behavior) => behavior.id === "calendar.planning")?.default).toBe(
      "coming-soon"
    );
    expect(behaviors.find((behavior) => behavior.id === "calendar.writeback")?.default).toBe(
      "coming-soon"
    );
  });

  it("validates the source through the injected lookup and never imports internals", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/calendar/src");
    const routes = readFileSync(resolve(root, "day-plan-routes.ts"), "utf8");
    expect(routes).toMatch("findSourceRun");
    expect(routes).not.toMatch("BriefingsRepository");
    expect(routes).not.toMatch("briefing_runs");
    expect(routes).not.toMatch('from "@moss/briefings"');
    expect(routes).not.toMatch("from '@moss/briefings'");
    const repository = readFileSync(resolve(root, "day-plan-repository.ts"), "utf8");
    expect(repository).not.toMatch("briefing_runs");
  });

  it("returns a scrubbed error when creation fails", async () => {
    const { app, create } = buildApp();
    create.mockRejectedValue(new Error("fixture database internals"));
    const response = await app.inject({
      method: "POST",
      url: "/api/calendar/day-plans",
      payload: { date: "2026-09-12" }
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
  });
});
