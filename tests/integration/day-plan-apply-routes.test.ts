import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  AuthSessionResolver,
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import type { ApplyExecutionInput } from "@moss/calendar";
import {
  DAY_PLAN_DENIED_CODE,
  DAY_PLAN_DENIED_REMEDIATION_REF,
  type ApplyExecutionReport
} from "@moss/shared";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { registerDayPlanRoutes } from "../../packages/calendar/src/day-plan-routes.js";
import { DayPlanRepository } from "@moss/calendar";

const TIME_ZONE = "America/Los_Angeles";
const ADD_A_START = "2026-09-12T16:00:00.000Z";
const ADD_B_START = "2026-09-12T17:30:00.000Z";

function userA(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:apply-route-int-a" };
}

function userB(): AccessContext {
  return { actorUserId: ids.userB, requestId: "request:apply-route-int-b" };
}

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let repository: DayPlanRepository;
let daySeq = 200;

function nextDay(): string {
  daySeq += 1;
  return new Date(Date.UTC(2026, 10, daySeq)).toISOString().slice(0, 10);
}

// The executor must observe the committed reservation through its own fresh
// transaction, proving the route closed its short reservation stage before
// any execution work. It then settles every runnable item at once.
function closingExecutor(calls: ApplyExecutionInput[], finish: { outcome: "applied" | "failed" }) {
  return async (input: ApplyExecutionInput): Promise<ApplyExecutionReport> => {
    calls.push(input);
    const batch = await dataContext.withDataContext(input.access, (scopedDb) =>
      repository.getApplyBatch(scopedDb, {
        planId: input.planId,
        idempotencyKey: input.idempotencyKey
      })
    );
    if (!batch) throw new Error("reservation must be committed before execution");
    const selected = input.itemIds === undefined ? undefined : new Set(input.itemIds);
    const items: ApplyExecutionReport["items"] = [];
    for (const item of batch.items) {
      const runnable =
        selected !== undefined
          ? selected.has(item.id)
          : item.outcome === "pending" || item.outcome === "unknown";
      if (!runnable) {
        items.push({
          itemId: item.id,
          blockId: item.blockId,
          outcome: item.outcome,
          result: item.result
        });
        continue;
      }
      const result =
        finish.outcome === "applied"
          ? {
              status: "applied" as const,
              providerEventId: `evt-${item.id}`,
              startsAt: ADD_A_START,
              durationMinutes: 30,
              calendarMirror: "written" as const,
              blockMirror: "mismatch-preserved" as const
            }
          : { status: "failed" as const, reason: "conflict" as const };
      await dataContext.withDataContext(input.access, (scopedDb) =>
        repository.recordItemResult(scopedDb, {
          itemId: item.id,
          operationId: batch.id,
          outcome: finish.outcome,
          result,
          expectedOutcomes: ["pending", "failed", "unknown"]
        })
      );
      items.push({ itemId: item.id, blockId: item.blockId, outcome: finish.outcome, result });
    }
    return { operationId: batch.id, planId: batch.planId, status: "completed", items };
  };
}

function buildApp(
  actor: AccessContext,
  executor?: (input: ApplyExecutionInput) => Promise<ApplyExecutionReport>
) {
  const app = Fastify();
  registerDayPlanRoutes(app, {
    resolveAccessContext: async () => actor,
    resolveTimeZone: async () => TIME_ZONE,
    dayPlanRepository: repository,
    findSourceRun: async () => undefined,
    findTask: async () => undefined,
    findRun: async () => undefined,
    dataContext,
    ...(executor ? { applyExecution: executor } : {})
  });
  return app;
}

async function seedPlan(actor: AccessContext, localDay: string) {
  const created = await dataContext.withDataContext(actor, (scopedDb) =>
    repository.createForDay(scopedDb, { localDay, timeZone: TIME_ZONE })
  );
  return dataContext.withDataContext(actor, (scopedDb) =>
    repository.saveDraft(scopedDb, {
      planId: created.id,
      localDay,
      timeZone: TIME_ZONE,
      expectedRevision: created.revision,
      blocks: [
        {
          taskId: null,
          kind: "focus",
          title: "Morning write-up",
          pendingChange: { kind: "add", startsAt: ADD_A_START, durationMinutes: 30 }
        },
        {
          taskId: null,
          kind: "focus",
          title: "Sync",
          pendingChange: { kind: "add", startsAt: ADD_B_START, durationMinutes: 30 }
        }
      ]
    })
  );
}

describe("day plan apply routes boundary", () => {
  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    repository = new DayPlanRepository({ findTask: async () => undefined });
  });

  afterAll(async () => {
    await Promise.allSettled([appDb?.destroy()]);
  });

  beforeEach(async () => {
    await resetFoundationDatabase();
  });

  it("applies, replays identically, and moves status from pending to completed", async () => {
    const calls: ApplyExecutionInput[] = [];
    const app = buildApp(userA(), closingExecutor(calls, { outcome: "applied" }));
    const plan = await seedPlan(userA(), nextDay());
    const first = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/apply`,
      payload: { expectedRevision: plan.revision, idempotencyKey: "route-k1" }
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as ApplyExecutionReport;
    expect(firstBody.items).toHaveLength(2);

    const statusAfterApply = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${plan.id}/operations/${firstBody.operationId}`
    });
    expect((statusAfterApply.json() as { status: string }).status).toBe("completed");

    const second = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/apply`,
      payload: { expectedRevision: plan.revision, idempotencyKey: "route-k1" }
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as ApplyExecutionReport).operationId).toBe(firstBody.operationId);

    const conflict = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/apply`,
      payload: {
        expectedRevision: plan.revision,
        idempotencyKey: "route-k1",
        operationKey: "other"
      }
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("reports completed once every item is failed", async () => {
    const calls: ApplyExecutionInput[] = [];
    const app = buildApp(userA(), closingExecutor(calls, { outcome: "failed" }));
    const plan = await seedPlan(userA(), nextDay());
    const first = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/apply`,
      payload: { expectedRevision: plan.revision, idempotencyKey: "route-k2" }
    });
    const operationId = (first.json() as { operationId: string }).operationId;
    const status = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${plan.id}/operations/${operationId}`
    });
    expect((status.json() as { status: string }).status).toBe("completed");
    expect(
      (status.json() as { items: { outcome: string }[] }).items.every(
        (item) => item.outcome === "failed"
      )
    ).toBe(true);
  });

  it("isolates actors across apply, status, and retry", async () => {
    const app = buildApp(userA(), closingExecutor([], { outcome: "applied" }));
    const plan = await seedPlan(userA(), nextDay());
    const applied = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/apply`,
      payload: { expectedRevision: plan.revision, idempotencyKey: "route-k3" }
    });
    const operationId = (applied.json() as { operationId: string }).operationId;
    const batch = await dataContext.withDataContext(userA(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: "route-k3" })
    );

    const other = buildApp(userB(), closingExecutor([], { outcome: "applied" }));
    for (const request of [
      { method: "GET", url: `/api/calendar/day-plans/${plan.id}/operations/${operationId}` },
      {
        method: "POST",
        url: `/api/calendar/day-plans/${plan.id}/operations/${operationId}/retry`,
        payload: { itemIds: [batch!.items[0]!.id] }
      }
    ] as const) {
      const response = await other.inject(request);
      expect(response.statusCode).toBe(404);
    }
    // The other actor cannot even reserve against the plan.
    const foreignApply = await other.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/apply`,
      payload: { expectedRevision: plan.revision, idempotencyKey: "route-k3-b" }
    });
    expect(foreignApply.statusCode).toBe(404);
  });

  it("leaves no mutation behind when execution is unavailable", async () => {
    const app = buildApp(userA());
    const plan = await seedPlan(userA(), nextDay());
    const applied = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/apply`,
      payload: { expectedRevision: plan.revision, idempotencyKey: "route-k4" }
    });
    expect(applied.statusCode).toBe(503);
    const stored = await dataContext.withDataContext(userA(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: "route-k4" })
    );
    expect(stored).toBeUndefined();
  });

  it("retries one failed item and rejects retrying applied or pending items", async () => {
    const calls: ApplyExecutionInput[] = [];
    const finish: { outcome: "applied" | "failed" } = { outcome: "failed" };
    const app = buildApp(userA(), closingExecutor(calls, finish));
    const plan = await seedPlan(userA(), nextDay());
    const applied = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/apply`,
      payload: { expectedRevision: plan.revision, idempotencyKey: "route-k5" }
    });
    const operationId = (applied.json() as { operationId: string }).operationId;
    const batch = await dataContext.withDataContext(userA(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: "route-k5" })
    );
    const [first, second] = batch!.items;
    finish.outcome = "applied";

    const retried = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${operationId}/retry`,
      payload: { itemIds: [first!.id] }
    });
    expect(retried.statusCode).toBe(200);
    const retryBody = retried.json() as ApplyExecutionReport;
    expect(retryBody.items.find((item) => item.itemId === first!.id)?.outcome).toBe("applied");
    expect(retryBody.items.find((item) => item.itemId === second!.id)?.outcome).toBe("failed");

    const status = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${plan.id}/operations/${operationId}`
    });
    expect((status.json() as { status: string }).status).toBe("completed");

    for (const itemIds of [[first!.id], [second!.id, "00000000-0000-4000-8000-000000009999"]]) {
      const rejected = await app.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${plan.id}/operations/${operationId}/retry`,
        payload: { itemIds }
      });
      expect(rejected.statusCode).toBe(409);
    }
    expect(calls.filter((call) => call.itemIds !== undefined)).toHaveLength(1);
  });

  it("rejects retrying a pending item with 409 and no provider change", async () => {
    const calls: ApplyExecutionInput[] = [];
    const plan = await seedPlan(userA(), nextDay());
    // Leave items pending by short-circuiting the executor on first call.
    const holdApp = buildApp(userA(), async (input) => {
      calls.push(input);
      const batch = await dataContext.withDataContext(input.access, (scopedDb) =>
        repository.getApplyBatch(scopedDb, {
          planId: input.planId,
          idempotencyKey: input.idempotencyKey
        })
      );
      return {
        operationId: batch!.id,
        planId: batch!.planId,
        status: "completed",
        items: batch!.items.map((item) => ({
          itemId: item.id,
          blockId: item.blockId,
          outcome: item.outcome,
          result: item.result
        }))
      };
    });
    const applied = await holdApp.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/apply`,
      payload: { expectedRevision: plan.revision, idempotencyKey: "route-k6" }
    });
    const operationId = (applied.json() as { operationId: string }).operationId;
    const batch = await dataContext.withDataContext(userA(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: "route-k6" })
    );
    const app = buildApp(userA(), closingExecutor(calls, { outcome: "applied" }));
    const pending = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${plan.id}/operations/${operationId}`
    });
    expect((pending.json() as { status: string }).status).toBe("pending");

    const rejected = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${operationId}/retry`,
      payload: { itemIds: [batch!.items[0]!.id] }
    });
    expect(rejected.statusCode).toBe(409);
    expect(calls.filter((call) => call.itemIds !== undefined)).toHaveLength(0);
  });

  it("carries the declared denial on a writeback-off denial and omits it when applied", async () => {
    // T07: the app map declares day_plan_denied, so the 200 status body must
    // carry it whenever a stored item failed with access-denied.
    const denying = async (input: ApplyExecutionInput): Promise<ApplyExecutionReport> => {
      const batch = await dataContext.withDataContext(input.access, (scopedDb) =>
        repository.getApplyBatch(scopedDb, {
          planId: input.planId,
          idempotencyKey: input.idempotencyKey
        })
      );
      for (const item of batch!.items) {
        await dataContext.withDataContext(input.access, (scopedDb) =>
          repository.recordItemResult(scopedDb, {
            itemId: item.id,
            operationId: batch!.id,
            outcome: "failed",
            result: { status: "failed", reason: "access-denied" }
          })
        );
      }
      const stored = await dataContext.withDataContext(input.access, (scopedDb) =>
        repository.getApplyBatch(scopedDb, {
          planId: input.planId,
          idempotencyKey: input.idempotencyKey
        })
      );
      return {
        operationId: stored!.id,
        planId: stored!.planId,
        status: "completed",
        items: stored!.items.map((item) => ({
          itemId: item.id,
          blockId: item.blockId,
          outcome: item.outcome,
          result: item.result
        }))
      };
    };
    const deniedApp = buildApp(userA(), denying);
    const deniedPlan = await seedPlan(userA(), nextDay());
    const denied = await deniedApp.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${deniedPlan.id}/apply`,
      payload: { expectedRevision: deniedPlan.revision, idempotencyKey: "route-deny-1" }
    });
    const deniedOperationId = (denied.json() as { operationId: string }).operationId;
    const deniedStatus = await deniedApp.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${deniedPlan.id}/operations/${deniedOperationId}`
    });
    expect(deniedStatus.statusCode).toBe(200);
    const deniedBody = deniedStatus.json() as {
      status: string;
      items: { outcome: string; result: { reason?: string } | null }[];
      denial?: { code: string; remediationRef: string };
    };
    expect(deniedBody.status).toBe("completed");
    expect(deniedBody.items.every((item) => item.outcome === "failed")).toBe(true);
    expect(deniedBody.denial?.code).toBe(DAY_PLAN_DENIED_CODE);
    expect(deniedBody.denial?.remediationRef).toBe(DAY_PLAN_DENIED_REMEDIATION_REF);

    const appliedApp = buildApp(userA(), closingExecutor([], { outcome: "applied" }));
    const appliedPlan = await seedPlan(userA(), nextDay());
    const applied = await appliedApp.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${appliedPlan.id}/apply`,
      payload: { expectedRevision: appliedPlan.revision, idempotencyKey: "route-deny-2" }
    });
    const appliedOperationId = (applied.json() as { operationId: string }).operationId;
    const appliedStatus = await appliedApp.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${appliedPlan.id}/operations/${appliedOperationId}`
    });
    expect((appliedStatus.json() as { denial?: unknown }).denial).toBeUndefined();
  });
});
