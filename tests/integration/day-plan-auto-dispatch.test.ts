import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import type { AiRepository } from "@moss/ai";
import {
  BriefingsRepository,
  registerBriefingsJobWorkers,
  type BriefingDayPlanAutoPort,
  type DayPlanApplyDispatchPayload
} from "@moss/briefings";
import {
  ApplyExecutionService,
  DayPlanRepository,
  buildDayPlanAutoPort,
  isDayPlanApplyPayloadMetadataOnly,
  registerCalendarJobWorkers,
  reserveAutoPlanBlocks,
  type DayPlanApplyJobPayload
} from "@moss/calendar";
import {
  createDatabase,
  DataContextRunner,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import type { MemoryRetriever } from "@moss/memory";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { buildCalendarFollowThroughPort } from "@moss/module-registry";
import type { MossModuleManifest, ToolExecute } from "@moss/module-sdk";
import { TasksRepository } from "@moss/tasks";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

function userA(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:auto-dispatch" };
}

function prepEvent(now: Date) {
  const start = new Date(now.getTime() + 2 * 60_60_000);
  const end = new Date(now.getTime() + 3 * 60_60_000);
  return {
    id: "evt-prep-1",
    title: "Client presentation prep",
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    attendeeCount: 6
  };
}

function fakeManifests(events: () => unknown[]): MossModuleManifest[] {
  const tools: Record<string, unknown> = {
    "commitments.listVisible": { commitments: [] },
    "tasks.list": { items: [] },
    "calendar.listVisibleEvents": () => ({
      events: events(),
      accounts: [],
      gaps: []
    }),
    "email.listVisibleMessages": { messages: [], accounts: [], gaps: [] },
    "chat.listTodaysTurns": { turns: [] }
  };
  const assistantTools = Object.keys(tools).map((name) => {
    const execute: ToolExecute = async () => {
      const data = tools[name];
      const resolved = typeof data === "function" ? (data as () => unknown)() : data;
      return { data: resolved as Record<string, unknown> };
    };
    return {
      name,
      description: name,
      permissionId: "x.view",
      risk: "read" as const,
      inputSchema: { type: "object", properties: {} },
      execute
    };
  });
  return [
    {
      id: "fake-auto",
      name: "FakeAuto",
      version: "0.0.0",
      publisher: "test",
      lifecycle: "required",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantTools,
      sourceBehaviors: []
    }
  ];
}

function prefsFake(values: Record<string, unknown>) {
  return {
    async get(_scopedDb: DataContextDb, key: string) {
      return values[key] ?? null;
    },
    async getWithMetadata<T>(_scopedDb: DataContextDb, key: string) {
      const value = (values[key] ?? null) as T | null;
      return value === null ? null : { value, updatedAt: new Date() };
    },
    async upsert(_scopedDb: DataContextDb, key: string, value: unknown) {
      values[key] = value;
    }
  };
}

const noopRetriever = {
  async retrieve() {
    return [];
  },
  async retrieveRecent() {
    return [];
  }
} as unknown as MemoryRetriever;

interface AutoWorld {
  readonly dataContext: DataContextRunner;
  readonly briefings: BriefingsRepository;
  readonly plans: DayPlanRepository;
  readonly tasks: TasksRepository;
  readonly auto: BriefingDayPlanAutoPort;
  readonly dispatched: DayPlanApplyDispatchPayload[];
  readonly prefs: Record<string, unknown>;
}

async function createDefinition(dataContext: DataContextRunner, briefings: BriefingsRepository) {
  return dataContext.withDataContext(userA(), (scopedDb) =>
    briefings.createDefinition(scopedDb, {
      title: "Auto dispatch",
      briefingType: "morning",
      cadence: "daily",
      scheduleMetadata: { targetTime: "06:00", timezone: "UTC" },
      selectedToolNames: ["calendar.listVisibleEvents"]
    })
  );
}

function autoModes() {
  return {
    "calendar.prep_task_mode": "auto",
    "calendar.time_block_mode": "auto"
  };
}

describe("automatic plan generation and dispatch", () => {
  let appDb: Kysely<MossDatabase>;
  let world: AutoWorld;

  // Fresh database per test: all cases share today's local day, so a shared
  // plan would leak blocks between modes.
  beforeEach(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    const dataContext = new DataContextRunner(appDb);
    const tasks = new TasksRepository();
    const plans = new DayPlanRepository({
      findTask: async (scopedDb, id) => {
        const row = await tasks.getById(scopedDb, id);
        return row ? { id: row.id, ownerUserId: row.owner_user_id } : undefined;
      }
    });
    world = {
      dataContext,
      briefings: new BriefingsRepository(),
      plans,
      tasks,
      auto: buildDayPlanAutoPort(plans),
      dispatched: [],
      prefs: {}
    };
  });

  afterEach(async () => {
    await appDb?.destroy();
  });

  function composeDeps(events: () => unknown[], tasksRepository?: TasksRepository) {
    return {
      moduleManifests: fakeManifests(events),
      aiRepository: {
        selectModelForCapability: async () => ({
          id: "model-auto",
          provider_config_id: "pc-auto",
          provider_kind: "anthropic",
          provider_model_id: "claude",
          display_name: "Auto",
          tier: "economy"
        }),
        selectProviderWithCredential: async () => ({
          id: "pc-auto",
          base_url: null,
          encrypted_credential: { v: 1 }
        }),
        listActionPolicies: async () => []
      } as unknown as AiRepository,
      cipher: { decryptJson: () => ({ apiKey: "fake-key" }) } as never,
      memoryRetriever: noopRetriever,
      sourceBehaviorPolicy: {
        manifests: getBuiltInModuleManifests(),
        preferencesRepository: prefsFake(world.prefs)
      },
      createAdapter: () => ({ generateChat: async () => ({ text: "synth narrative" }) }),
      calendarFollowThrough: buildCalendarFollowThroughPort({
        tasksRepository: tasksRepository ?? world.tasks
      })
    };
  }

  async function generateScheduled(
    definitionId: string,
    events: () => unknown[],
    tasksRepository?: TasksRepository,
    dayPlanAuto: BriefingDayPlanAutoPort = world.auto
  ) {
    return world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.briefings.generateRun(scopedDb, definitionId, {
        moduleManifests: fakeManifests(events),
        runKind: "scheduled",
        composeDeps: composeDeps(events, tasksRepository),
        dayPlanAuto
      })
    );
  }

  it("auto reserves blocks and dispatches a metadata-only job after commit", async () => {
    Object.assign(world.prefs, autoModes());
    const definition = await createDefinition(world.dataContext, world.briefings);
    const outcome = await generateScheduled(definition.id, () => [prepEvent(new Date())]);
    expect(outcome?.created).toBe(true);
    expect(outcome?.auto).toMatchObject({ planId: expect.any(String) });
    const auto = outcome!.auto!;
    expect(auto.batchKey).toBe(`day-plan-auto:${outcome!.run.id}`);

    const plan = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.plans.getById(scopedDb, auto.planId)
    );
    expect(plan?.blocks).toHaveLength(1);
    expect(plan?.blocks[0]?.pendingChange).toMatchObject({ kind: "add" });
    expect(plan?.blocks[0]?.taskId).toEqual(expect.any(String));
    expect(plan?.sourceRunId).toBe(outcome!.run.id);

    const batch = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.plans.getApplyBatch(scopedDb, { planId: auto.planId, idempotencyKey: auto.batchKey })
    );
    expect(batch?.items).toHaveLength(1);
    expect(batch?.items[0]?.outcome).toBe("pending");

    expect(world.dispatched).toHaveLength(0);
  });

  it("suggest appends proposals with no reservation and no job", async () => {
    Object.assign(world.prefs, {
      "calendar.prep_task_mode": "suggest",
      "calendar.time_block_mode": "suggest"
    });
    const definition = await createDefinition(world.dataContext, world.briefings);
    const events = () => {
      const first = prepEvent(new Date());
      const secondStart = new Date(new Date(first.endsAt).getTime() + 10 * 60_000);
      const secondEnd = new Date(secondStart.getTime() + 60 * 60_000);
      return [
        first,
        {
          id: "evt-followup-1",
          title: "Team standup",
          startsAt: secondStart.toISOString(),
          endsAt: secondEnd.toISOString(),
          attendeeCount: 4
        }
      ];
    };
    const outcome = await generateScheduled(definition.id, events);
    expect(outcome?.created).toBe(true);
    expect(outcome?.auto ?? null).toBeNull();

    const plans = await world.dataContext.withDataContext(userA(), async (scopedDb) => {
      const found = await world.plans.getForDay(scopedDb, {
        localDay: new Date().toISOString().slice(0, 10),
        timeZone: "UTC"
      });
      return found;
    });
    expect(plans?.blocks.length).toBeGreaterThan(0);
    for (const block of plans?.blocks ?? []) {
      expect(block.pendingChange).toMatchObject({ kind: "add" });
    }
    expect(world.dispatched).toHaveLength(0);
  });

  it("off creates nothing", async () => {
    Object.assign(world.prefs, {
      "calendar.prep_task_mode": "off",
      "calendar.time_block_mode": "off"
    });
    const definition = await createDefinition(world.dataContext, world.briefings);
    const outcome = await generateScheduled(definition.id, () => [prepEvent(new Date())]);
    expect(outcome?.created).toBe(true);
    expect(outcome?.auto ?? null).toBeNull();
    expect(world.dispatched).toHaveLength(0);
  });

  it("rolls back task, plan, block and reservation when task creation fails", async () => {
    Object.assign(world.prefs, autoModes());
    const definition = await createDefinition(world.dataContext, world.briefings);
    const failingTasks = {
      create: async () => {
        throw new Error("tasks are down");
      }
    } as unknown as TasksRepository;
    await expect(
      generateScheduled(definition.id, () => [prepEvent(new Date())], failingTasks)
    ).rejects.toThrow("tasks are down");
    const tasks = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.tasks.listVisible(scopedDb)
    );
    expect(tasks.filter((task) => task.source === "calendar")).toEqual([]);
    const plan = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.plans.getForDay(scopedDb, {
        localDay: new Date().toISOString().slice(0, 10),
        timeZone: "UTC"
      })
    );
    expect(plan).toBeUndefined();
  });

  it("dispatches the reserved batch after commit through the briefing worker", async () => {
    Object.assign(world.prefs, autoModes());
    const definition = await createDefinition(world.dataContext, world.briefings);
    const events = () => [prepEvent(new Date())];
    const handlers = new Map<string, (jobs: unknown[]) => Promise<unknown>>();
    const fakeBoss = {
      work: async (
        name: string,
        _opts: unknown,
        handler: (jobs: unknown[]) => Promise<unknown>
      ) => {
        handlers.set(name, handler);
        return `wid-${name}`;
      }
    };
    const seen: DayPlanApplyDispatchPayload[] = [];
    await registerBriefingsJobWorkers(fakeBoss as never, world.dataContext, {
      moduleManifests: getBuiltInModuleManifests(),
      composeDeps: composeDeps(events),
      dayPlanAuto: world.auto,
      dispatchDayPlanApply: async (payload) => {
        seen.push(payload);
        // After commit means after commit: the run row is already durable.
        const runs = await world.dataContext.withDataContext(userA(), (scopedDb) =>
          world.briefings.listRuns(scopedDb, definition.id)
        );
        expect(runs.some((run) => run.id === payload.briefingRunId)).toBe(true);
      }
    });
    const briefingWork = handlers.get("briefings-run");
    expect(briefingWork).toBeTruthy();
    const result = (await briefingWork!([
      {
        id: "job-briefing-1",
        data: {
          actorUserId: ids.userA,
          definitionId: definition.id,
          runKind: "scheduled",
          briefingType: "morning"
        }
      }
    ])) as {
      runId: string;
      created: boolean;
      auto: { planId: string; operationId: string; batchKey: string } | null;
    };
    expect(result.created).toBe(true);
    expect(result.auto).toMatchObject({ planId: expect.any(String) });
    // Exactly the five allowed keys: no handles, closures or transactions.
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(
      ["actorUserId", "briefingRunId", "idempotencyKey", "operationId", "planId"].sort()
    );
    expect(seen[0]).toMatchObject({
      actorUserId: ids.userA,
      planId: result.auto!.planId,
      operationId: result.auto!.operationId,
      idempotencyKey: result.auto!.batchKey,
      briefingRunId: result.runId
    });
  });

  it("a duplicate scheduled fire resumes the unfinished batch and appends nothing", async () => {
    Object.assign(world.prefs, autoModes());
    const definition = await createDefinition(world.dataContext, world.briefings);
    const events = () => [prepEvent(new Date())];
    const first = await generateScheduled(definition.id, events);
    expect(first?.created).toBe(true);
    const second = await generateScheduled(definition.id, events);
    expect(second?.created).toBe(false);
    expect(second?.auto?.operationId).toBe(first?.auto?.operationId);
    const plan = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.plans.getById(scopedDb, first!.auto!.planId)
    );
    expect(plan?.blocks).toHaveLength(1);
  });

  it("a revision race still persists the run with no dispatch", async () => {
    Object.assign(world.prefs, autoModes());
    const definition = await createDefinition(world.dataContext, world.briefings);
    const racingAuto: BriefingDayPlanAutoPort = {
      reserveAutoPlan: async () => ({
        planId: "00000000-0000-4000-8000-000000000010",
        autoBlockIds: [],
        suggestBlockIds: [],
        operationId: null,
        batchKey: null,
        revisionRace: true
      }),
      findUnfinishedBatch: async () => undefined
    };
    const outcome = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.briefings.generateRun(scopedDb, definition.id, {
        moduleManifests: fakeManifests(() => [prepEvent(new Date())]),
        runKind: "scheduled",
        composeDeps: composeDeps(() => [prepEvent(new Date())]),
        dayPlanAuto: racingAuto
      })
    );
    expect(outcome?.created).toBe(true);
    expect(outcome?.auto ?? null).toBeNull();
    expect(world.dispatched).toHaveLength(0);
  });

  it("an interactive draft save during generation still persists the run with no dispatch", async () => {
    Object.assign(world.prefs, autoModes());
    const definition = await createDefinition(world.dataContext, world.briefings);
    const events = () => [prepEvent(new Date())];
    // Seed today's plan so generation reads revision 1.
    const localDay = new Date().toISOString().slice(0, 10);
    const seeded = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.plans.createForDay(scopedDb, { localDay, timeZone: "UTC", sourceRunId: null })
    );
    let raced = false;
    const delegate = {
      getForDay: world.plans.getForDay.bind(world.plans),
      createForDay: world.plans.createForDay.bind(world.plans),
      appendBlocks: async (
        scopedDb: DataContextDb,
        input: Parameters<DayPlanRepository["appendBlocks"]>[1]
      ) => {
        if (!raced) {
          raced = true;
          // Interactive draft save commits on a separate connection between
          // the generation read and this append.
          await world.dataContext.withDataContext(userA(), (interactiveDb) =>
            world.plans.saveDraft(interactiveDb, {
              planId: input.planId,
              localDay: input.localDay,
              timeZone: input.timeZone,
              expectedRevision: input.expectedRevision,
              blocks: []
            })
          );
        }
        return world.plans.appendBlocks(scopedDb, input);
      },
      reserveApplyBatch: world.plans.reserveApplyBatch.bind(world.plans),
      getApplyBatch: world.plans.getApplyBatch.bind(world.plans)
    };
    const racingAuto: BriefingDayPlanAutoPort = {
      reserveAutoPlan: (scopedDb, input) => reserveAutoPlanBlocks(delegate, scopedDb, input),
      findUnfinishedBatch: (scopedDb, input) => world.auto.findUnfinishedBatch(scopedDb, input)
    };
    const outcome = await generateScheduled(definition.id, events, undefined, racingAuto);
    expect(raced).toBe(true);
    // The run still commits with its facts; nothing is dispatched.
    expect(outcome?.created).toBe(true);
    expect(outcome?.auto ?? null).toBeNull();
    expect(world.dispatched).toHaveLength(0);
    const plan = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.plans.getById(scopedDb, seeded.id)
    );
    expect(plan?.revision).toBe(2);
    expect(plan?.blocks).toHaveLength(0);
    const batch = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.plans.getApplyBatch(scopedDb, {
        planId: seeded.id,
        idempotencyKey: `day-plan-auto:${outcome!.run.id}`
      })
    );
    expect(batch).toBeUndefined();
  });

  it("denies a reserved batch after the tier is downgraded, with no provider call", async () => {
    const { buildDayPlanAutoApplyExecutor } = await import("@moss/chat");
    Object.assign(world.prefs, autoModes());
    const definition = await createDefinition(world.dataContext, world.briefings);
    const outcome = await generateScheduled(definition.id, () => [prepEvent(new Date())]);
    const auto = outcome!.auto!;
    const downgradedPrefs = prefsFake({
      "assistant.action_policy.v1.calendar.calendar_writeback": "ask_each_time"
    });
    const executor = buildDayPlanAutoApplyExecutor({
      dataContext: world.dataContext,
      connectorsRepository: {} as never,
      preferencesRepository: downgradedPrefs
    });
    const report = await executor({
      access: userA(),
      toolCtx: { actorUserId: ids.userA, requestId: "request:downgrade", chatSessionId: "" },
      planId: auto.planId,
      idempotencyKey: auto.batchKey,
      operationId: auto.operationId
    });
    expect(report.status).toBe("denied");
    expect(report.denialReason).toContain("trusted_auto");
  });

  it("executes a reserved batch through the same execution service", async () => {
    Object.assign(world.prefs, autoModes());
    const definition = await createDefinition(world.dataContext, world.briefings);
    const outcome = await generateScheduled(definition.id, () => [prepEvent(new Date())]);
    const auto = outcome!.auto!;
    const creates: string[] = [];
    const service = new ApplyExecutionService({
      dataContext: world.dataContext,
      batches: world.plans,
      findTask: async (scopedDb, taskId) => {
        const row = await world.tasks.getById(scopedDb, taskId);
        return row ? { id: row.id, ownerUserId: row.owner_user_id, status: row.status } : undefined;
      },
      accessGate: { checkAccess: async () => ({ ok: true as const }) },
      facts: { readAvailability: async () => ({ intervals: [], complete: true }) },
      writer: {
        createAddition: async (input) => {
          creates.push(input.provenance.blockId);
          return {
            created: true,
            resolvedStart: input.window.start.toISOString(),
            resolvedEnd: input.window.end.toISOString(),
            shifted: false,
            conflict: "none" as const,
            calendarEventId: "cache-1",
            calendarMirror: "written" as const
          };
        },
        lookupAddition: async () => ({ found: false as const }),
        moveBlockEvent: async () => {
          throw new Error("no moves on the automatic path");
        },
        removeBlockEvent: async () => {
          throw new Error("no removals on the automatic path");
        }
      }
    });
    const report = await service.executeReservedAdditions({
      access: userA(),
      toolCtx: { actorUserId: ids.userA, requestId: "request:execute", chatSessionId: "" },
      planId: auto.planId,
      idempotencyKey: auto.batchKey,
      operationId: auto.operationId
    });
    expect(report.status).toBe("completed");
    expect(creates).toHaveLength(1);
  });

  it("denies when the block task was deleted between commit and apply", async () => {
    Object.assign(world.prefs, autoModes());
    const definition = await createDefinition(world.dataContext, world.briefings);
    const outcome = await generateScheduled(definition.id, () => [prepEvent(new Date())]);
    const auto = outcome!.auto!;
    const plan = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      world.plans.getById(scopedDb, auto.planId)
    );
    const taskId = plan!.blocks[0]!.taskId!;
    const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query("DELETE FROM app.tasks WHERE id = $1", [taskId]);
    } finally {
      await bootstrap.end();
    }
    const service = new ApplyExecutionService({
      dataContext: world.dataContext,
      batches: world.plans,
      findTask: async (scopedDb, taskId) => {
        const row = await world.tasks.getById(scopedDb, taskId);
        return row ? { id: row.id, ownerUserId: row.owner_user_id, status: row.status } : undefined;
      },
      accessGate: { checkAccess: async () => ({ ok: true as const }) },
      facts: { readAvailability: async () => ({ intervals: [], complete: true }) },
      writer: {
        createAddition: async () => {
          throw new Error("must not create for a deleted task");
        },
        lookupAddition: async () => ({ found: false as const }),
        moveBlockEvent: async () => {
          throw new Error("no moves on the automatic path");
        },
        removeBlockEvent: async () => {
          throw new Error("no removals on the automatic path");
        }
      }
    });
    const report = await service.executeReservedAdditions({
      access: userA(),
      toolCtx: { actorUserId: ids.userA, requestId: "request:deleted-task", chatSessionId: "" },
      planId: auto.planId,
      idempotencyKey: auto.batchKey,
      operationId: auto.operationId
    });
    expect(report.status).toBe("denied");
  });

  it("composition emits intents with no provider call inside the transaction", async () => {
    let writes = 0;
    const port = buildCalendarFollowThroughPort({
      tasksRepository: world.tasks,
      calendarWrite: {
        createEvent: async () => {
          writes += 1;
          return { created: true, calendarEventId: "calendar-event-1" };
        }
      },
      aiRepository: {
        listActionPolicies: async () => [
          { moduleId: "calendar", actionFamilyId: "calendar_writeback", tier: "trusted_auto" }
        ]
      }
    } as never);
    const refs = await world.dataContext.withDataContext(userA(), (scopedDb) =>
      port.executeAutoActions({
        scopedDb,
        actorUserId: ids.userA,
        requestId: "request:boundary",
        targetRef: "calendar:prep:1",
        signal: {
          summary: "Prep",
          suggestedActions: ["create_task", "block_time"],
          startsAt: "2026-07-04T16:00:00.000Z",
          endsAt: "2026-07-04T17:00:00.000Z"
        }
      })
    );
    expect(writes).toBe(0);
    expect(refs.intents.map((intent) => intent.kind).sort()).toEqual(["block_time", "create_task"]);
  });

  it("the apply worker takes only metadata and fails closed without an executor", async () => {
    expect(
      isDayPlanApplyPayloadMetadataOnly({
        actorUserId: ids.userA,
        planId: randomUUID(),
        operationId: randomUUID(),
        idempotencyKey: "day-plan-auto:run-1",
        briefingRunId: randomUUID()
      })
    ).toBe(true);
    expect(
      isDayPlanApplyPayloadMetadataOnly({
        actorUserId: ids.userA,
        planId: randomUUID(),
        operationId: randomUUID(),
        idempotencyKey: "day-plan-auto:run-1",
        briefingRunId: randomUUID(),
        scopedDb: {}
      })
    ).toBe(false);

    const handlers = new Map<string, (jobs: unknown[]) => Promise<unknown>>();
    const fakeBoss = {
      work: async (
        name: string,
        _opts: unknown,
        handler: (jobs: unknown[]) => Promise<unknown>
      ) => {
        handlers.set(name, handler);
        return `wid-${name}`;
      }
    };
    await registerCalendarJobWorkers(fakeBoss as never, world.dataContext, {});
    const applyWork = handlers.get("calendar.day-plan-apply");
    expect(applyWork).toBeTruthy();
    const payload: DayPlanApplyJobPayload = {
      actorUserId: ids.userA,
      planId: randomUUID(),
      operationId: randomUUID(),
      idempotencyKey: "day-plan-auto:run-1",
      briefingRunId: randomUUID()
    };
    await expect(applyWork!([{ id: "job-apply-1", data: payload }])).rejects.toThrow(
      "day plan apply is unavailable"
    );
    await expect(
      applyWork!([{ id: "job-apply-2", data: { ...payload, scopedDb: {} } }])
    ).rejects.toThrow("non-metadata payload fields");
  });
});
