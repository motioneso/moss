/**
 * #2764: the morning briefing reads tasks completed since the owner's previous succeeded
 * morning run. Covers the real previous-run lookup under RLS, which the unit tests stub.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import type { GenerateChatInput } from "@moss/ai";
import type { BriefingsRepository } from "@moss/briefings";
import type { AccessContext, DataContextRunner, MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { TasksRepository } from "@moss/tasks";

import { ids } from "./test-database.js";
import {
  makeComposeDeps,
  setupBriefingsHarness,
  teardownBriefingsHarness,
  userAContext,
  userBContext,
  type BriefingsTestHarness
} from "./briefings.helpers.js";

const moduleManifests = getBuiltInModuleManifests();

describe("morning briefing tasks since the previous morning run (#2764)", () => {
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
    await teardownBriefingsHarness({ server, appBoss, workerBoss, appDb, workerDb });
  });

  async function runMorning(context: AccessContext, definitionId: string): Promise<string> {
    let prompt = "";
    const deps = makeComposeDeps(async (input: GenerateChatInput) => {
      prompt = input.messages[0]!.content;
      return { text: "MORNING SYNTH OK" };
    });
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
    const result = await dataContext.withDataContext(context, (db) =>
      repository.generateRun(db, definitionId, {
        moduleManifests,
        runKind: "manual",
        composeDeps: deps
      })
    );
    expect(result!.run.status).toBe("succeeded");
    return prompt;
  }

  async function morningDefinition(context: AccessContext): Promise<string> {
    const definition = await dataContext.withDataContext(context, (db) =>
      repository.createDefinition(db, {
        title: "Morning",
        briefingType: "morning",
        selectedToolNames: ["tasks.list"]
      })
    );
    return definition.id;
  }

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

  async function completeTask(title: string): Promise<void> {
    const tasks = new TasksRepository();
    const updateStatus = moduleManifests
      .flatMap((m) => m.assistantTools ?? [])
      .find((t) => t.name === "tasks.updateStatus")!;
    const task = await dataContext.withDataContext(userAContext(), (db) =>
      tasks.create(db, { title })
    );
    await dataContext.withDataContext(userAContext(), (db) =>
      updateStatus.execute!(db, { taskId: task.id, status: "done" }, toolCtx)
    );
  }

  function tasksBlock(prompt: string): string {
    return (
      prompt.match(/<external_source type="tasks">\n([\s\S]*?)\n<\/external_source>/)?.[1] ?? ""
    );
  }

  it("reads completed tasks from the owner's previous morning run onward", async () => {
    const definitionA = await morningDefinition(userAContext());

    await completeTask("cutoff-before-first-run");
    const first = tasksBlock(await runMorning(userAContext(), definitionA));
    // No earlier morning run, so the last day counts.
    expect(first).toContain("[completed since last briefing] cutoff-before-first-run");

    await completeTask("cutoff-after-first-run");
    // Another owner's newer morning run must not move this owner's cutoff.
    await runMorning(userBContext(), await morningDefinition(userBContext()));

    const second = tasksBlock(await runMorning(userAContext(), definitionA));
    expect(second).toContain("[completed since last briefing] cutoff-after-first-run");
    expect(second).not.toContain("cutoff-before-first-run");
  });
});
