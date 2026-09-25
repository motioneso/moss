import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import type { GenerateChatInput } from "@moss/ai";
import { type BriefingsRepository } from "@moss/briefings";
import type { DataContextRunner } from "@moss/db";
import type { MossDatabase, BriefingRun } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { EVENING_SECTION_HEADERS, EVENING_FALLBACK_QUESTIONS } from "@moss/shared";
import { connectionStrings, ids } from "./test-database.js";
import {
  makeComposeDeps,
  setupBriefingsHarness,
  sourceIds,
  teardownBriefingsHarness,
  userAContext,
  userBContext,
  type BriefingsTestHarness
} from "./briefings.helpers.js";
import { defaultToolNamesFor } from "../../packages/briefings/src/routes.js";
import { TasksRepository } from "@moss/tasks";

const { Client } = pg;
const moduleManifests = getBuiltInModuleManifests();

describe("evening briefing compose (spec 2026-07-02, #695)", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: BriefingsRepository;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let server: BriefingsTestHarness["server"];

  beforeAll(async () => {
    const harness = await setupBriefingsHarness();
    appDb = harness.appDb;
    workerDb = harness.workerDb;
    dataContext = harness.dataContext;
    repository = harness.repository;
    appBoss = harness.appBoss;
    workerBoss = harness.workerBoss;
    server = harness.server;
  });

  afterAll(async () => {
    await teardownBriefingsHarness({
      server,
      appBoss,
      workerBoss,
      appDb,
      workerDb
    });
  });

  async function runEvening(opts?: {
    now?: Date;
    selectedToolNames?: string[];
    generateChat?: (input: GenerateChatInput) => Promise<{ text: string }>;
  }): Promise<{ run: BriefingRun; prompt: string }> {
    let prompt = "";
    const deps = makeComposeDeps(
      opts?.generateChat ??
        (async (input) => {
          prompt = input.messages[0]!.content;
          return { text: "EVENING SYNTH OK" };
        })
    );
    // @ts-expect-error mock
    deps.aiRepository = {
      selectModelForCapability: async () => ({
        provider_config_id: "test",
        provider_kind: "anthropic",
        id: "test",
        display_name: "test",
        tier: "economy"
      }),
      selectProviderWithCredential: async () => ({
        encrypted_credential: await deps.cipher.encryptJson({ apiKey: "canary-key" })
      })
    } as unknown;
    const definition = await dataContext.withDataContext(userAContext(), (db) =>
      repository.createDefinition(db, {
        title: "Evening",
        briefingType: "evening",
        selectedToolNames: opts?.selectedToolNames ?? defaultToolNamesFor("evening")
      })
    );
    const result = await dataContext.withDataContext(userAContext(), (db) =>
      repository.generateRun(db, definition.id, {
        moduleManifests,
        runKind: "manual",
        composeDeps: deps,
        // @ts-expect-error test harness hack to inject now
        now: opts?.now
      })
    );
    return { run: result!.run, prompt };
  }

  async function runEveningAsUserB(opts?: {
    selectedToolNames?: string[];
    generateChat?: (input: GenerateChatInput) => Promise<{ text: string }>;
  }): Promise<{ run: BriefingRun; prompt: string }> {
    let prompt = "";
    const deps = makeComposeDeps(
      opts?.generateChat ??
        (async (input) => {
          prompt = input.messages[0]!.content;
          return { text: "EVENING SYNTH OK" };
        })
    );
    // @ts-expect-error mock
    deps.aiRepository = {
      selectModelForCapability: async () => ({
        provider_config_id: "test",
        provider_kind: "anthropic",
        id: "test",
        display_name: "test",
        tier: "economy"
      }),
      selectProviderWithCredential: async () => ({
        encrypted_credential: await deps.cipher.encryptJson({ apiKey: "canary-key" })
      })
    } as unknown;
    const definition = await dataContext.withDataContext(userBContext(), (db) =>
      repository.createDefinition(db, {
        title: "Evening",
        briefingType: "evening",
        selectedToolNames: opts?.selectedToolNames ?? defaultToolNamesFor("evening")
      })
    );
    const result = await dataContext.withDataContext(userBContext(), (db) =>
      repository.generateRun(db, definition.id, {
        moduleManifests,
        runKind: "manual",
        composeDeps: deps
      })
    );
    return { run: result!.run, prompt };
  }

  it("emits the evening channel set in order, with no vault block even when vault is selected", async () => {
    const { run, prompt } = await runEvening({
      selectedToolNames: [...defaultToolNamesFor("evening"), "vault"]
    });
    if (run.status !== "succeeded") {
      console.log("RUN BLOCKED REASON:", run.source_metadata);
    }
    expect(run.status).toBe("succeeded");
    const order = [
      "tasks_reconciliation",
      "commitments",
      "calendar_tomorrow",
      "email_today",
      "chats"
    ].map((key) => prompt.indexOf(`<external_source type="${key}">`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).not.toContain('<external_source type="vault">');
    expect(prompt).toContain("<trusted_instructions>");
  });

  it("reconciles tasks into tagged lenses", async () => {
    const tasksRepo = new TasksRepository();
    const updateStatusTool = moduleManifests
      .flatMap((m) => m.assistantTools ?? [])
      .find((t) => t.name === "tasks.updateStatus")!;
    const toolCtx = {
      runId: "test",
      userId: ids.userA,
      actorUserId: ids.userA,
      authId: "test",
      contextType: "manual" as const,
      vaultRecordIds: [],
      requestId: "req",
      chatSessionId: "chat-1"
    };

    // Completed today
    const completedTask = await dataContext.withDataContext(userAContext(), (db) =>
      tasksRepo.create(db, { title: "evening-done-task" })
    );
    await dataContext.withDataContext(userAContext(), (db) =>
      updateStatusTool.execute!(db, { taskId: completedTask.id, status: "done" }, toolCtx)
    );

    // Slipped (due today)
    const now = new Date();
    await dataContext.withDataContext(userAContext(), (db) =>
      tasksRepo.create(db, { title: "evening-due-today-task", dueAt: now.toISOString() })
    );

    // Carrying forward (overdue)
    const overdue = new Date(now.getTime() - 48 * 3_600_000);
    await dataContext.withDataContext(userAContext(), (db) =>
      tasksRepo.create(db, { title: "evening-overdue-task", dueAt: overdue.toISOString() })
    );

    const { prompt } = await runEvening();
    expect(prompt).toContain("[completed today] evening-done-task");
    expect(prompt).toContain("[slipped] evening-due-today-task");
    expect(prompt).toContain("[carrying forward] evening-overdue-task");
  });

  it("always records the unwired news gap and evening count metadata", async () => {
    const { run } = await runEvening();
    const meta = run.source_metadata as Record<string, unknown>;
    expect(meta.gaps).toContainEqual({ source: "news", reason: "unwired" });
    expect(typeof meta.taskCompletedCount).toBe("number");
    expect(typeof meta.taskSlippedCount).toBe("number");
    expect(typeof meta.taskCarryCount).toBe("number");
    expect(typeof meta.tomorrowEventCount).toBe("number");
    expect(meta.morningRunReferenced).toBe(false);
  });

  it("still succeeds on an empty day (no data): blocks present with '(none today)'", async () => {
    const { run, prompt } = await runEveningAsUserB();
    expect(run.status).toBe("succeeded");
    expect(prompt).toContain('<external_source type="tasks_reconciliation">\n(none today)');
    expect(prompt).toContain('<external_source type="calendar_tomorrow">\n(none today)');
  });

  it("degrades to the evening-vocabulary fallback with the two canned questions", async () => {
    const { run } = await runEvening({
      generateChat: async () => {
        throw new Error("synth down");
      }
    });
    expect(run.status).toBe("succeeded");
    for (const header of Object.values(EVENING_SECTION_HEADERS)) {
      expect(run.summary_text).toContain(header);
    }
    for (const q of EVENING_FALLBACK_QUESTIONS) {
      expect(run.summary_text).toContain(q);
    }
    const meta = run.source_metadata as Record<string, unknown>;
    expect(meta.degraded).toBe(true);
    expect(meta.degradedReason).toBe("synthesis_failed");
  });

  it("filters out earlier-today calendar events and yesterday's emails", async () => {
    // Seed an email for yesterday and an event for earlier today.
    const now = new Date("2026-06-07T20:00:00.000Z");

    // User A already has an email seeded at '2026-06-06T15:00:00.000Z' (yesterday).
    // Let's seed a calendar event for earlier today ('2026-06-07T10:00:00.000Z').
    const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        `INSERT INTO app.calendar_events (id, connector_account_id, owner_user_id, title, starts_at, ends_at, external_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          "10000000-0000-4000-8000-000000000999",
          sourceIds.userAConnector,
          ids.userA,
          "Earlier today event",
          "2026-06-07T10:00:00.000Z",
          "2026-06-07T11:00:00.000Z",
          "ext_evt_earlier_today"
        ]
      );
    } finally {
      await bootstrap.end();
    }

    const { prompt } = await runEvening({ now });

    // The email from yesterday should not appear
    expect(prompt).not.toContain("User A briefing email");
    // The event from earlier today should not appear
    expect(prompt).not.toContain("Earlier today event");
  });

  it("cross-references the same-local-day morning run as a context-only morning_plan block", async () => {
    // Generate a morning run first (same user, manual) with seeded calendar/email so its
    // metadata carries calendarSignals/emailSignals, then the evening run.
    const morningDef = await dataContext.withDataContext(userAContext(), (db) =>
      repository.createDefinition(db, {
        title: "Morning",
        briefingType: "morning",
        selectedToolNames: defaultToolNamesFor("morning")
      })
    );
    await dataContext.withDataContext(userAContext(), (db) =>
      repository.generateRun(db, morningDef.id, {
        moduleManifests,
        runKind: "manual",
        composeDeps: makeComposeDeps(async () => ({ text: "MORNING OK" }))
      })
    );

    const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        `UPDATE app.briefing_runs SET source_metadata = $1 WHERE definition_id = $2`,
        [
          JSON.stringify({
            calendarSignals: [{ summary: "Mock morning calendar signal" }],
            emailSignals: [{ summary: "Mock morning email signal" }]
          }),
          morningDef.id
        ]
      );
    } finally {
      await bootstrap.end();
    }

    const { run, prompt } = await runEvening();
    expect(prompt).toContain('<external_source type="morning_plan">');
    expect(prompt).toContain("Mock morning calendar signal");
    expect(prompt).toContain("Mock morning email signal");
    expect((run.source_metadata as Record<string, unknown>).morningRunReferenced).toBe(true);
  });

  it("omits morning_plan (no block, no gap) when no same-day morning run exists", async () => {
    const { run, prompt } = await runEveningAsUserB(); // userB has no morning run
    expect(prompt).not.toContain('<external_source type="morning_plan">');
    const meta = run.source_metadata as Record<string, unknown>;
    expect(meta.morningRunReferenced).toBe(false);
    expect(meta.gaps).not.toContainEqual(expect.objectContaining({ source: "morning_plan" }));
  });

  it("RLS: another user cannot read an evening run or its definition", async () => {
    const { run } = await runEvening();
    const stolenRun = await dataContext.withDataContext(userBContext(), (db) =>
      repository.getOwnedRunById(db, run.id)
    );
    expect(stolenRun).toBeUndefined();
    const stolenDef = await dataContext.withDataContext(userBContext(), (db) =>
      repository.getOwnedDefinitionById(db, run.definition_id)
    );
    expect(stolenDef).toBeUndefined();
  });
});
