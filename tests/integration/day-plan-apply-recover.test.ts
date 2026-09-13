import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import type { ToolContext } from "@moss/module-sdk";
import {
  AuthSessionResolver,
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import {
  ApplyExecutionService,
  applyAdditionEventId,
  type ApplyExecutionDeps,
  type ApplyExecutionInput,
  type ApplyWriterPort,
  type ProposeFocusResult
} from "@moss/calendar";
import { DayPlanRepository } from "@moss/calendar";
import { TasksRepository } from "@moss/tasks";
import type { ApplyEventProvenance, ApplyExecutionReport } from "@moss/shared";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { registerDayPlanRoutes } from "../../packages/calendar/src/day-plan-routes.js";

const TIME_ZONE = "America/Los_Angeles";
const ADD_A_START = "2026-09-12T16:00:00.000Z";
const ADD_B_START = "2026-09-12T17:30:00.000Z";

function userA(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:recover-a" };
}

function userB(): AccessContext {
  return { actorUserId: ids.userB, requestId: "request:recover-b" };
}

function toolCtx(): ToolContext {
  return { actorUserId: ids.userA, requestId: "request:recover-tool", chatSessionId: "session-1" };
}

function provenanceProps(provenance: ApplyEventProvenance): Record<string, string> {
  return {
    jarvisTool: "applyAddition",
    jarvisActorUserId: provenance.actorUserId,
    jarvisPlanId: provenance.planId,
    jarvisBlockId: provenance.blockId,
    jarvisPlanRevision: String(provenance.planRevision),
    jarvisOperationId: provenance.operationId
  };
}

interface WriterScript {
  create?: (provenance: ApplyEventProvenance) => ProposeFocusResult;
  lookup?: (eventId: string) => { found: boolean; provenance?: Record<string, string> };
}

function makeWriter(script: WriterScript = {}): ApplyWriterPort & {
  creates: ApplyEventProvenance[];
  lookups: string[];
} {
  const creates: ApplyEventProvenance[] = [];
  const lookups: string[] = [];
  const eventIdOf = (provenance: ApplyEventProvenance) =>
    applyAdditionEventId({
      actorUserId: provenance.actorUserId,
      planId: provenance.planId,
      blockId: provenance.blockId,
      planRevision: provenance.planRevision,
      operationId: provenance.operationId
    });
  return {
    creates,
    lookups,
    async createAddition(input) {
      creates.push(input.provenance);
      if (script.create) return script.create(input.provenance);
      return {
        created: true,
        resolvedStart: input.window.start.toISOString(),
        resolvedEnd: input.window.end.toISOString(),
        shifted: false,
        conflict: "none",
        googleEventId: eventIdOf(input.provenance),
        calendarMirror: "written"
      };
    },
    async lookupAddition(input) {
      lookups.push(input.eventId);
      if (script.lookup) {
        const scripted = script.lookup(input.eventId);
        if (!scripted.found) return { found: false };
        const created = creates.find((provenance) => eventIdOf(provenance) === input.eventId);
        return {
          found: true,
          id: input.eventId,
          summary: "Planned block",
          start: ADD_A_START,
          end: "2026-09-12T16:30:00.000Z",
          provenance: scripted.provenance ?? (created ? provenanceProps(created) : {})
        };
      }
      const created = creates.find((provenance) => eventIdOf(provenance) === input.eventId);
      if (!created) return { found: false };
      return {
        found: true,
        id: input.eventId,
        summary: "Planned block",
        start: ADD_A_START,
        end: "2026-09-12T16:30:00.000Z",
        provenance: provenanceProps(created)
      };
    }
  };
}

describe("day plan apply recover boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: DayPlanRepository;
  let tasks: TasksRepository;
  let taskId: string;
  let daySeq = 300;

  function nextDay(): string {
    daySeq += 1;
    return new Date(Date.UTC(2026, 8, 21 + daySeq)).toISOString().slice(0, 10);
  }

  function baseDeps(overrides: Partial<ApplyExecutionDeps> = {}): ApplyExecutionDeps {
    return {
      dataContext,
      batches: repository,
      findTask: async (scopedDb, id) => {
        const row = await tasks.getById(scopedDb, id);
        return row ? { id: row.id, ownerUserId: row.owner_user_id, status: row.status } : undefined;
      },
      accessGate: { checkAccess: async () => ({ ok: true }) },
      facts: { readAvailability: async () => ({ intervals: [], complete: true }) },
      writer: makeWriter(),
      ...overrides
    };
  }

  async function seedReservedBatch(localDay: string) {
    const created = await dataContext.withDataContext(userA(), (scopedDb) =>
      repository.createForDay(scopedDb, { localDay, timeZone: TIME_ZONE })
    );
    const saved = await dataContext.withDataContext(userA(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: created.id,
        localDay,
        timeZone: TIME_ZONE,
        expectedRevision: created.revision,
        blocks: [
          {
            taskId,
            kind: "focus",
            title: "Morning write-up",
            pendingChange: { kind: "add", startsAt: ADD_A_START, durationMinutes: 30 }
          },
          {
            taskId,
            kind: "focus",
            title: "Sync",
            pendingChange: { kind: "add", startsAt: ADD_B_START, durationMinutes: 30 }
          }
        ]
      })
    );
    const batch = await dataContext.withDataContext(userA(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: saved.id,
        expectedRevision: saved.revision,
        idempotencyKey: `recover-${randomUUID()}`
      })
    );
    return { plan: saved, batch };
  }

  function recoverInput(planId: string, idempotencyKey: string, operationId: string) {
    return { access: userA(), toolCtx: toolCtx(), planId, idempotencyKey, operationId };
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    void new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    tasks = new TasksRepository();
    repository = new DayPlanRepository({
      findTask: async (scopedDb, id) => {
        const row = await tasks.getById(scopedDb, id);
        return row ? { id: row.id, ownerUserId: row.owner_user_id } : undefined;
      }
    });
  });

  afterAll(async () => {
    await Promise.allSettled([appDb?.destroy()]);
  });

  beforeEach(async () => {
    await resetFoundationDatabase();
    taskId = await dataContext
      .withDataContext(userA(), (scopedDb: DataContextDb) =>
        tasks.create(scopedDb, {
          title: "Recover fixture task",
          dueAt: "2026-09-14T18:00:00.000Z",
          doAt: "2026-09-12T16:00:00.000Z"
        })
      )
      .then((task) => task.id);
  });

  it("recovers a reserved-never-dispatched operation with one create per item", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const writer = makeWriter();
    const report = await new ApplyExecutionService(baseDeps({ writer })).executeReservedAdditions(
      recoverInput(plan.id, batch.idempotencyKey, batch.id)
    );
    expect(report.status).toBe("completed");
    expect(report.operationId).toBe(batch.id);
    expect(report.items.every((item) => item.outcome === "applied")).toBe(true);
    // Applied items are never touched again: the repeat is settled and silent.
    expect(writer.creates).toHaveLength(2);
  });

  it("adopts provider-created events with zero new creates", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const writer = makeWriter();
    for (const block of plan.blocks) {
      const provenance: ApplyEventProvenance = {
        actorUserId: ids.userA,
        planId: plan.id,
        blockId: block.id,
        planRevision: batch.expectedRevision,
        operationId: batch.id
      };
      await writer.createAddition({
        ctx: toolCtx(),
        window: {
          start: new Date(ADD_A_START),
          end: new Date("2026-09-12T16:30:00.000Z"),
          durationMinutes: 30,
          title: "pre"
        },
        provenance
      });
    }
    expect(writer.creates).toHaveLength(2);
    const report = await new ApplyExecutionService(baseDeps({ writer })).executeReservedAdditions(
      recoverInput(plan.id, batch.idempotencyKey, batch.id)
    );
    expect(report.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(writer.creates).toHaveLength(2);
  });

  it("returns the current report with zero provider calls when nothing remains", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const writer = makeWriter();
    let factsReads = 0;
    const countingFacts = {
      readAvailability: async () => {
        factsReads += 1;
        return { intervals: [], complete: true };
      }
    };
    const first = await new ApplyExecutionService(
      baseDeps({ writer, facts: countingFacts })
    ).executeReservedAdditions(recoverInput(plan.id, batch.idempotencyKey, batch.id));
    expect(first.items.every((item) => item.outcome === "applied")).toBe(true);
    const createsAfter = writer.creates.length;
    const lookupsAfter = writer.lookups.length;
    const readsAfter = factsReads;
    const second = await new ApplyExecutionService(
      baseDeps({ writer, facts: countingFacts })
    ).executeReservedAdditions(recoverInput(plan.id, batch.idempotencyKey, batch.id));
    expect(second.status).toBe("completed");
    expect(second.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(writer.creates).toHaveLength(createsAfter);
    expect(writer.lookups).toHaveLength(lookupsAfter);
    expect(factsReads).toBe(readsAfter);
  });

  it("records unknown with the event id when finalization fails, then adopts", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const writer = makeWriter();
    let failNextRecord = true;
    const flakyBatches: ApplyExecutionDeps["batches"] = {
      getApplyBatch: (...args) => repository.getApplyBatch(...args),
      getApplyBatchById: (...args) => repository.getApplyBatchById(...args),
      getById: (...args) => repository.getById(...args),
      mirrorAppliedBlock: (...args) => repository.mirrorAppliedBlock(...args),
      recordItemResult: async (...args) => {
        if (failNextRecord) {
          failNextRecord = false;
          throw new Error("recover finalize boom");
        }
        return repository.recordItemResult(...args);
      }
    };
    const partial = await new ApplyExecutionService(
      baseDeps({ writer, batches: flakyBatches })
    ).executeReservedAdditions(recoverInput(plan.id, batch.idempotencyKey, batch.id));
    expect(partial.items).toHaveLength(2);
    const failed = partial.items[0]!;
    expect(failed.outcome).toBe("unknown");
    expect(failed.result?.status).toBe("unknown");
    const eventId = failed.result?.status === "unknown" ? failed.result.providerEventId : undefined;
    expect(typeof eventId).toBe("string");
    expect(partial.items[1]?.outcome).toBe("applied");
    expect(writer.creates).toHaveLength(2);

    const adopted = await new ApplyExecutionService(
      baseDeps({ writer, batches: flakyBatches })
    ).executeReservedAdditions(recoverInput(plan.id, batch.idempotencyKey, batch.id));
    expect(adopted.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(writer.creates).toHaveLength(2);
  });

  it("lets two concurrent recovers share one provider event per item", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const inner = makeWriter();
    const seen = new Set<string>();
    let providerEvents = 0;
    const idempotent: ApplyWriterPort = {
      async createAddition(input) {
        const created = await inner.createAddition(input);
        const eventId =
          created.googleEventId ??
          applyAdditionEventId({
            actorUserId: input.provenance.actorUserId,
            planId: input.provenance.planId,
            blockId: input.provenance.blockId,
            planRevision: input.provenance.planRevision,
            operationId: input.provenance.operationId
          });
        if (!seen.has(eventId)) {
          seen.add(eventId);
          providerEvents += 1;
        }
        return created;
      },
      async lookupAddition(input) {
        return inner.lookupAddition(input);
      }
    };
    const input = recoverInput(plan.id, batch.idempotencyKey, batch.id);
    const [first, second] = await Promise.all([
      new ApplyExecutionService(baseDeps({ writer: idempotent })).executeReservedAdditions(input),
      new ApplyExecutionService(baseDeps({ writer: idempotent })).executeReservedAdditions(input)
    ]);
    // One provider event per item no matter the interleaving. Either resume
    // may report an item unknown when it loses a write race; what matters is
    // the provider saw each identity once and the stored truth converges.
    expect(providerEvents).toBe(2);
    const observedIds = [...first.items, ...second.items]
      .map((item) => item.result?.providerEventId)
      .filter((eventId): eventId is string => typeof eventId === "string");
    expect(new Set(observedIds).size).toBe(2);
    const appliedIds = new Set(
      [...first.items, ...second.items]
        .filter((item) => item.outcome === "applied")
        .map((item) => item.itemId)
    );
    expect(appliedIds.size).toBe(2);
    const converged = await new ApplyExecutionService(
      baseDeps({ writer: idempotent })
    ).executeReservedAdditions(input);
    expect(converged.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(providerEvents).toBe(2);
  });

  it("returns 409 when a retry selection goes stale before the snapshot", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const writer = makeWriter();
    const applied = await new ApplyExecutionService(baseDeps({ writer })).executeReservedAdditions(
      recoverInput(plan.id, batch.idempotencyKey, batch.id)
    );
    expect(applied.items.every((item) => item.outcome === "applied")).toBe(true);
    const staleItemId = applied.items[0]!.itemId!;
    await expect(
      new ApplyExecutionService(baseDeps({ writer })).executeReservedAdditions({
        ...recoverInput(plan.id, batch.idempotencyKey, batch.id),
        itemIds: [staleItemId]
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  function buildRouteApp(
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

  function stubReport(operationId: string, planId: string): ApplyExecutionReport {
    return { operationId, planId, status: "completed", items: [] };
  }

  it("authenticates before validating the recover body", async () => {
    const executor = vi.fn(async () => {
      throw new Error("execution must not run");
    });
    const app = Fastify();
    registerDayPlanRoutes(app, {
      resolveAccessContext: async () => {
        throw new Error("Session is missing or expired");
      },
      resolveTimeZone: async () => TIME_ZONE,
      dayPlanRepository: repository,
      findSourceRun: async () => undefined,
      findTask: async () => undefined,
      findRun: async () => undefined,
      dataContext,
      applyExecution: executor
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${randomUUID()}/operations/${randomUUID()}/recover`,
      payload: { nonsense: true }
    });
    expect(response.statusCode).toBe(401);
    expect(executor).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects recover bodies with any field, and accepts absent or empty", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const seen: ApplyExecutionInput[] = [];
    const executor = async (input: ApplyExecutionInput): Promise<ApplyExecutionReport> => {
      seen.push(input);
      return stubReport(batch.id, plan.id);
    };
    const app = buildRouteApp(userA(), executor);
    for (const payload of [{ itemIds: ["x"] }, { extra: true }, [1, 2]]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/calendar/day-plans/${plan.id}/operations/${batch.id}/recover`,
        payload: payload as never
      });
      expect(response.statusCode).toBe(400);
    }
    expect(seen).toHaveLength(0);
    const empty = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${batch.id}/recover`,
      payload: {}
    });
    expect(empty.statusCode).toBe(200);
    const absent = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${batch.id}/recover`
    });
    expect(absent.statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ planId: plan.id, operationId: batch.id });
    expect(seen[0]!.itemIds).toBeUndefined();
    await app.close();
  });

  it("returns 404 when another actor recovers the operation", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const executor = vi.fn(async () => {
      throw new Error("execution must not run");
    });
    const app = buildRouteApp(userB(), executor);
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${batch.id}/recover`,
      payload: {}
    });
    expect(response.statusCode).toBe(404);
    expect(executor).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed with 503 before any item read when execution is down", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const lookup = vi.fn();
    const app = Fastify();
    registerDayPlanRoutes(app, {
      resolveAccessContext: async () => userA(),
      resolveTimeZone: async () => TIME_ZONE,
      dayPlanRepository: Object.assign(
        Object.create(Object.getPrototypeOf(repository)),
        repository,
        { getApplyBatchById: lookup }
      ),
      findSourceRun: async () => undefined,
      findTask: async () => undefined,
      findRun: async () => undefined,
      dataContext
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${batch.id}/recover`,
      payload: {}
    });
    expect(response.statusCode).toBe(503);
    expect(lookup).not.toHaveBeenCalled();
    await app.close();
  });

  it("recovers an interrupted apply over HTTP, then repeats silently", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const writer = makeWriter();
    const executor = async (input: ApplyExecutionInput): Promise<ApplyExecutionReport> => {
      const service = new ApplyExecutionService({
        dataContext,
        batches: repository,
        findTask: async (scopedDb, id) => {
          const row = await tasks.getById(scopedDb, id);
          return row
            ? { id: row.id, ownerUserId: row.owner_user_id, status: row.status }
            : undefined;
        },
        accessGate: { checkAccess: async () => ({ ok: true }) },
        facts: { readAvailability: async () => ({ intervals: [], complete: true }) },
        writer
      });
      return service.executeReservedAdditions(input);
    };
    const app = buildRouteApp(userA(), executor);
    const pending = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${plan.id}/operations/${batch.id}`
    });
    expect((pending.json() as { status: string }).status).toBe("pending");

    const first = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${batch.id}/recover`,
      payload: {}
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as ApplyExecutionReport;
    expect(firstBody.operationId).toBe(batch.id);
    expect(firstBody.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(writer.creates).toHaveLength(2);

    const status = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${plan.id}/operations/${batch.id}`
    });
    expect((status.json() as { status: string }).status).toBe("completed");

    const second = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${batch.id}/recover`,
      payload: {}
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as ApplyExecutionReport).items).toHaveLength(2);
    expect(writer.creates).toHaveLength(2);
    await app.close();
  });
});
