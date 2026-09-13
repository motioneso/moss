// Shared harness for the apply-moves-and-removals integration tests
// (R2.2-T05). Owns the isolated-database lifecycle, the scriptable provider
// double for the whole writer port, the transaction-ordering probe, and the
// plan staging that records placements through a real addition apply. Kept
// out of the test file so it stays under the file-size limit.
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { expect } from "vitest";
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
  type ApplyBusyInterval,
  type ApplyWriterPort,
  type DayPlanChangeApprovalPort
} from "@moss/calendar";
import { DayPlanRepository } from "@moss/calendar";
import { TasksRepository } from "@moss/tasks";
import { AiRepository } from "@moss/ai";
import type { ApplyEventProvenance } from "@moss/shared";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { registerDayPlanRoutes } from "../../packages/calendar/src/day-plan-routes.js";
import { buildDayPlanApplyComposition } from "../../packages/chat/src/module-registry/day-plan-apply-composition.js";

export const TIME_ZONE = "America/Los_Angeles";
export const T0 = "2026-09-12T16:00:00.000Z";
export const T1 = "2026-09-12T17:30:00.000Z";
export const T2 = "2026-09-12T19:00:00.000Z";
export const T3 = "2026-09-12T20:00:00.000Z";
export const T4 = "2026-09-12T21:00:00.000Z";

export function userA(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:changes-a" };
}

export function userB(): AccessContext {
  return { actorUserId: ids.userB, requestId: "request:changes-b" };
}

export function toolCtx(): ToolContext {
  return { actorUserId: ids.userA, requestId: "request:changes-tool", chatSessionId: "session-1" };
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

export interface StoredEvent {
  provenance: Record<string, string>;
  start: string;
  end: string;
  attendeeCount: number;
}

// Scriptable provider double for the whole port. Mutations (create, patch,
// delete) are counted apart from reads (lookup) so tests prove
// provenance-mismatches never mutate and adoption never patches.
export function makeChangeWriterFake() {
  const fake: {
    events: Map<string, StoredEvent>;
    lookups: string[];
    creates: ApplyEventProvenance[];
    patches: string[];
    deletes: string[];
    throwOnLookup: Set<string>;
    throwOnMutate: Set<string>;
    alreadyGone: Set<string>;
    mutations(): number;
    port(): ApplyWriterPort;
  } = {
    events: new Map<string, StoredEvent>(),
    lookups: [],
    creates: [],
    patches: [],
    deletes: [],
    throwOnLookup: new Set<string>(),
    throwOnMutate: new Set<string>(),
    alreadyGone: new Set<string>(),
    mutations(): number {
      return fake.creates.length + fake.patches.length + fake.deletes.length;
    },
    port(): ApplyWriterPort {
      return {
        async createAddition(input) {
          if (fake.throwOnMutate.has("create")) throw new Error("provider create failed");
          const eventId = applyAdditionEventId({
            actorUserId: input.provenance.actorUserId,
            planId: input.provenance.planId,
            blockId: input.provenance.blockId,
            planRevision: input.provenance.planRevision,
            operationId: input.provenance.operationId
          });
          fake.creates.push(input.provenance);
          const existing = fake.events.get(eventId);
          if (existing) {
            return {
              created: true,
              resolvedStart: existing.start,
              resolvedEnd: existing.end,
              shifted: false,
              conflict: "none",
              googleEventId: eventId,
              calendarMirror: "written"
            };
          }
          const start = input.window.start.toISOString();
          const end = input.window.end.toISOString();
          fake.events.set(eventId, {
            provenance: provenanceProps(input.provenance),
            start,
            end,
            attendeeCount: 0
          });
          return {
            created: true,
            resolvedStart: start,
            resolvedEnd: end,
            shifted: false,
            conflict: "none",
            googleEventId: eventId,
            calendarMirror: "written"
          };
        },
        async lookupAddition(input) {
          fake.lookups.push(input.eventId);
          if (fake.throwOnLookup.has(input.eventId)) throw new Error("provider lookup failed");
          const stored = fake.events.get(input.eventId);
          if (!stored) return { found: false };
          return {
            found: true,
            id: input.eventId,
            summary: "Planned block",
            start: stored.start,
            end: stored.end,
            provenance: { ...stored.provenance },
            attendeeCount: stored.attendeeCount
          };
        },
        async moveBlockEvent(input) {
          fake.patches.push(input.eventRef);
          if (fake.throwOnMutate.has(input.eventRef)) throw new Error("provider patch failed");
          const stored = fake.events.get(input.eventRef);
          if (!stored) return { ok: false, reason: "not_found" };
          if (stored.attendeeCount > 0) return { ok: false, reason: "has_attendees" };
          stored.start = input.newStart.toISOString();
          stored.end = input.newEnd.toISOString();
          return { ok: true, calendarEventId: "cache-1" };
        },
        async removeBlockEvent(input) {
          fake.deletes.push(input.eventRef);
          if (fake.throwOnMutate.has(input.eventRef)) throw new Error("provider delete failed");
          const stored = fake.events.get(input.eventRef);
          if (!stored) {
            return { deleted: false, googleDeleted: "skipped-error", cacheMirror: "not-cached" };
          }
          fake.events.delete(input.eventRef);
          if (fake.alreadyGone.has(input.eventRef)) {
            return { deleted: true, googleDeleted: "already-gone", cacheMirror: "queued" };
          }
          return { deleted: true, googleDeleted: "deleted", cacheMirror: "queued" };
        }
      };
    }
  };
  return fake;
}

export type ChangeWriterFake = ReturnType<typeof makeChangeWriterFake>;

// Harness state. Assigned in initChangesHarness, read by tests after
// beforeAll; every runner transaction, facts read and writer call appends to
// events, so tests prove provider I/O never runs inside a transaction.
export let harnessAppDb!: Kysely<MossDatabase>;
export let harnessDataContext!: DataContextRunner;
export let harnessRepository!: DayPlanRepository;
export let harnessTasks!: TasksRepository;
export let harnessApprovalPort!: DayPlanChangeApprovalPort;
export let harnessAiRepository!: AiRepository;
let harnessDaySeq = 500;
let events: string[] = [];
let runner!: Pick<DataContextRunner, "withDataContext">;
let stagedBusy: ApplyBusyInterval[] = [];
let factsComplete = true;

export function nextChangeDay(): string {
  harnessDaySeq += 1;
  return new Date(Date.UTC(2026, 9, harnessDaySeq)).toISOString().slice(0, 10);
}

export async function initChangesHarness(): Promise<void> {
  await resetFoundationDatabase();
  harnessAppDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  void new AuthSessionResolver(harnessAppDb);
  harnessDataContext = new DataContextRunner(harnessAppDb);
  harnessTasks = new TasksRepository();
  harnessRepository = new DayPlanRepository({
    findTask: async (scopedDb, id) => {
      const row = await harnessTasks.getById(scopedDb, id);
      return row ? { id: row.id, ownerUserId: row.owner_user_id } : undefined;
    }
  });
  harnessApprovalPort = buildDayPlanApplyComposition({
    dataContext: harnessDataContext
  }).changeApproval;
  harnessAiRepository = new AiRepository();
  resetChangesProbe();
}

export async function destroyChangesHarness(): Promise<void> {
  await Promise.allSettled([harnessAppDb?.destroy()]);
}

export function resetChangesProbe(): void {
  events = [];
  stagedBusy = [];
  factsComplete = true;
  const dataContext = harnessDataContext;
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

export function stageBusyInterval(interval: ApplyBusyInterval): void {
  stagedBusy.push(interval);
}

function findExecutionTask(scopedDb: DataContextDb, id: string) {
  return harnessTasks
    .getById(scopedDb, id)
    .then((row) =>
      row ? { id: row.id, ownerUserId: row.owner_user_id, status: row.status } : undefined
    );
}

function loggingPort(fake: ChangeWriterFake): ApplyWriterPort {
  const inner = fake.port();
  return {
    async createAddition(input) {
      events.push("writer-create");
      return inner.createAddition(input);
    },
    async lookupAddition(input) {
      events.push("writer-lookup");
      return inner.lookupAddition(input);
    },
    async moveBlockEvent(input) {
      events.push("writer-patch");
      return inner.moveBlockEvent(input);
    },
    async removeBlockEvent(input) {
      events.push("writer-delete");
      return inner.removeBlockEvent(input);
    }
  };
}

function rawService(
  port: ApplyWriterPort,
  context: Pick<DataContextRunner, "withDataContext">
): ApplyExecutionService {
  return new ApplyExecutionService({
    dataContext: context,
    batches: harnessRepository,
    findTask: findExecutionTask,
    accessGate: { checkAccess: async () => ({ ok: true }) },
    facts: {
      readAvailability: async (window) => {
        events.push("facts-read");
        if (!factsComplete) return { intervals: [], complete: false };
        return {
          intervals: stagedBusy.filter(
            (busy) => window.start < busy.end && busy.start < window.end
          ),
          complete: true
        };
      }
    },
    writer: port
  });
}

// The service under test: the fake port wrapped in the ordering probe.
export function buildService(
  fake: ChangeWriterFake,
  context: Pick<DataContextRunner, "withDataContext"> = runner
): ApplyExecutionService {
  return rawService(loggingPort(fake), context);
}

// Staging-only service: silent port and database, invisible to the probe.
export function buildQuietService(fake: ChangeWriterFake): ApplyExecutionService {
  return rawService(fake.port(), harnessDataContext);
}

export function buildApp(actor: AccessContext, service: ApplyExecutionService): FastifyInstance {
  const app = Fastify();
  registerDayPlanRoutes(app, {
    resolveAccessContext: async () => actor,
    resolveTimeZone: async () => TIME_ZONE,
    dayPlanRepository: harnessRepository,
    findSourceRun: async () => undefined,
    findTask: async () => undefined,
    findRun: async () => undefined,
    dataContext: runner,
    applyExecution: (input) => service.executeReservedAdditions(input),
    changeApproval: harnessApprovalPort
  });
  return app;
}

export function assertWriterOutsideTransactions(): void {
  let depth = 0;
  for (const event of events) {
    if (event === "txn-open") depth += 1;
    else if (event === "txn-close") depth -= 1;
    else if (event.startsWith("writer-") || event === "facts-read") expect(depth).toBe(0);
  }
  expect(depth).toBe(0);
}

// Stages a plan with one applied block per kind: Move me and Remove me carry
// recorded placements from a real addition apply, then gain pending
// move/remove proposals; Add me gains a fresh addition proposal.
export async function seedChangePlan(localDay: string, fake: ChangeWriterFake) {
  const created = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
    harnessRepository.createForDay(scopedDb, { localDay, timeZone: TIME_ZONE })
  );
  const drafted = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
    harnessRepository.saveDraft(scopedDb, {
      planId: created.id,
      localDay,
      timeZone: TIME_ZONE,
      expectedRevision: created.revision,
      blocks: [
        {
          taskId: null,
          kind: "focus",
          title: "Move me",
          pendingChange: { kind: "add", startsAt: T0, durationMinutes: 30 }
        },
        {
          taskId: null,
          kind: "focus",
          title: "Remove me",
          pendingChange: { kind: "add", startsAt: T1, durationMinutes: 30 }
        },
        {
          taskId: null,
          kind: "focus",
          title: "Add me",
          pendingChange: { kind: "add", startsAt: T2, durationMinutes: 30 }
        }
      ]
    })
  );
  const blockId = (title: string) => drafted.blocks.find((block) => block.title === title)!.id;
  const idsByTitle = {
    move: blockId("Move me"),
    remove: blockId("Remove me"),
    add: blockId("Add me")
  };
  const service = buildQuietService(fake);
  const reserved = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
    harnessRepository.reserveApplyBatch(scopedDb, {
      planId: drafted.id,
      expectedRevision: drafted.revision,
      idempotencyKey: `stage-${randomUUID()}`
    })
  );
  const staged = await service.executeReservedAdditions({
    access: userA(),
    toolCtx: toolCtx(),
    planId: drafted.id,
    idempotencyKey: reserved.idempotencyKey
  });
  expect(staged.status).toBe("completed");
  const current = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
    harnessRepository.getById(scopedDb, drafted.id)
  );
  const changed = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
    harnessRepository.saveDraft(scopedDb, {
      planId: drafted.id,
      localDay,
      timeZone: TIME_ZONE,
      expectedRevision: current!.revision,
      blocks: [
        {
          id: idsByTitle.move,
          taskId: null,
          kind: "focus",
          title: "Move me",
          pendingChange: { kind: "move", startsAt: T3, durationMinutes: 30 }
        },
        {
          id: idsByTitle.remove,
          taskId: null,
          kind: "focus",
          title: "Remove me",
          pendingChange: { kind: "remove" }
        },
        {
          id: idsByTitle.add,
          taskId: null,
          kind: "focus",
          title: "Add me",
          pendingChange: { kind: "add", startsAt: T4, durationMinutes: 30 }
        }
      ]
    })
  );
  return { plan: changed, ids: idsByTitle };
}

export async function applyMixed(
  app: FastifyInstance,
  planId: string,
  revision: number,
  blockIds: string[],
  key = `apply-${randomUUID()}`
) {
  return app.inject({
    method: "POST",
    url: `/api/calendar/day-plans/${planId}/apply`,
    payload: { expectedRevision: revision, idempotencyKey: key, selectedBlockIds: blockIds }
  });
}

// Reads a block's recorded provider reference, failing loudly when the
// staging did not apply it. Keeps lint's optional-chain rule satisfied.
export function placementRefOf(
  plan:
    | { blocks: { id: string; actualPlacement: { calendarEventRef: string | null } | null }[] }
    | null
    | undefined,
  blockId: string
): string {
  const ref = plan?.blocks.find((block) => block.id === blockId)?.actualPlacement?.calendarEventRef;
  if (!ref) throw new Error("staged placement is missing");
  return ref;
}

// Full stored item outcomes. HTTP responses carry outcomes but serialize
// result details away (the shared report schema keeps results opaque), so
// every result-shape assertion reads the stored batch instead.
export async function storedItems(planId: string, operationId: string) {
  const stored = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
    harnessRepository.getApplyBatchById(scopedDb, { planId, operationId })
  );
  return new Map((stored?.items ?? []).map((item) => [item.blockId, item]));
}
