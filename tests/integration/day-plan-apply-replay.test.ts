import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  type ApplyWriterPort,
  type ProposeFocusResult
} from "@moss/calendar";
import { DayPlanRepository } from "@moss/calendar";
import { TasksRepository } from "@moss/tasks";
import type { ApplyEventProvenance } from "@moss/shared";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const TIME_ZONE = "America/Los_Angeles";
const ADD_A_START = "2026-09-12T16:00:00.000Z";
const ADD_B_START = "2026-09-12T17:30:00.000Z";

function userAContext(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:user-a-apply-execute" };
}

function toolCtx(): ToolContext {
  return { actorUserId: ids.userA, requestId: "request:tool", chatSessionId: "session-1" };
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
        googleEventId: applyAdditionEventId({
          actorUserId: input.provenance.actorUserId,
          planId: input.provenance.planId,
          blockId: input.provenance.blockId,
          planRevision: input.provenance.planRevision,
          operationId: input.provenance.operationId
        }),
        calendarMirror: "written"
      };
    },
    async lookupAddition(input) {
      lookups.push(input.eventId);
      if (script.lookup) {
        const scripted = script.lookup(input.eventId);
        if (!scripted.found) return { found: false };
        const created = creates.find(
          (provenance) =>
            applyAdditionEventId({
              actorUserId: provenance.actorUserId,
              planId: provenance.planId,
              blockId: provenance.blockId,
              planRevision: provenance.planRevision,
              operationId: provenance.operationId
            }) === input.eventId
        );
        return {
          found: true,
          id: input.eventId,
          summary: "Planned block",
          start: ADD_A_START,
          end: "2026-09-12T16:30:00.000Z",
          provenance: scripted.provenance ?? (created ? provenanceProps(created) : {})
        };
      }
      const created = creates.find(
        (provenance) =>
          applyAdditionEventId({
            actorUserId: provenance.actorUserId,
            planId: provenance.planId,
            blockId: provenance.blockId,
            planRevision: provenance.planRevision,
            operationId: provenance.operationId
          }) === input.eventId
      );
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

describe("apply addition execution boundary: replay and verification", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: DayPlanRepository;
  let tasks: TasksRepository;
  let taskId: string;
  let daySeq = 20;
  // Shared ordering probe: every runner transaction and writer call appends
  // here, so tests prove provider I/O never runs inside a service transaction.
  let events: string[];
  let runner: Pick<DataContextRunner, "withDataContext">;

  function nextDay(): string {
    daySeq += 1;
    const date = new Date(Date.UTC(2026, 8, 21 + daySeq));
    return date.toISOString().slice(0, 10);
  }

  function setupLoggingRunner() {
    events = [];
    runner = {
      withDataContext: (async (ctx: AccessContext, cb: (db: DataContextDb) => Promise<unknown>) => {
        events.push("txn-open");
        try {
          return await dataContext.withDataContext(ctx, cb);
        } finally {
          events.push("txn-close");
        }
      }) as Pick<DataContextRunner, "withDataContext">["withDataContext"]
    };
  }

  function loggingWriter(script: WriterScript = {}) {
    const inner = makeWriter(script);
    const writer: ApplyWriterPort = {
      async createAddition(input) {
        events.push("writer-create");
        return inner.createAddition(input);
      },
      async lookupAddition(input) {
        events.push("writer-lookup");
        return inner.lookupAddition(input);
      }
    };
    return { writer, inner };
  }

  function baseDeps(overrides: Partial<ApplyExecutionDeps> = {}): ApplyExecutionDeps {
    return {
      dataContext: runner,
      batches: repository,
      findTask: async (scopedDb, id) => {
        const row = await tasks.getById(scopedDb, id);
        return row ? { id: row.id, ownerUserId: row.owner_user_id, status: row.status } : undefined;
      },
      accessGate: { checkAccess: async () => ({ ok: true }) },
      facts: {
        readAvailability: async () => ({ intervals: [], complete: true })
      },
      writer: makeWriter(),
      ...overrides
    };
  }

  async function seedReservedBatch(localDay: string) {
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createForDay(scopedDb, { localDay, timeZone: TIME_ZONE })
    );
    const saved = await dataContext.withDataContext(userAContext(), (scopedDb) =>
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
    const batch = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: saved.id,
        expectedRevision: saved.revision,
        idempotencyKey: `exec-${randomUUID()}`
      })
    );
    return { plan: saved, batch };
  }

  function executeInput(planId: string, idempotencyKey: string) {
    return { access: userAContext(), toolCtx: toolCtx(), planId, idempotencyKey };
  }

  function assertWriterOutsideTransactions() {
    let depth = 0;
    for (const event of events) {
      if (event === "txn-open") depth += 1;
      else if (event === "txn-close") depth -= 1;
      else if (event.startsWith("writer-") || event === "facts-read") expect(depth).toBe(0);
    }
    expect(depth).toBe(0);
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
    taskId = await dataContext
      .withDataContext(userAContext(), (scopedDb: DataContextDb) =>
        tasks.create(scopedDb, {
          title: "Execution fixture task",
          dueAt: "2026-09-14T18:00:00.000Z",
          doAt: "2026-09-12T16:00:00.000Z"
        })
      )
      .then((task) => task.id);
    setupLoggingRunner();
  });

  afterAll(async () => {
    await Promise.allSettled([appDb?.destroy()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setupLoggingRunner();
  });
  it("stores unknown with the event id when the writer cannot verify", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const throwing: ApplyWriterPort = {
      async createAddition() {
        throw new Error("Your Google connection changed during the request");
      },
      async lookupAddition() {
        return { found: false };
      }
    };
    const report = await new ApplyExecutionService(
      baseDeps({ writer: throwing })
    ).executeReservedAdditions(executeInput(plan.id, batch.idempotencyKey));
    expect(report.status).toBe("completed");
    expect(report.items).toHaveLength(2);
    for (const item of report.items) {
      expect(item.outcome).toBe("unknown");
      expect(item.result?.status).toBe("unknown");
      if (item.result?.status === "unknown") {
        expect(item.result.reason).toBe("unknown");
        expect(item.result.providerEventId).toMatch(/^jap/);
      }
    }
    const stored = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: batch.idempotencyKey })
    );
    expect(
      stored?.items.every(
        (item) =>
          item.outcome === "unknown" &&
          item.result?.status === "unknown" &&
          typeof item.result.providerEventId === "string"
      )
    ).toBe(true);
  });

  it("replays settled batches without gate, facts, or provider work", async () => {
    const throwingGate = {
      checkAccess: async (): Promise<
        { readonly ok: true } | { readonly ok: false; readonly reason: string }
      > => {
        throw new Error("gate must not run on settled replay");
      }
    };
    const throwingFacts = {
      readAvailability: async (): Promise<{
        readonly intervals: readonly [];
        readonly complete: boolean;
      }> => {
        throw new Error("facts must not run on settled replay");
      }
    };
    const throwingWriter: ApplyWriterPort = {
      async createAddition() {
        throw new Error("writer must not run on settled replay");
      },
      async lookupAddition() {
        throw new Error("writer must not run on settled replay");
      }
    };
    const silent = () =>
      baseDeps({ accessGate: throwingGate, facts: throwingFacts, writer: throwingWriter });

    // Fully applied.
    const appliedSeed = await seedReservedBatch(nextDay());
    const firstApplied = await new ApplyExecutionService(baseDeps({})).executeReservedAdditions(
      executeInput(appliedSeed.plan.id, appliedSeed.batch.idempotencyKey)
    );
    expect(firstApplied.items.every((item) => item.outcome === "applied")).toBe(true);
    const replayedApplied = await new ApplyExecutionService(silent()).executeReservedAdditions(
      executeInput(appliedSeed.plan.id, appliedSeed.batch.idempotencyKey)
    );
    expect(replayedApplied.status).toBe("completed");
    expect(replayedApplied.items).toEqual(firstApplied.items);

    // Fully failed.
    const failedSeed = await seedReservedBatch(nextDay());
    const failingWriter = loggingWriter({
      create: () => ({
        created: false,
        resolvedStart: ADD_A_START,
        resolvedEnd: "2026-09-12T16:30:00.000Z",
        shifted: false,
        conflict: "no-clear-slot",
        calendarMirror: "skipped-error"
      })
    }).writer;
    const firstFailed = await new ApplyExecutionService(
      baseDeps({ writer: failingWriter })
    ).executeReservedAdditions(executeInput(failedSeed.plan.id, failedSeed.batch.idempotencyKey));
    expect(firstFailed.items.every((item) => item.outcome === "failed")).toBe(true);
    const replayedFailed = await new ApplyExecutionService(silent()).executeReservedAdditions(
      executeInput(failedSeed.plan.id, failedSeed.batch.idempotencyKey)
    );
    expect(replayedFailed.status).toBe("completed");
    expect(replayedFailed.items).toEqual(firstFailed.items);

    // Mixed applied and failed.
    const mixedSeed = await seedReservedBatch(nextDay());
    const failFirstBlock = mixedSeed.plan.blocks[0]!.id;
    const mixedWriter = loggingWriter({
      create: (provenance) =>
        provenance.blockId === failFirstBlock
          ? {
              created: false,
              resolvedStart: ADD_A_START,
              resolvedEnd: "2026-09-12T16:30:00.000Z",
              shifted: false,
              conflict: "no-clear-slot",
              calendarMirror: "skipped-error"
            }
          : {
              created: true,
              resolvedStart: ADD_A_START,
              resolvedEnd: "2026-09-12T16:30:00.000Z",
              shifted: false,
              conflict: "none",
              googleEventId: applyAdditionEventId({
                actorUserId: provenance.actorUserId,
                planId: provenance.planId,
                blockId: provenance.blockId,
                planRevision: provenance.planRevision,
                operationId: provenance.operationId
              }),
              calendarMirror: "written"
            }
    }).writer;
    const firstMixed = await new ApplyExecutionService(
      baseDeps({ writer: mixedWriter })
    ).executeReservedAdditions(executeInput(mixedSeed.plan.id, mixedSeed.batch.idempotencyKey));
    expect(firstMixed.items.map((item) => item.outcome).sort()).toEqual(["applied", "failed"]);
    const replayedMixed = await new ApplyExecutionService(silent()).executeReservedAdditions(
      executeInput(mixedSeed.plan.id, mixedSeed.batch.idempotencyKey)
    );
    expect(replayedMixed.status).toBe("completed");
    expect(replayedMixed.items).toEqual(firstMixed.items);
  });

  it("still gates batches with pending or unknown items", async () => {
    let gateCalls = 0;
    const countingGate = {
      checkAccess: async () => {
        gateCalls += 1;
        return { ok: true as const };
      }
    };
    const { plan, batch } = await seedReservedBatch(nextDay());
    const pendingReport = await new ApplyExecutionService(
      baseDeps({ accessGate: countingGate })
    ).executeReservedAdditions(executeInput(plan.id, batch.idempotencyKey));
    expect(pendingReport.status).toBe("completed");
    expect(gateCalls).toBe(1);

    gateCalls = 0;
    const unknownSeed = await seedReservedBatch(nextDay());
    const closedLookup = loggingWriter({ lookup: () => ({ found: false }) }).writer;
    const first = await new ApplyExecutionService(
      baseDeps({ writer: closedLookup, accessGate: countingGate })
    ).executeReservedAdditions(executeInput(unknownSeed.plan.id, unknownSeed.batch.idempotencyKey));
    expect(first.items.every((item) => item.outcome === "unknown")).toBe(true);
    expect(gateCalls).toBe(1);
    const second = await new ApplyExecutionService(
      baseDeps({ writer: closedLookup, accessGate: countingGate })
    ).executeReservedAdditions(executeInput(unknownSeed.plan.id, unknownSeed.batch.idempotencyKey));
    expect(second.items.every((item) => item.outcome === "unknown")).toBe(true);
    expect(gateCalls).toBe(2);
  });

  it("executes only the selected failed items on selective retry", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const failing = loggingWriter({
      create: () => ({
        created: false,
        resolvedStart: ADD_A_START,
        resolvedEnd: "2026-09-12T16:30:00.000Z",
        shifted: false,
        conflict: "no-clear-slot",
        calendarMirror: "skipped-error"
      })
    });
    const first = await new ApplyExecutionService(
      baseDeps({ writer: failing.writer })
    ).executeReservedAdditions(executeInput(plan.id, batch.idempotencyKey));
    expect(first.items.every((item) => item.outcome === "failed")).toBe(true);

    const stored = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: batch.idempotencyKey })
    );
    const selected = stored!.items[0]!.id;
    const { writer, inner } = loggingWriter();
    const retried = await new ApplyExecutionService(baseDeps({ writer })).executeReservedAdditions({
      ...executeInput(plan.id, batch.idempotencyKey),
      itemIds: [selected]
    });
    expect(retried.status).toBe("completed");
    expect(retried.items.find((item) => item.itemId === selected)?.outcome).toBe("applied");
    expect(
      retried.items
        .filter((item) => item.itemId !== selected)
        .every((item) => item.outcome === "failed")
    ).toBe(true);
    // Exactly one provider create ran: the unselected item was never touched.
    expect(inner.creates).toHaveLength(1);
    const after = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: batch.idempotencyKey })
    );
    expect(after!.items.find((item) => item.id === selected)?.outcome).toBe("applied");
    expect(
      after!.items.filter((item) => item.id !== selected).every((item) => item.outcome === "failed")
    ).toBe(true);
  });

  it("returns 409 for a stale selective retry in the opening snapshot", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const { writer } = loggingWriter();
    const first = await new ApplyExecutionService(baseDeps({ writer })).executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(first.items.every((item) => item.outcome === "applied")).toBe(true);

    const retrying = loggingWriter();
    await expect(
      new ApplyExecutionService(baseDeps({ writer: retrying.writer })).executeReservedAdditions({
        ...executeInput(plan.id, batch.idempotencyKey),
        itemIds: [batch.items[0]!.id]
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(retrying.inner.creates).toHaveLength(0);
  });

  it("carries a verified cache miss through as not-cached", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const { writer, inner } = loggingWriter({
      create: (provenance) => ({
        created: true,
        resolvedStart: ADD_A_START,
        resolvedEnd: "2026-09-12T16:30:00.000Z",
        shifted: false,
        conflict: "none",
        googleEventId: applyAdditionEventId({
          actorUserId: provenance.actorUserId,
          planId: provenance.planId,
          blockId: provenance.blockId,
          planRevision: provenance.planRevision,
          operationId: provenance.operationId
        }),
        calendarMirror: "not-cached"
      })
    });
    const report = await new ApplyExecutionService(baseDeps({ writer })).executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(report.status).toBe("completed");
    expect(report.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(
      report.items.every(
        (item) => item.result?.status === "applied" && item.result.calendarMirror === "not-cached"
      )
    ).toBe(true);
    expect(inner.creates).toHaveLength(2);
    // The stored batch round-trips the new state through the result parser.
    const stored = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: batch.idempotencyKey })
    );
    expect(
      stored?.items.every(
        (item) => item.result?.status === "applied" && item.result.calendarMirror === "not-cached"
      )
    ).toBe(true);
    assertWriterOutsideTransactions();
  });
});
