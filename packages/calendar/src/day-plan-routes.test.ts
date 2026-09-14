import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb } from "@moss/db";
import type { ApplyExecutionInput } from "@moss/calendar";
import {
  DAY_PLAN_DENIED_CODE,
  DAY_PLAN_DENIED_REMEDIATION_REF,
  type ApplyConfirmationRequiredResponse,
  type ApplyExecutionReport,
  type DayPlanApplyBatchDto
} from "@moss/shared";
import { HttpError } from "@moss/module-sdk";

import {
  buildChangeBinding,
  changeApprovalSummary,
  type DayPlanChangeApprovalPort
} from "./day-plan-change-approval.js";
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

    const deniedApp = buildApp({
      dayPlanRepository: fakeRepository({
        getApplyBatchById: (async () =>
          batchFixture([
            {
              ...itemFixture(ITEM_A, "failed"),
              result: { status: "failed", reason: "access-denied" }
            },
            itemFixture(ITEM_B, "applied")
          ])) as never
      })
    });
    const denied = await deniedApp.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}`
    });
    expect(denied.statusCode).toBe(200);
    const deniedBody = denied.json() as {
      status: string;
      denial?: { code: string; remediationRef: string };
    };
    expect(deniedBody.status).toBe("completed");
    expect(deniedBody.denial?.code).toBe(DAY_PLAN_DENIED_CODE);
    expect(deniedBody.denial?.remediationRef).toBe(DAY_PLAN_DENIED_REMEDIATION_REF);

    const cleanApp = buildApp({
      dayPlanRepository: fakeRepository({
        getApplyBatchById: (async () =>
          batchFixture([itemFixture(ITEM_A, "applied"), itemFixture(ITEM_B, "failed")])) as never
      })
    });
    const clean = await cleanApp.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}`
    });
    expect((clean.json() as { denial?: unknown }).denial).toBeUndefined();

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

const APPROVAL_ID = "00000000-0000-4000-8000-0000000000e5";

function moveItemFixture(
  id: string,
  outcome: "pending" | "applied" | "failed" | "unknown",
  blockId: string | null = BLOCK_A
): DayPlanApplyBatchDto["items"][number] {
  return {
    id,
    blockId,
    kind: "move",
    pendingChange: {
      blockId: blockId ?? BLOCK_A,
      kind: "move",
      startsAt: "2026-09-12T18:00:00.000Z",
      durationMinutes: 30
    },
    outcome,
    result: null
  };
}

function planWithPlacementFixture(): Record<string, unknown> {
  return {
    id: PLAN_ID,
    revision: 3,
    blocks: [
      {
        id: BLOCK_A,
        taskId: null,
        title: "Move me",
        actualPlacement: {
          startsAt: "2026-09-12T16:00:00.000Z",
          durationMinutes: 30,
          calendarEventRef: "evt-1"
        },
        pendingChange: {
          kind: "move",
          startsAt: "2026-09-12T18:00:00.000Z",
          durationMinutes: 30
        }
      }
    ]
  };
}

function fakeApproval(impl: Partial<DayPlanChangeApprovalPort> = {}): DayPlanChangeApprovalPort {
  const unused = async (): Promise<never> => {
    throw new Error("approval method must not run");
  };
  return {
    createPendingApproval: unused,
    getApproval: async () => undefined,
    confirmApproval: async () => undefined,
    findPendingApprovalForOperation: async () => undefined,
    findConfirmedApprovalForOperation: async () => undefined,
    listActionPolicies: async () => [],
    ...impl
  };
}

describe("day plan apply change gate", () => {
  it("answers 202 with one bound approval for a mixed batch, replaying the same id", async () => {
    const batch = batchFixture([moveItemFixture(ITEM_A, "pending")]);
    const calls: ApplyExecutionInput[] = [];
    const created: { id: string; inputSummary: Record<string, unknown> }[] = [];
    const approval = fakeApproval({
      findPendingApprovalForOperation: (async () => {
        const row = created.find((entry) => entry.id === APPROVAL_ID);
        return row
          ? {
              id: row.id,
              ownerUserId: ACTOR,
              status: "pending" as const,
              inputSummary: row.inputSummary
            }
          : undefined;
      }) as never,
      createPendingApproval: (async (
        _db: unknown,
        input: { inputSummary: Record<string, unknown> }
      ) => {
        created.push({ id: APPROVAL_ID, inputSummary: input.inputSummary });
        return {
          id: APPROVAL_ID,
          ownerUserId: ACTOR,
          status: "pending" as const,
          inputSummary: input.inputSummary
        };
      }) as never
    });
    const app = buildApp({
      dayPlanRepository: fakeRepository({
        reserveApplyBatch: (async () => batch) as never,
        getById: (async () => planWithPlacementFixture()) as never
      }),
      applyExecution: (async (input: ApplyExecutionInput) => {
        calls.push(input);
        return appliedReport([]);
      }) as never,
      changeApproval: approval
    });
    const first = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
      payload: { expectedRevision: 3, idempotencyKey: "k1" }
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as ApplyConfirmationRequiredResponse;
    expect(firstBody.status).toBe("confirmation-required");
    expect(firstBody.operationId).toBe(OPERATION_ID);
    expect(firstBody.approvalId).toBe(APPROVAL_ID);
    expect(firstBody.changes).toEqual([
      {
        blockId: BLOCK_A,
        kind: "move",
        calendarEventRef: "evt-1",
        startsAt: "2026-09-12T18:00:00.000Z",
        durationMinutes: 30
      }
    ]);
    expect(calls).toHaveLength(0);

    const second = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
      payload: { expectedRevision: 3, idempotencyKey: "k1" }
    });
    expect(second.statusCode).toBe(202);
    expect((second.json() as ApplyConfirmationRequiredResponse).approvalId).toBe(APPROVAL_ID);
    expect(created).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("executes a mixed batch straight from apply on trusted_auto", async () => {
    const batch = batchFixture([moveItemFixture(ITEM_A, "pending")]);
    const calls: ApplyExecutionInput[] = [];
    const app = buildApp({
      dayPlanRepository: fakeRepository({
        reserveApplyBatch: (async () => batch) as never,
        getById: (async () => planWithPlacementFixture()) as never
      }),
      applyExecution: (async (input: ApplyExecutionInput) => {
        calls.push(input);
        return appliedReport([]);
      }) as never,
      changeApproval: fakeApproval({
        listActionPolicies: (async () => [
          { moduleId: "calendar", actionFamilyId: "calendar_management", tier: "trusted_auto" }
        ]) as never
      })
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
      payload: { expectedRevision: 3, idempotencyKey: "k1" }
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.changeAuth).toEqual({ tier: "trusted_auto", approval: null });
  });

  it("fails closed with 503 when a gated batch has no approval store", async () => {
    const batch = batchFixture([moveItemFixture(ITEM_A, "pending")]);
    const execute = vi.fn();
    const app = buildApp({
      dayPlanRepository: fakeRepository({ reserveApplyBatch: (async () => batch) as never }),
      applyExecution: execute
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/apply`,
      payload: { expectedRevision: 3, idempotencyKey: "k1" }
    });
    expect(response.statusCode).toBe(503);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("day plan apply confirm route", () => {
  function confirmBatch() {
    return batchFixture([moveItemFixture(ITEM_A, "pending")]);
  }

  function confirmApp(
    approval: DayPlanChangeApprovalPort,
    executor: (input: ApplyExecutionInput) => Promise<ApplyExecutionReport>
  ) {
    return buildApp({
      dayPlanRepository: fakeRepository({
        getApplyBatchById: (async () => confirmBatch()) as never,
        getById: (async () => planWithPlacementFixture()) as never
      }),
      applyExecution: executor as never,
      changeApproval: approval
    });
  }

  function storedBinding() {
    return buildChangeBinding({
      actorUserId: ACTOR,
      batch: confirmBatch(),
      plan: planWithPlacementFixture() as never
    });
  }

  it("rejects malformed confirm bodies with 400", async () => {
    const execute = vi.fn();
    const app = confirmApp(fakeApproval(), execute);
    for (const payload of [{ approvalId: 7 }, { extra: true }, {}]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/confirm`,
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes on the exact pending binding and resolves it first", async () => {
    const binding = storedBinding();
    const seen: string[] = [];
    const calls: ApplyExecutionInput[] = [];
    const approval = fakeApproval({
      getApproval: (async () => ({
        id: APPROVAL_ID,
        ownerUserId: ACTOR,
        status: "pending" as const,
        inputSummary: changeApprovalSummary(binding)
      })) as never,
      confirmApproval: (async (_db: unknown, approvalId: string) => {
        seen.push(approvalId);
        return {
          id: approvalId,
          ownerUserId: ACTOR,
          status: "confirmed" as const,
          inputSummary: {}
        };
      }) as never
    });
    const app = confirmApp(approval, async (input: ApplyExecutionInput) => {
      calls.push(input);
      return appliedReport([]);
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/confirm`,
      payload: { approvalId: APPROVAL_ID }
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([APPROVAL_ID]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.operationId).toBe(OPERATION_ID);
    expect(calls[0]!.changeAuth).toEqual({ tier: "always_confirm", approval: binding });
  });

  it("stops missing, resolved and mismatched approvals at 409 with no execution", async () => {
    const binding = storedBinding();
    const execute = vi.fn();
    const mismatched = { ...binding, planRevision: 9 };
    const cases: { name: string; approval: DayPlanChangeApprovalPort }[] = [
      { name: "missing", approval: fakeApproval() },
      {
        name: "resolved",
        approval: fakeApproval({
          getApproval: (async () => ({
            id: APPROVAL_ID,
            ownerUserId: ACTOR,
            status: "confirmed" as const,
            inputSummary: changeApprovalSummary(binding)
          })) as never
        })
      },
      {
        name: "rejected",
        approval: fakeApproval({
          getApproval: (async () => ({
            id: APPROVAL_ID,
            ownerUserId: ACTOR,
            status: "rejected" as const,
            inputSummary: changeApprovalSummary(binding)
          })) as never
        })
      },
      {
        name: "wrong operation",
        approval: fakeApproval({
          getApproval: (async () => ({
            id: APPROVAL_ID,
            ownerUserId: ACTOR,
            status: "pending" as const,
            inputSummary: changeApprovalSummary(mismatched)
          })) as never
        })
      },
      {
        name: "foreign row",
        approval: fakeApproval({
          getApproval: (async () => ({
            id: APPROVAL_ID,
            ownerUserId: ACTOR,
            status: "pending" as const,
            inputSummary: { tool: "gateway.somethingElse" }
          })) as never
        })
      }
    ];
    for (const entry of cases) {
      const app = confirmApp(entry.approval, execute);
      const response = await app.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/confirm`,
        payload: { approvalId: APPROVAL_ID }
      });
      expect(response.statusCode, entry.name).toBe(409);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("reads foreign operations as 404 and fails closed with 503", async () => {
    const missing = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: async () => undefined }),
      applyExecution: (async () => appliedReport([])) as never,
      changeApproval: fakeApproval()
    });
    const notFound = await missing.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/confirm`,
      payload: { approvalId: APPROVAL_ID }
    });
    expect(notFound.statusCode).toBe(404);

    const lookup = vi.fn();
    const down = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: lookup as never })
    });
    const unavailable = await down.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/confirm`,
      payload: { approvalId: APPROVAL_ID }
    });
    expect(unavailable.statusCode).toBe(503);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("day plan apply retry over changes", () => {
  it("accepts failed and unknown moves and passes the confirmed binding through", async () => {
    const batch = batchFixture([moveItemFixture(ITEM_A, "failed")]);
    const calls: ApplyExecutionInput[] = [];
    const binding = buildChangeBinding({
      actorUserId: ACTOR,
      batch,
      plan: planWithPlacementFixture() as never
    });
    const app = buildApp({
      dayPlanRepository: fakeRepository({ getApplyBatchById: (async () => batch) as never }),
      applyExecution: (async (input: ApplyExecutionInput) => {
        calls.push(input);
        return appliedReport([]);
      }) as never,
      changeApproval: fakeApproval({
        findConfirmedApprovalForOperation: (async () => ({
          id: APPROVAL_ID,
          ownerUserId: ACTOR,
          status: "confirmed" as const,
          inputSummary: changeApprovalSummary(binding)
        })) as never
      })
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${PLAN_ID}/operations/${OPERATION_ID}/retry`,
      payload: { itemIds: [ITEM_A] }
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.itemIds).toEqual([ITEM_A]);
    expect(calls[0]!.changeAuth).toEqual({ tier: "always_confirm", approval: binding });
  });
});
