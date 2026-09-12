import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb } from "@moss/db";
import type { DayPlanRepository } from "@moss/calendar";
import { HttpError } from "@moss/module-sdk";
import type { DayPlanDto, SaveDayPlanResponse } from "@moss/shared";

import { registerDayPlanRoutes } from "../../packages/calendar/src/day-plan-routes.js";
import { calendarModuleManifest } from "../../packages/calendar/src/manifest.js";

const actor: AccessContext = { actorUserId: "actor-a", requestId: "saved-draft" };
const actorB: AccessContext = { actorUserId: "actor-b", requestId: "saved-draft-b" };
const plan: DayPlanDto = {
  id: "11111111-1111-4111-8111-111111111111",
  localDay: "2026-09-12",
  timeZone: "America/Los_Angeles",
  revision: 4,
  sourceRunId: null,
  eveningIntent: {
    priorityTaskIds: [],
    capacity: "light",
    notes: "Leave room for follow-up",
    corrections: [],
    commitments: []
  },
  blocks: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "focus",
      taskId: null,
      title: "Write the draft",
      position: 0,
      actualPlacement: null,
      pendingChange: {
        kind: "move",
        startsAt: "2026-09-12T17:00:00.000Z",
        durationMinutes: 60
      }
    }
  ]
};

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function buildApp(options: { save?: DayPlanDto; auth?: Error } = {}) {
  const app = Fastify();
  servers.push(app);
  const contexts: AccessContext[] = [];
  const scopedDb = {} as DataContextDb;
  const saveDraft = vi.fn<DayPlanRepository["saveDraft"]>().mockResolvedValue(options.save ?? plan);
  const resolveAccessContext = vi.fn(async (request: FastifyRequest) => {
    if (options.auth) throw options.auth;
    return request.headers["x-test-actor"] === "actor-b" ? actorB : actor;
  });
  registerDayPlanRoutes(app, {
    resolveAccessContext,
    resolveTimeZone: async () => "America/Los_Angeles",
    dayPlanRepository: {
      getForDay: async () => undefined,
      createForDay: async () => undefined as never,
      saveDraft
    },
    findSourceRun: async () => undefined,
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
  return { app, contexts, scopedDb, saveDraft, resolveAccessContext };
}

const planId = plan.id;
const url = `/api/calendar/day-plans/${planId}/draft`;

describe("saved day-plan draft route", () => {
  it("forwards the authenticated actor, explicit identity and writable draft", async () => {
    const { app, contexts, scopedDb, saveDraft } = buildApp();
    const payload = {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 3,
      eveningIntent: { capacity: "light", notes: "Leave room for follow-up" },
      blocks: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          kind: "focus",
          taskId: null,
          title: "Write the draft",
          pendingChange: {
            kind: "move",
            startsAt: "2026-09-12T17:00:00.000Z",
            durationMinutes: 60
          }
        }
      ]
    };
    const response = await app.inject({ method: "PATCH", url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json<SaveDayPlanResponse>()).toEqual({ plan });
    expect(saveDraft).toHaveBeenCalledExactlyOnceWith(scopedDb, {
      planId,
      localDay: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 3,
      eveningIntent: payload.eveningIntent,
      blocks: payload.blocks
    });
    expect(contexts).toEqual([actor]);
  });

  it("forwards explicit reset and clear values without changing their meaning", async () => {
    const { app, saveDraft } = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url,
      payload: {
        date: "2026-09-12",
        timeZone: "America/Los_Angeles",
        expectedRevision: 3,
        eveningIntent: null,
        blocks: []
      }
    });

    expect(response.statusCode).toBe(200);
    expect(saveDraft.mock.calls[0]?.[1]).toMatchObject({
      localDay: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 3,
      eveningIntent: null,
      blocks: []
    });
  });

  it("forwards the selected authenticated actor context", async () => {
    const { app, contexts } = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url,
      headers: { "x-test-actor": "actor-b" },
      payload: {
        date: "2026-09-12",
        timeZone: "America/Los_Angeles",
        expectedRevision: 3,
        eveningIntent: null
      }
    });

    expect(response.statusCode).toBe(200);
    expect(contexts).toEqual([actorB]);
  });

  it.each([
    {},
    { date: "2026-09-12", timeZone: "America/Los_Angeles", expectedRevision: 1 },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      actorUserId: "actor-b",
      eveningIntent: null
    },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      eveningIntent: { actorUserId: "actor-b" }
    },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      blocks: [{ kind: "focus", taskId: null, title: null, position: 0 }]
    },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      blocks: [{ kind: "focus", taskId: null, title: null, actualPlacement: null }]
    }
  ])("rejects strict schema violations before storage: %j", async (payload) => {
    const { app, saveDraft, contexts } = buildApp();
    const response = await app.inject({ method: "PATCH", url, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(saveDraft).not.toHaveBeenCalled();
    expect(contexts).toEqual([]);
  });

  it.each([
    { date: "tomorrow", timeZone: "America/Los_Angeles", expectedRevision: 1, eveningIntent: null },
    {
      date: "2026-02-30",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      eveningIntent: null
    },
    { date: "2026-09-12", timeZone: "Not/AZone", expectedRevision: 1, eveningIntent: null },
    { date: "2026-09-12", timeZone: "", expectedRevision: 1, eveningIntent: null },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 0,
      eveningIntent: null
    },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      eveningIntent: { capacity: "nope" }
    },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      eveningIntent: {}
    },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      eveningIntent: { corrections: {} }
    },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      blocks: [
        {
          kind: "focus",
          taskId: "not-a-uuid",
          title: null
        }
      ]
    },
    {
      date: "2026-09-12",
      timeZone: "America/Los_Angeles",
      expectedRevision: 1,
      blocks: [
        {
          kind: "focus",
          taskId: null,
          title: null,
          pendingChange: { kind: "remove", startsAt: "2026-09-12T17:00:00.000Z" }
        }
      ]
    }
  ])("rejects semantic invalid values without storage: %j", async (payload) => {
    const { app, saveDraft } = buildApp();
    const response = await app.inject({ method: "PATCH", url, payload });

    expect(response.statusCode).toBe(400);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("authenticates before returning 400 for an invalid path id", async () => {
    const { app, saveDraft, resolveAccessContext } = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/calendar/day-plans/not-a-uuid/draft",
      payload: {
        date: "2026-09-12",
        timeZone: "America/Los_Angeles",
        expectedRevision: 1,
        eveningIntent: null
      }
    });

    expect(response.statusCode).toBe(400);
    expect(resolveAccessContext).toHaveBeenCalledTimes(1);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("returns 401 without saving when authentication is unavailable", async () => {
    const { app, saveDraft } = buildApp({ auth: new Error("Session is missing or expired") });
    const response = await app.inject({
      method: "PATCH",
      url,
      payload: {
        date: "2026-09-12",
        timeZone: "America/Los_Angeles",
        expectedRevision: 1,
        eveningIntent: null
      }
    });

    expect(response.statusCode).toBe(401);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("maps repository conflicts and scrubs unexpected errors", async () => {
    const conflict = buildApp();
    conflict.saveDraft.mockRejectedValueOnce(
      new HttpError(409, "day plan changed since it was read")
    );
    const conflictResponse = await conflict.app.inject({
      method: "PATCH",
      url,
      payload: {
        date: "2026-09-12",
        timeZone: "America/Los_Angeles",
        expectedRevision: 1,
        eveningIntent: null
      }
    });
    expect(conflictResponse.statusCode).toBe(409);
    await conflict.app.close();

    const failure = buildApp();
    failure.saveDraft.mockRejectedValueOnce(new Error("fixture database internals"));
    const failureResponse = await failure.app.inject({
      method: "PATCH",
      url,
      payload: {
        date: "2026-09-12",
        timeZone: "America/Los_Angeles",
        expectedRevision: 1,
        eveningIntent: null
      }
    });
    expect(failureResponse.statusCode).toBe(500);
    expect(failureResponse.json()).toEqual({ error: "Internal server error" });
    await failure.app.close();
  });

  it("declares the manage route and saved-draft behavior", () => {
    const route = calendarModuleManifest.routes.find(
      (entry) => entry.method === "PATCH" && entry.path === "/api/calendar/day-plans/:id/draft"
    );
    expect(route?.permissionId).toBe("calendar.manage");
    expect(route?.requestSchema).toBeDefined();
    expect(calendarModuleManifest.features).toContainEqual(
      expect.objectContaining({ id: "calendar.saved_day_plan_draft" })
    );
    const feature = calendarModuleManifest.features.find(
      (entry) => entry.id === "calendar.saved_day_plan_draft"
    );
    expect(feature?.description).toMatch(/not previewed, approved, scheduled/i);
  });
});
