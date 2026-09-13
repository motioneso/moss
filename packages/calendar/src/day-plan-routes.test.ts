import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb } from "@moss/db";
import type { ApplyExecutionInput } from "@moss/calendar";
import type { ApplyExecutionReport, DayPlanApplyBatchDto } from "@moss/shared";
import { HttpError } from "@moss/module-sdk";

import { registerDayPlanRoutes, type DayPlanRoutesDependencies } from "./day-plan-routes.js";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const PLAN_ID = "00000000-0000-4000-8000-000000000010";
const OPERATION_ID = "00000000-0000-4000-8000-000000000020";
const ITEM_A = "00000000-0000-4000-8000-0000000000a1";
const ITEM_B = "00000000-0000-4000-8000-0000000000b2";
const BLOCK_A = "00000000-0000-4000-8000-0000000000c3";
const BLOCK_B = "00000000-0000-4000-8000-0000000000d4";

function access(): AccessContext {
  return { actorUserId: ACTOR, requestId: "request:apply-routes" };
}

function itemFixture(
  id: string,
  outcome: "pending" | "applied" | "failed" | "unknown",
  blockId: string | null = BLOCK_A
): DayPlanApplyBatchDto["items"][number] {
  return {
    id,
    blockId,
    kind: "add",
    pendingChange: {
      blockId: blockId ?? BLOCK_A,
      kind: "add",
      startsAt: "2026-09-12T16:00:00.000Z",
      durationMinutes: 30
    },
    outcome,
    result: null
  };
}

function batchFixture(items: DayPlanApplyBatchDto["items"]): DayPlanApplyBatchDto {
  return {
    id: OPERATION_ID,
    planId: PLAN_ID,
    idempotencyKey: "k1",
    operationKey: null,
    expectedRevision: 3,
    outcome: "pending",
    selection: [],
    items
  };
}

type BatchRepo = DayPlanRoutesDependencies["dayPlanRepository"];

function fakeRepository(impl: Partial<BatchRepo> = {}): BatchRepo {
  const unused = async (): Promise<never> => {
    throw new Error("repository method must not run");
  };
  return {
    getForDay: async () => undefined,
    createForDay: unused,
    saveDraft: unused,
    getById: async () => undefined,
    reserveApplyBatch: unused,
    getApplyBatch: async () => undefined,
    getApplyBatchById: async () => undefined,
    ...impl
  };
}

function fakeDataContext() {
  return {
    withDataContext: async <T>(
      _access: AccessContext,
      work: (scopedDb: DataContextDb) => Promise<T>
    ): Promise<T> => work({} as DataContextDb)
  } as DayPlanRoutesDependencies["dataContext"];
}

function buildApp(
  deps: Partial<DayPlanRoutesDependencies> & { resolveAccessContext?: () => Promise<AccessContext> }
) {
  const app = Fastify();
  registerDayPlanRoutes(app, {
    resolveAccessContext: deps.resolveAccessContext ?? (async () => access()),
    resolveTimeZone: async () => "America/Los_Angeles",
    dayPlanRepository: fakeRepository(),
    findSourceRun: async () => undefined,
    findTask: async () => undefined,
    findRun: async () => undefined,
    dataContext: fakeDataContext(),
    ...deps
  });
  return app;
}

function appliedReport(items: ApplyExecutionReport["items"]): ApplyExecutionReport {
  return { operationId: OPERATION_ID, planId: PLAN_ID, status: "completed", items };
}

describe("day plan apply routes", () => {
  it("authenticates before validating the body", async () => {
    const reserve = vi.fn();
    const app = buildApp({
      resolveAccessContext: async () => {
        throw new Error("Session is missing or expired");
      },
      dayPlanRepository: fakeRepository({ reserveApplyBatch: reserve as never })
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
      payload: { nonsense: true }
    });
    expect(response.statusCode).toBe(401);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rejects malformed apply bodies with 400", async () => {
    const reserve = vi.fn();
    const app = buildApp({
      dayPlanRepository: fakeRepository({ reserveApplyBatch: reserve as never })
    });
    const good = { expectedRevision: 3, idempotencyKey: "k1" };
    const cases: Record<string, unknown>[] = [
      { ...good, extra: true },
      { ...good, expectedRevision: 0 },
      { ...good, expectedRevision: 1.5 },
      { ...good, idempotencyKey: "  " },
      { ...good, idempotencyKey: "x".repeat(129) },
      { ...good, operationKey: 7 },
      { ...good, selectedBlockIds: ["nope"] },
      { ...good, selectedBlockIds: [BLOCK_A, BLOCK_A] },
      { ...good, selectedBlockIds: "nope" }
    ];
    for (const payload of cases) {
      const response = await app.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(reserve).not.toHaveBeenCalled();
  });

  it("maps reservation failures and successes", async () => {
    const batch = batchFixture([itemFixture(ITEM_A, "pending"), itemFixture(ITEM_B, "pending")]);
    const calls: ApplyExecutionInput[] = [];
    const executor = async (input: ApplyExecutionInput): Promise<ApplyExecutionReport> => {
      calls.push(input);
      return appliedReport(
        batch.items.map((item) => ({
          itemId: item.id,
          blockId: item.blockId,
          outcome: "applied" as const,
          result: {
            status: "applied" as const,
            providerEventId: "evt-1",
            startsAt: "2026-09-12T16:00:00.000Z",
            durationMinutes: 30,
            calendarMirror: "written" as const,
            blockMirror: "mismatch-preserved" as const
          }
        }))
      );
    };
    const reserve = vi.fn(async () => batch);
    const app = buildApp({
      dayPlanRepository: fakeRepository({ reserveApplyBatch: reserve as never }),
      applyExecution: executor
    });
    const applied = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
      payload: { expectedRevision: 3, idempotencyKey: "k1" }
    });
    expect(applied.statusCode).toBe(200);
    const body = applied.json() as ApplyExecutionReport;
    expect(body.operationId).toBe(OPERATION_ID);
    expect(body.items.map((item) => item.itemId).sort()).toEqual([ITEM_A, ITEM_B].sort());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ planId: PLAN_ID, idempotencyKey: "k1" });
    expect(calls[0]!.itemIds).toBeUndefined();

    const missing = buildApp({
      dayPlanRepository: fakeRepository({
        reserveApplyBatch: (async () => {
          throw new HttpError(404, "day plan is not available");
        }) as never
      }),
      applyExecution: async () => {
        throw new Error("execution must not run");
      }
    });
    const absent = await missing.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
      payload: { expectedRevision: 3, idempotencyKey: "k1" }
    });
    expect(absent.statusCode).toBe(404);

    const conflicted = buildApp({
      dayPlanRepository: fakeRepository({
        reserveApplyBatch: (async () => {
          throw new HttpError(409, "day plan changed since it was read");
        }) as never
      }),
      applyExecution: async () => {
        throw new Error("execution must not run");
      }
    });
    const conflict = await conflicted.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
      payload: { expectedRevision: 3, idempotencyKey: "k1" }
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("fails closed with 503 before reservation when execution is unavailable", async () => {
    const reserve = vi.fn();
    const lookup = vi.fn();
    const app = buildApp({
      dayPlanRepository: fakeRepository({
        reserveApplyBatch: reserve as never,
        getApplyBatchById: lookup as never
      })
    });
    const applied = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
      payload: { expectedRevision: 3, idempotencyKey: "k1" }
    });
    expect(applied.statusCode).toBe(503);
    const retried = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/retry`,
      payload: { itemIds: [ITEM_A] }
    });
    expect(retried.statusCode).toBe(503);
    expect(reserve).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();

    // Status is database-only and needs no execution runtime.
    const statusApp = buildApp({
      dayPlanRepository: fakeRepository({
        getApplyBatchById: (async () => batchFixture([itemFixture(ITEM_A, "applied")])) as never
      })
    });
    const status = await statusApp.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}`
    });
    expect(status.statusCode).toBe(200);
  });

  it("synthesizes pending and completed status from stored items", async () => {
    const lookup = vi.fn(async () =>
      batchFixture([itemFixture(ITEM_A, "pending"), itemFixture(ITEM_B, "unknown")])
    );
    const app = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: lookup as never })
    });
    const pending = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}`
    });
    expect(pending.statusCode).toBe(200);
    const pendingBody = pending.json() as { status: string; items: unknown[] };
    expect(pendingBody.status).toBe("pending");
    expect(pendingBody.items).toHaveLength(2);

    const doneApp = buildApp({
      dayPlanRepository: fakeRepository({
        getApplyBatchById: (async () =>
          batchFixture([itemFixture(ITEM_A, "applied"), itemFixture(ITEM_B, "failed")])) as never
      })
    });
    const done = await doneApp.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}`
    });
    expect((done.json() as { status: string }).status).toBe("completed");

    const missingApp = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: async () => undefined })
    });
    const missing = await missingApp.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}`
    });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/not-a-uuid`
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("rejects malformed retry bodies with 400", async () => {
    const lookup = vi.fn();
    const app = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: lookup as never })
    });
    for (const payload of [
      { itemIds: [] },
      { itemIds: [ITEM_A, ITEM_A] },
      { itemIds: ["nope"] },
      { itemIds: "nope" },
      { extra: true }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/retry`,
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("validates retry selection atomically before provider work", async () => {
    const batch = batchFixture([
      itemFixture(ITEM_A, "failed"),
      { ...itemFixture(ITEM_B, "applied"), blockId: BLOCK_B }
    ]);
    const calls: ApplyExecutionInput[] = [];
    const executor = async (input: ApplyExecutionInput): Promise<ApplyExecutionReport> => {
      calls.push(input);
      return appliedReport(
        batch.items.map((item) => ({
          itemId: item.id,
          blockId: item.blockId,
          outcome: item.outcome,
          result: null
        }))
      );
    };
    const lookup = vi.fn(async () => batch);
    const app = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: lookup as never }),
      applyExecution: executor
    });
    const retried = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/retry`,
      payload: { itemIds: [ITEM_A] }
    });
    expect(retried.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.itemIds).toEqual([ITEM_A]);

    // Applied, missing, and cross-operation selections reject as one 409.
    for (const payload of [{ itemIds: [ITEM_B] }, { itemIds: [ITEM_A, BLOCK_A] }]) {
      const rejected = await app.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/retry`,
        payload
      });
      expect(rejected.statusCode).toBe(409);
    }
    expect(calls).toHaveLength(1);

    const missingApp = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: async () => undefined }),
      applyExecution: async () => {
        throw new Error("execution must not run");
      }
    });
    const missing = await missingApp.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/retry`,
      payload: { itemIds: [ITEM_A] }
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("day plan apply recover route", () => {
  it("authenticates before validating the recover body", async () => {
    const execute = vi.fn();
    const app = buildApp({
      resolveAccessContext: async () => {
        throw new Error("Session is missing or expired");
      },
      dayPlanRepository: fakeRepository(),
      applyExecution: execute
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/recover`,
      payload: { nonsense: true }
    });
    expect(response.statusCode).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects recover bodies with any field", async () => {
    const lookup = vi.fn(async () => batchFixture([itemFixture(ITEM_A, "pending")]));
    const execute = vi.fn(async () => appliedReport([]));
    const app = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: lookup as never }),
      applyExecution: execute
    });
    for (const payload of [{ itemIds: [ITEM_A] }, { extra: true }]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/recover`,
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("recovers by operation id and passes no selection", async () => {
    const batch = batchFixture([itemFixture(ITEM_A, "pending"), itemFixture(ITEM_B, "unknown")]);
    const calls: ApplyExecutionInput[] = [];
    const executor = async (input: ApplyExecutionInput): Promise<ApplyExecutionReport> => {
      calls.push(input);
      return appliedReport(
        batch.items.map((item) => ({
          itemId: item.id,
          blockId: item.blockId,
          outcome: "applied" as const,
          result: null
        }))
      );
    };
    const lookup = vi.fn(async () => batch);
    const app = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: lookup as never }),
      applyExecution: executor
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/recover`,
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ planId: PLAN_ID, operationId: OPERATION_ID });
    expect(calls[0]!.itemIds).toBeUndefined();

    const missingApp = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: async () => undefined }),
      applyExecution: async () => {
        throw new Error("execution must not run");
      }
    });
    const missing = await missingApp.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/recover`,
      payload: {}
    });
    expect(missing.statusCode).toBe(404);
  });

  it("fails closed with 503 before any item read when execution is down", async () => {
    const lookup = vi.fn();
    const app = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: lookup as never })
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/recover`,
      payload: {}
    });
    expect(response.statusCode).toBe(503);
    expect(lookup).not.toHaveBeenCalled();
  });
});
