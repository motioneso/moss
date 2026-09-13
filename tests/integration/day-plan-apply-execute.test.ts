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

function userBContext(): AccessContext {
  return { actorUserId: ids.userB, requestId: "request:user-b-apply-execute" };
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

describe("apply addition execution boundary", () => {
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

  function loggingFacts() {
    return {
      readAvailability: async () => {
        events.push("facts-read");
        return { intervals: [], complete: true };
      }
    };
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
  it("executes reserved additions with no provider call inside a transaction", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const { writer, inner } = loggingWriter();
    const service = new ApplyExecutionService(baseDeps({ writer, facts: loggingFacts() }));

    const report = await service.executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );

    expect(report.status).toBe("completed");
    expect(report.operationId).toBe(batch.id);
    expect(report.items).toHaveLength(2);
    for (const item of report.items) {
      expect(item.outcome).toBe("applied");
      expect(item.result?.status).toBe("applied");
    }
    expect(inner.creates).toHaveLength(2);
    assertWriterOutsideTransactions();

    // Blocks now record the placement and no longer propose the addition.
    const reloaded = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, plan.id)
    );
    for (const block of reloaded?.blocks ?? []) {
      expect(block.pendingChange).toBeNull();
      expect(block.actualPlacement?.calendarEventRef).toMatch(/^jap/);
    }
    // Outcomes with typed results survived in storage.
    const stored = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getApplyBatch(scopedDb, { planId: plan.id, idempotencyKey: batch.idempotencyKey })
    );
    expect(stored?.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(
      stored?.items.every(
        (item) => item.result?.status === "applied" && item.result.blockMirror === "mirrored"
      )
    ).toBe(true);
  });

  it("denies a batch whose task finished, with zero provider calls", async () => {
    const { writer, inner } = loggingWriter();
    const otherTask = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      tasks.create(scopedDb, {
        title: "Soon done task",
        dueAt: "2026-09-14T18:00:00.000Z",
        doAt: "2026-09-12T16:00:00.000Z"
      })
    );
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createForDay(scopedDb, { localDay: nextDay(), timeZone: TIME_ZONE })
    );
    const saved = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: created.id,
        localDay: created.localDay,
        timeZone: TIME_ZONE,
        expectedRevision: created.revision,
        blocks: [
          {
            taskId: otherTask.id,
            kind: "focus",
            title: "Finishing touch",
            pendingChange: { kind: "add", startsAt: ADD_A_START, durationMinutes: 30 }
          }
        ]
      })
    );
    const batch = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: saved.id,
        expectedRevision: saved.revision,
        idempotencyKey: `exec-donetask-${randomUUID()}`
      })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      tasks.updateStatus(scopedDb, otherTask.id, "done")
    );

    const service = new ApplyExecutionService(baseDeps({ writer }));
    const report = await service.executeReservedAdditions(
      executeInput(saved.id, batch.idempotencyKey)
    );

    expect(report.status).toBe("denied");
    expect(report.denialReason).toMatch(/task-ineligible/);
    expect(inner.creates).toHaveLength(0);
    expect(inner.lookups).toHaveLength(0);
    assertWriterOutsideTransactions();
  });

  it("denies mixed batches, revoked access, stale facts and preflight conflicts", async () => {
    // Mixed batch: an explicitly selected move joins the reservation.
    const mixedDay = nextDay();
    const mixedCreated = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createForDay(scopedDb, { localDay: mixedDay, timeZone: TIME_ZONE })
    );
    const mixedSaved = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDraft(scopedDb, {
        planId: mixedCreated.id,
        localDay: mixedDay,
        timeZone: TIME_ZONE,
        expectedRevision: mixedCreated.revision,
        blocks: [
          {
            taskId,
            kind: "focus",
            title: "Add me",
            pendingChange: { kind: "add", startsAt: ADD_A_START, durationMinutes: 30 }
          },
          {
            taskId,
            kind: "focus",
            title: "Move me",
            pendingChange: { kind: "move", startsAt: ADD_B_START, durationMinutes: 30 }
          }
        ]
      })
    );
    const moveId = mixedSaved.blocks.find((block) => block.title === "Move me")!.id;
    const mixedBatch = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.reserveApplyBatch(scopedDb, {
        planId: mixedSaved.id,
        expectedRevision: mixedSaved.revision,
        idempotencyKey: `exec-mixed-${randomUUID()}`,
        selectedBlockIds: [moveId]
      })
    );
    const { writer: mixedWriter, inner: mixedInner } = loggingWriter();
    const mixedReport = await new ApplyExecutionService(
      baseDeps({ writer: mixedWriter })
    ).executeReservedAdditions(executeInput(mixedSaved.id, mixedBatch.idempotencyKey));
    expect(mixedReport.status).toBe("denied");
    expect(mixedReport.denialReason).toMatch(/mixed-batch/);
    expect(mixedInner.creates).toHaveLength(0);

    // Revoked access, stale facts, and a protected-time conflict deny the rest.
    const cases: { name: string; overrides: Partial<ApplyExecutionDeps>; reason: RegExp }[] = [
      {
        name: "revoked access",
        overrides: { accessGate: { checkAccess: async () => ({ ok: false, reason: "revoked" }) } },
        reason: /access-denied/
      },
      {
        name: "stale facts",
        overrides: {
          facts: { readAvailability: async () => ({ intervals: [], complete: false }) }
        },
        reason: /facts-unavailable/
      },
      {
        name: "protected conflict",
        overrides: {
          facts: {
            readAvailability: async () => ({
              intervals: [
                {
                  start: ADD_A_START,
                  end: "2026-09-12T17:00:00.000Z",
                  title: "Standup",
                  accountLabel: "work",
                  eventKey: "evt-standup"
                }
              ],
              complete: true
            })
          }
        },
        reason: /conflict/
      }
    ];
    for (const c of cases) {
      const { plan, batch } = await seedReservedBatch(nextDay());
      const { writer, inner } = loggingWriter();
      const report = await new ApplyExecutionService(
        baseDeps({ writer, ...c.overrides })
      ).executeReservedAdditions(executeInput(plan.id, batch.idempotencyKey));
      expect(report.status, c.name).toBe("denied");
      expect(report.denialReason, c.name).toMatch(c.reason);
      expect(inner.creates, c.name).toHaveLength(0);
      expect(inner.lookups, c.name).toHaveLength(0);
    }
    assertWriterOutsideTransactions();
  });

  it("records honest partial outcomes when a later item newly conflicts", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const { writer, inner } = loggingWriter();
    const service = new ApplyExecutionService(
      baseDeps({
        writer,
        facts: {
          readAvailability: async (window) => {
            // Wide preflight window stays clean; the second addition's own
            // window gains a live commitment between preflight and creation.
            if (window.start === ADD_B_START) {
              return {
                intervals: [
                  {
                    start: ADD_B_START,
                    end: "2026-09-12T18:00:00.000Z",
                    title: "Late meeting",
                    accountLabel: "work",
                    eventKey: "evt-late"
                  }
                ],
                complete: true
              };
            }
            return { intervals: [], complete: true };
          }
        }
      })
    );

    const report = await service.executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );

    expect(report.status).toBe("completed");
    const [first, second] = report.items;
    expect(first?.outcome).toBe("applied");
    expect(second?.outcome).toBe("failed");
    expect(second?.result).toMatchObject({ status: "failed", reason: "conflict" });
    expect(inner.creates).toHaveLength(1);
    assertWriterOutsideTransactions();
  });

  it("replays without duplicating provider events", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const { writer, inner } = loggingWriter();
    const deps = baseDeps({ writer });
    const first = await new ApplyExecutionService(deps).executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(first.items.every((item) => item.outcome === "applied")).toBe(true);
    const createsAfterFirst = inner.creates.length;
    expect(createsAfterFirst).toBe(2);

    const second = await new ApplyExecutionService(deps).executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(second.status).toBe("completed");
    expect(second.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(inner.creates).toHaveLength(createsAfterFirst);
    assertWriterOutsideTransactions();
  });

  it("leaves ambiguous responses unknown and reconciles them on the next call", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    let lookupOpen = false;
    const { writer, inner } = loggingWriter({
      lookup: () => (lookupOpen ? { found: true } : { found: false })
    });
    const deps = baseDeps({ writer });
    const first = await new ApplyExecutionService(deps).executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(first.items.every((item) => item.outcome === "unknown")).toBe(true);
    expect(inner.creates).toHaveLength(2);

    lookupOpen = true;
    const second = await new ApplyExecutionService(deps).executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(second.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(
      second.items.every(
        (item) => item.result?.status === "applied" && item.result.calendarMirror === "not-checked"
      )
    ).toBe(true);
    expect(inner.creates).toHaveLength(2);
    assertWriterOutsideTransactions();
  });

  it("never adopts a mismatched event", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const { writer, inner } = loggingWriter({
      lookup: () => ({
        found: true,
        provenance: {
          jarvisTool: "applyAddition",
          jarvisActorUserId: ids.userA,
          jarvisPlanId: plan.id,
          jarvisBlockId: "someone-elses-block",
          jarvisPlanRevision: "1",
          jarvisOperationId: batch.id
        }
      })
    });
    const deps = baseDeps({ writer });
    let factsReads = 0;
    const countingFacts = {
      readAvailability: async (window: { start: string; end: string }) => {
        factsReads += 1;
        return deps.facts.readAvailability(window);
      }
    };
    const report = await new ApplyExecutionService(
      baseDeps({ writer, facts: countingFacts })
    ).executeReservedAdditions(executeInput(plan.id, batch.idempotencyKey));
    expect(report.items.every((item) => item.outcome === "failed")).toBe(true);
    expect(report.items[0]?.result).toMatchObject({
      status: "failed",
      reason: "provenance-mismatch"
    });
    expect(inner.creates).toHaveLength(0);
    const readsAfterFirst = factsReads;
    const lookupsAfterFirst = inner.lookups.length;

    // A definite failure is settled: replay touches neither facts nor provider.
    const replayed = await new ApplyExecutionService(
      baseDeps({ writer, facts: countingFacts })
    ).executeReservedAdditions(executeInput(plan.id, batch.idempotencyKey));
    expect(replayed.items.every((item) => item.outcome === "failed")).toBe(true);
    expect(factsReads).toBe(readsAfterFirst);
    expect(inner.lookups).toHaveLength(lookupsAfterFirst);
    expect(inner.creates).toHaveLength(0);
    assertWriterOutsideTransactions();
  });

  it("maps a writer-side no-clear-slot to conflict", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const { writer, inner } = loggingWriter({
      create: () => ({
        created: false,
        resolvedStart: ADD_A_START,
        resolvedEnd: "2026-09-12T16:30:00.000Z",
        shifted: false,
        conflict: "no-clear-slot",
        calendarMirror: "skipped-error"
      })
    });
    const report = await new ApplyExecutionService(baseDeps({ writer })).executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(report.items.every((item) => item.outcome === "failed")).toBe(true);
    expect(report.items[0]?.result).toMatchObject({ status: "failed", reason: "conflict" });
    expect(inner.creates).toHaveLength(2);
    assertWriterOutsideTransactions();
  });

  it("reconciles a lost finalization on the next call without a second event", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const { writer, inner } = loggingWriter();
    let failNextRecord = true;
    const flakyBatches: ApplyExecutionDeps["batches"] = {
      getApplyBatch: (...args) => repository.getApplyBatch(...args),
      getApplyBatchById: (...args) => repository.getApplyBatchById(...args),
      getById: (...args) => repository.getById(...args),
      mirrorAppliedBlock: (...args) => repository.mirrorAppliedBlock(...args),
      recordItemResult: async (...args) => {
        if (failNextRecord) {
          failNextRecord = false;
          throw new Error("finalize boom");
        }
        return repository.recordItemResult(...args);
      }
    };
    const deps = baseDeps({ writer, batches: flakyBatches });
    // Provider success with a failed local write stays truthful: the item is
    // recorded unknown with its event id, never applied, and the batch runs on.
    const partial = await new ApplyExecutionService(deps).executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(partial.status).toBe("completed");
    expect(partial.items).toHaveLength(2);
    const firstPartial = partial.items[0]!;
    expect(firstPartial.outcome).toBe("unknown");
    expect(firstPartial.result?.status).toBe("unknown");
    const partialEventId =
      firstPartial.result?.status === "unknown" ? firstPartial.result.providerEventId : undefined;
    expect(typeof partialEventId).toBe("string");
    expect(partial.items[1]?.outcome).toBe("applied");
    expect(inner.creates).toHaveLength(2);

    const report = await new ApplyExecutionService(deps).executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(report.status).toBe("completed");
    expect(report.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(inner.creates).toHaveLength(2);
    assertWriterOutsideTransactions();
  });

  it("preserves a concurrently changed draft and records the mismatch", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const byTitle = new Map(plan.blocks.map((block) => [block.title, block]));
    const mutating = makeWriter();
    let mutated = false;
    const syncId = byTitle.get("Sync")!.id;
    const mutatingWriter: ApplyWriterPort = {
      async createAddition(input) {
        const created = await mutating.createAddition(input);
        // One draft edit lands between provider success and finalization.
        if (!mutated) {
          mutated = true;
          await dataContext.withDataContext(userAContext(), (scopedDb) =>
            repository.saveDraft(scopedDb, {
              planId: plan.id,
              localDay: plan.localDay,
              timeZone: TIME_ZONE,
              expectedRevision: plan.revision,
              blocks: [
                {
                  id: byTitle.get("Morning write-up")!.id,
                  taskId,
                  kind: "focus",
                  title: "Morning write-up",
                  pendingChange: { kind: "add", startsAt: ADD_A_START, durationMinutes: 30 }
                },
                {
                  id: syncId,
                  taskId,
                  kind: "focus",
                  title: "Sync",
                  pendingChange: {
                    kind: "add",
                    startsAt: "2026-09-12T19:00:00.000Z",
                    durationMinutes: 30
                  }
                }
              ]
            })
          );
        }
        events.push("writer-create");
        return created;
      },
      async lookupAddition(input) {
        events.push("writer-lookup");
        return mutating.lookupAddition(input);
      }
    };
    const report = await new ApplyExecutionService(
      baseDeps({ writer: mutatingWriter })
    ).executeReservedAdditions(executeInput(plan.id, batch.idempotencyKey));

    const syncReport = report.items.find((item) => item.blockId === byTitle.get("Sync")!.id);
    expect(syncReport?.outcome).toBe("applied");
    expect(syncReport?.result).toMatchObject({
      status: "applied",
      blockMirror: "mismatch-preserved"
    });
    const reloaded = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, plan.id)
    );
    const syncBlock = reloaded?.blocks.find((block) => block.id === byTitle.get("Sync")!.id);
    expect(syncBlock?.pendingChange).toEqual({
      kind: "add",
      startsAt: "2026-09-12T19:00:00.000Z",
      durationMinutes: 30
    });
    assertWriterOutsideTransactions();
  });

  it("advances the plan revision on mirror and rejects stale draft saves", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const { writer, inner } = loggingWriter();
    const service = new ApplyExecutionService(baseDeps({ writer }));
    const first = await service.executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(first.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(inner.creates).toHaveLength(2);

    const reloaded = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, plan.id)
    );
    expect(reloaded?.revision).toBe(plan.revision + 2);

    // A draft save with the pre-execution revision cannot recreate the addition.
    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.saveDraft(scopedDb, {
          planId: plan.id,
          localDay: reloaded!.localDay,
          timeZone: TIME_ZONE,
          expectedRevision: plan.revision,
          blocks: [
            {
              taskId,
              kind: "focus",
              title: "Morning write-up",
              pendingChange: { kind: "add", startsAt: ADD_A_START, durationMinutes: 30 }
            }
          ]
        })
      )
    ).rejects.toMatchObject({ statusCode: 409 });

    // Replay still reports the stored outcomes with no second provider event.
    const second = await service.executeReservedAdditions(
      executeInput(plan.id, batch.idempotencyKey)
    );
    expect(second.items.every((item) => item.outcome === "applied")).toBe(true);
    expect(inner.creates).toHaveLength(2);
    assertWriterOutsideTransactions();
  });

  it("isolates actors and rejects unknown batches", async () => {
    const { plan, batch } = await seedReservedBatch(nextDay());
    const service = new ApplyExecutionService(baseDeps());
    await expect(
      service.executeReservedAdditions({
        access: userBContext(),
        toolCtx: toolCtx(),
        planId: plan.id,
        idempotencyKey: batch.idempotencyKey
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.executeReservedAdditions(executeInput(plan.id, `missing-${randomUUID()}`))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
