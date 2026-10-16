import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AiRepository, createAiSecretCipher, type StructuredProviderAdapter } from "@moss/ai";
import { ChatRepository, registerChatRoutes } from "@moss/chat";
import {
  AuthSessionResolver,
  createDatabase,
  DataContextRunner,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { SettingsRepository } from "@moss/settings";
import { CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY } from "@moss/shared";
import { TasksRepository } from "@moss/tasks";

import { resolveEffectiveGateMode } from "../../packages/chat/src/classifier-shadow-review-repository.js";
import type { ChatEngineFactory } from "../../packages/chat/src/live/runtime.js";
import type { CliChatEngine } from "../../packages/chat/src/live/types.js";
import { createActiveModulesResolver } from "../../packages/module-registry/src/active-modules-resolver.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #3529: public creation oracle for one-time task checks. Real routes, runtime,
// resolver, validation, repositories, persistence and queue run here. Only the
// external structured-model adapter and the chat engine are scripted fakes.

const { Client } = pg;

const ABSENT_TASK_ID = "22222222-2222-4222-8222-222222222222";
const INVALID_REFUSAL =
  "I didn't set a check. Name one task you own and one supported time or cadence; I can only read its status.";
const UNAVAILABLE_REFUSAL =
  "I couldn't set that check right now, so nothing is set. Try again in a moment.";
const STORAGE_FAILURE = "I couldn't save that reminder, so nothing is set. Try again in a moment.";
const TASK_TITLE = "Synthetic task";

// External structured-model script, swapped per case. Admissions are counted
// before any scripted behavior runs.
type AdapterScript =
  | { readonly kind: "text"; readonly rawText: string }
  | { readonly kind: "throw" }
  | { readonly kind: "wait-abort-reject" }
  | { readonly kind: "wait-abort-resolve"; readonly rawText: string };

const structured = {
  admissions: 0,
  script: { kind: "text", rawText: "{}" } as AdapterScript,
  entered: null as null | { promise: Promise<void>; resolve: () => void }
};

function armEntrySignal(): Promise<void> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  structured.entered = { promise, resolve };
  return promise;
}

const createCliStructuredAdapter = (): StructuredProviderAdapter => ({
  async generateStructured(input) {
    structured.admissions += 1;
    structured.entered?.resolve();
    const script = structured.script;
    if (script.kind === "throw") throw new Error("synthetic structured execution failure");
    if (script.kind === "text")
      return { rawText: script.rawText, usage: { inputTokens: 0, outputTokens: 0 } };
    const signal = input.signal;
    if (!signal) throw new Error("adapter received no abort signal");
    return new Promise((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        if (script.kind === "wait-abort-reject") {
          const error = new Error("synthetic abort");
          error.name = "AbortError";
          rejectPromise(error);
        } else {
          resolvePromise({
            rawText: script.rawText,
            usage: { inputTokens: 0, outputTokens: 0 }
          });
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }
});

// External chat engine sentinel. Construction is recorded separately from
// launch and submit attempts, which always fail after being recorded.
const engineAttempts = { constructed: 0, launches: 0, submits: 0 };

class SentinelEngine implements CliChatEngine {
  constructor(public readonly provider: CliChatEngine["provider"]) {}
  async launch(): Promise<{ offset: number }> {
    engineAttempts.launches += 1;
    throw new Error("n3 fake engine launch sentinel");
  }
  async submit(): Promise<void> {
    engineAttempts.submits += 1;
    throw new Error("n3 fake engine submit sentinel");
  }
  async interrupt(): Promise<void> {}
  async readNew(afterOffset: number) {
    return { records: [], offset: afterOffset, complete: false };
  }
  async isAlive(): Promise<boolean> {
    return false;
  }
  async kill(): Promise<void> {}
}

const sentinelEngineFactory: ChatEngineFactory = (provider) => {
  engineAttempts.constructed += 1;
  return new SentinelEngine(provider);
};

let appDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let boss: PgBoss;
let bootstrap: pg.Client;
let server: FastifyInstance;
let originalFetch: typeof fetch;
let previousSecretKey: string | undefined;

const chat = new ChatRepository();
const tasks = new TasksRepository();
const ai = new AiRepository();

let ownedTaskId = "";
let foreignTaskId = "";
let mainThreadId = "";
const queueInventory: Record<string, Record<string, number>> = {};

function asActor<T>(
  actorUserId: string,
  requestId: string,
  work: (db: DataContextDb) => Promise<T>
): Promise<T> {
  return app.withDataContext({ actorUserId, requestId }, work);
}

async function setGateMode(mode: "off" | "shadow" | "on"): Promise<void> {
  await asActor(ids.adminUser, "n3:gate-mode", (db) =>
    new SettingsRepository().upsertInstanceSetting(db, {
      key: CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY,
      value: { value: mode },
      updatedByUserId: ids.adminUser,
      requestId: "n3:gate-mode"
    })
  );
}

interface Snapshot {
  readonly reminders: ReadonlySet<string>;
  readonly scheduledReads: number;
  readonly jobs: ReadonlyMap<string, number>;
  readonly messages: number;
}

async function snapshot(): Promise<Snapshot> {
  const reminders = await bootstrap.query<{ id: string }>(
    "SELECT id FROM app.chat_reminders WHERE owner_user_id = $1",
    [ids.userA]
  );
  const scheduled = await bootstrap.query<{ n: string }>(
    "SELECT count(*) AS n FROM app.chat_scheduled_reads WHERE owner_user_id = $1",
    [ids.userA]
  );
  const jobs = await bootstrap.query<{ name: string; n: string }>(
    "SELECT name, count(*) AS n FROM pgboss.job WHERE data->>'actorUserId' = $1 GROUP BY name",
    [ids.userA]
  );
  const messages = await asActor(ids.userA, "n3:snapshot", (db) =>
    chat.listMessages(db, mainThreadId)
  );
  return {
    reminders: new Set(reminders.rows.map((row) => row.id)),
    scheduledReads: Number(scheduled.rows[0]!.n),
    jobs: new Map(jobs.rows.map((row) => [row.name, Number(row.n)])),
    messages: messages.length
  };
}

function jobDelta(before: Snapshot, after: Snapshot, name: string): number {
  return (after.jobs.get(name) ?? 0) - (before.jobs.get(name) ?? 0);
}

function recordInventory(caseId: string, before: Snapshot, after: Snapshot): void {
  const names = new Set([...before.jobs.keys(), ...after.jobs.keys()]);
  const deltas: Record<string, number> = {};
  for (const name of names) {
    const delta = jobDelta(before, after, name);
    if (delta !== 0) deltas[name] = delta;
  }
  queueInventory[caseId] = deltas;
}

async function newAssistantBodies(before: Snapshot): Promise<string[]> {
  const messages = await asActor(ids.userA, "n3:messages", (db) =>
    chat.listMessages(db, mainThreadId)
  );
  return messages
    .slice(before.messages)
    .filter((message) => message.role === "assistant")
    .map((message) => message.body);
}

function resetCounts(): void {
  structured.admissions = 0;
  structured.entered = null;
  engineAttempts.constructed = 0;
  engineAttempts.launches = 0;
  engineAttempts.submits = 0;
}

function answer(taskId: string, timingRequest: string): AdapterScript {
  return { kind: "text", rawText: JSON.stringify({ taskId, timingRequest }) };
}

async function turn(text: string): Promise<{ statusCode: number; reply: string; body: string }> {
  const response = await server.inject({
    method: "POST",
    url: "/api/chat/turn",
    headers: { authorization: `Bearer ${ids.sessionA}` },
    payload: { text }
  });
  const reply = ((): string => {
    try {
      return response.json<{ reply?: string }>().reply ?? "";
    } catch {
      return "";
    }
  })();
  return { statusCode: response.statusCode, reply, body: response.body };
}

async function expectNoSavedCheck(
  caseId: string,
  before: Snapshot,
  after: Snapshot
): Promise<void> {
  expect(after.reminders.size).toBe(before.reminders.size);
  expect(after.scheduledReads).toBe(before.scheduledReads);
  expect(jobDelta(before, after, "chat.scheduled-read")).toBe(0);
  expect(jobDelta(before, after, "chat.deliver-reminder")).toBe(0);
  recordInventory(caseId, before, after);
}

function expectNoFallback(admissions: number): void {
  expect(structured.admissions).toBe(admissions);
  expect(engineAttempts.launches).toBe(0);
  expect(engineAttempts.submits).toBe(0);
}

interface OwnedTeardown {
  readonly name: string;
  readonly close: () => Promise<unknown>;
}

// Attempts every owned teardown, then fails loudly naming each resource that
// did not close. Cleanup failure must never leave this suite green.
async function closeOwnedResources(resources: readonly OwnedTeardown[]): Promise<void> {
  const results = await Promise.allSettled(
    resources.map((resource) => Promise.resolve().then(() => resource.close()))
  );
  const failures = resources.flatMap((resource, index) => {
    const result = results[index]!;
    return result.status === "rejected" ? [{ name: resource.name, reason: result.reason }] : [];
  });
  if (failures.length === 0) return;
  for (const failure of failures) {
    const errorName = failure.reason instanceof Error ? failure.reason.name : "UnknownError";
    console.error(`N3_TEARDOWN_FAILURE resource=${failure.name} error=${errorName}`);
  }
  throw new Error(
    `owned teardown failed for: ${failures.map((failure) => failure.name).join(", ")}`
  );
}

beforeAll(async () => {
  // Import-time scratch isolation is established by the gate start command,
  // before this module was imported. Assert the inherited receipt here.
  const root = process.env.N3_RUN_ROOT;
  expect(root, "N3_RUN_ROOT must be set by the gate start command").toBeTruthy();
  expect(process.env.TMPDIR).toBe(join(root!, "tmp"));
  expect(tmpdir()).toBe(join(root!, "tmp"));
  expect(process.env.MOSS_CHAT_HOME).toBe(join(root!, "chat-home"));
  expect(process.env.MOSS_CLI_HOME_BASE).toBe(join(root!, "cli-home"));
  console.log(`N3_OWNED_ROOT=${root} N3_TMPDIR=${process.env.TMPDIR}`);

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("n3 fixture forbids network fetch");
  }) as typeof fetch;

  previousSecretKey = process.env.JARVIS_AI_SECRET_KEY;
  process.env.JARVIS_AI_SECRET_KEY = "test-n3-terminal-creation-secret";

  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 3 });
  app = new DataContextRunner(appDb);
  boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await Promise.all([boss.start(), bootstrap.connect()]);

  // Synthetic CLI-marker provider and economy JSON/chat model, bound for the
  // chat module and for sorting, under the seeded admin. Test rows only.
  const { providerId, modelId, providerModelId } = await asActor(
    ids.adminUser,
    "n3:seed-ai",
    async (db) => {
      const provider = await ai.createProvider(db, {
        providerKind: "anthropic",
        displayName: "N3 synthetic provider",
        authMethod: "cli",
        acpAgentId: "claude-acp",
        encryptedCredential: createAiSecretCipher().encryptJson({ cli: true })
      });
      const model = await ai.createModel(db, {
        providerConfigId: provider.id,
        providerModelId: "n3-synthetic-economy",
        displayName: "N3 synthetic economy",
        capabilities: ["json", "chat"],
        tier: "economy"
      });
      await ai.setServiceBinding(
        db,
        "module.chat",
        { kind: "model", modelId: model.id },
        ids.adminUser
      );
      await ai.setServiceBinding(
        db,
        "sorting",
        { kind: "model", modelId: model.id },
        ids.adminUser
      );
      return {
        providerId: provider.id,
        modelId: model.id,
        providerModelId: "n3-synthetic-economy"
      };
    }
  );
  expect(providerId).toBeTruthy();

  // The reviewed selection that lets a stored gate mode of "on" run as "on".
  await asActor(ids.adminUser, "n3:seed-review", async (db) => {
    await db.db
      .insertInto("app.chat_classifier_shadow_reviews")
      .values({
        classifier_model_id: modelId,
        classifier_provider_model_id: providerModelId,
        reviewed_by_user_id: ids.adminUser
      })
      .execute();
  });

  ownedTaskId = await asActor(ids.userA, "n3:seed-task", async (db) => {
    const task = await tasks.create(db, { title: TASK_TITLE });
    return task.id;
  });
  foreignTaskId = await asActor(ids.userB, "n3:seed-foreign-task", async (db) => {
    const task = await tasks.create(db, { title: "Foreign synthetic task" });
    return task.id;
  });
  mainThreadId = await asActor(ids.userA, "n3:seed-main", async (db) => {
    const existing = await chat.getMainThread(db, ids.userA);
    const thread = existing ?? (await chat.openNewThread(db, { title: "Main" }));
    await chat.touchThread(db, thread.id);
    return thread.id;
  });

  const sessions = new AuthSessionResolver(appDb);
  server = Fastify({ logger: false });
  registerChatRoutes(server, {
    rootDb: appDb,
    resolveAccessContext: async (request): Promise<AccessContext> => {
      const header = request.headers.authorization ?? "";
      const token = header.toLowerCase().startsWith("bearer ")
        ? header.slice(header.indexOf(" ") + 1).trim()
        : "";
      return sessions.resolveAccessContext(token, request.id);
    },
    dataContext: app,
    repository: chat,
    chatEngineFactory: sentinelEngineFactory,
    createCliStructuredAdapter,
    resolveActiveModules: createActiveModulesResolver({
      dataContext: app,
      manifests: () => getBuiltInModuleManifests()
    }),
    // Configuration only. The fake engine never connects anywhere.
    mcpServerUrl: "http://127.0.0.1:9/mcp",
    boss
  });
  await server.ready();
});

afterAll(async () => {
  console.log(`N3_QUEUE_INVENTORY=${JSON.stringify(queueInventory)}`);
  try {
    await closeOwnedResources([
      ...(server ? [{ name: "fastify server", close: () => server.close() }] : []),
      ...(boss
        ? [{ name: "pg-boss app client", close: () => boss.stop({ graceful: false }) }]
        : []),
      ...(appDb ? [{ name: "app database pool", close: () => appDb.destroy() }] : []),
      ...(bootstrap ? [{ name: "bootstrap pg client", close: () => bootstrap.end() }] : [])
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousSecretKey === undefined) delete process.env.JARVIS_AI_SECRET_KEY;
    else process.env.JARVIS_AI_SECRET_KEY = previousSecretKey;
  }
});

describe("terminal one-time task-check creation (#3529)", () => {
  it("teardown control attempts every owned resource and reports a rejection by name", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const attempted: string[] = [];
    try {
      await expect(
        closeOwnedResources([
          {
            name: "fake-first",
            close: async () => {
              attempted.push("fake-first");
              throw new Error("synthetic close failure");
            }
          },
          {
            name: "fake-second",
            close: async () => {
              attempted.push("fake-second");
            }
          }
        ])
      ).rejects.toThrow("owned teardown failed for: fake-first");
      expect(attempted).toHaveLength(2);
      expect(attempted).toEqual(expect.arrayContaining(["fake-first", "fake-second"]));
      expect(errorLog).toHaveBeenCalledWith("N3_TEARDOWN_FAILURE resource=fake-first error=Error");
      await expect(
        closeOwnedResources([{ name: "fake-ok", close: async () => {} }])
      ).resolves.toBeUndefined();
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each(["off", "shadow", "on"] as const)(
    "P1 refuses an absent task selection terminally in gate mode %s",
    async (mode) => {
      await setGateMode(mode);
      if (mode === "on") {
        const effective = await asActor(ids.userA, "n3:effective-mode", (db) =>
          resolveEffectiveGateMode(db, "on", { classifierDeps: { repository: ai } })
        );
        expect(effective).toBe("on");
      }
      resetCounts();
      structured.script = answer(ABSENT_TASK_ID, "remind me in 30 minutes to check task");
      const before = await snapshot();
      const result = await turn(`Check my ${TASK_TITLE} in 30 minutes`);
      const after = await snapshot();

      expectNoFallback(1);
      expect(result.statusCode).toBe(200);
      expect(result.reply).toBe(INVALID_REFUSAL);
      expect(await newAssistantBodies(before)).toEqual([INVALID_REFUSAL]);
      await expectNoSavedCheck(`P1-${mode}`, before, after);
    }
  );

  async function refusalCase(
    caseId: string,
    script: AdapterScript,
    expectedReply: string,
    text = `Check my ${TASK_TITLE} in 30 minutes`
  ): Promise<void> {
    await setGateMode("off");
    resetCounts();
    structured.script = script;
    const before = await snapshot();
    const result = await turn(text);
    const after = await snapshot();
    expectNoFallback(1);
    expect(result.statusCode).toBe(200);
    expect(result.reply).toBe(expectedReply);
    expect(await newAssistantBodies(before)).toEqual([expectedReply]);
    await expectNoSavedCheck(caseId, before, after);
  }

  it("P2 refuses an empty task selection terminally", async () => {
    await refusalCase(
      "P2-empty",
      answer("", "remind me in 30 minutes to check task"),
      INVALID_REFUSAL
    );
  });

  it("P2 refuses a foreign task selection without disclosure", async () => {
    await setGateMode("off");
    resetCounts();
    structured.script = answer(foreignTaskId, "remind me in 30 minutes to check task");
    const before = await snapshot();
    const result = await turn(`Check my ${TASK_TITLE} in 30 minutes`);
    const after = await snapshot();
    expectNoFallback(1);
    expect(result.reply).toBe(INVALID_REFUSAL);
    expect(result.reply).not.toContain("Foreign");
    await expectNoSavedCheck("P2-foreign", before, after);
  });

  it("P3 refuses raw non-JSON model output as unavailable", async () => {
    await refusalCase("P3-not-json", { kind: "text", rawText: "not-json" }, UNAVAILABLE_REFUSAL);
  });

  it("P3 refuses model output with an extra property as unavailable", async () => {
    await refusalCase(
      "P3-extra",
      {
        kind: "text",
        rawText: JSON.stringify({
          taskId: ownedTaskId,
          timingRequest: "remind me in 30 minutes to check task",
          extra: "nope"
        })
      },
      UNAVAILABLE_REFUSAL
    );
  });

  it("P4 refuses a repeating timing for a one-time request", async () => {
    await refusalCase(
      "P4-repeat-timing",
      answer(ownedTaskId, "remind me every day to check task"),
      INVALID_REFUSAL
    );
  });

  it("P4 refuses timing without supported reminder wording", async () => {
    await refusalCase(
      "P4-plain-timing",
      answer(ownedTaskId, "check task in 30 seconds"),
      INVALID_REFUSAL,
      `Check my ${TASK_TITLE} in 30 seconds`
    );
  });

  it("P5 refuses a structured execution failure as unavailable", async () => {
    await refusalCase("P5-throw", { kind: "throw" }, UNAVAILABLE_REFUSAL);
  });

  async function cancelCase(caseId: string, script: AdapterScript): Promise<void> {
    await setGateMode("off");
    resetCounts();
    structured.script = script;
    const entered = armEntrySignal();
    const before = await snapshot();
    const pending = turn(`Check my ${TASK_TITLE} in 30 minutes`);
    await entered;
    const cancel = await server.inject({
      method: "POST",
      url: "/api/chat/turn/cancel",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(cancel.statusCode).toBe(200);
    const result = await pending;
    const after = await snapshot();
    expectNoFallback(1);
    expect(result.reply).toBe("");
    expect(after.messages).toBe(before.messages);
    await expectNoSavedCheck(caseId, before, after);
  }

  it("P6 cancels a pending interpretation that rejects on abort", async () => {
    await cancelCase("P6-reject", { kind: "wait-abort-reject" });
  });

  it("P6 cancels a pending interpretation that resolves late on abort", async () => {
    await cancelCase("P6-late", {
      kind: "wait-abort-resolve",
      rawText: JSON.stringify({
        taskId: ABSENT_TASK_ID,
        timingRequest: "remind me in 30 minutes to check task"
      })
    });
  });

  async function expectSavedCheck(caseId: string, before: Snapshot, after: Snapshot) {
    const newIds = [...after.reminders].filter((id) => !before.reminders.has(id));
    expect(newIds).toHaveLength(1);
    const reminderId = newIds[0]!;
    expect(after.scheduledReads).toBe(before.scheduledReads + 1);
    expect(jobDelta(before, after, "chat.scheduled-read")).toBe(1);
    expect(jobDelta(before, after, "chat.deliver-reminder")).toBe(0);
    recordInventory(caseId, before, after);
    const operation = await bootstrap.query(
      "SELECT operation, item_id FROM app.chat_scheduled_reads WHERE reminder_id = $1",
      [reminderId]
    );
    expect(operation.rows).toEqual([{ operation: "tasks.get", item_id: ownedTaskId }]);
    const reminder = await bootstrap.query(
      `SELECT reminder_text, timing, delay_seconds, local_due, time_zone,
              repeat_kind, repeat_seconds, version
         FROM app.chat_reminders WHERE id = $1`,
      [reminderId]
    );
    const job = await bootstrap.query(
      "SELECT data FROM pgboss.job WHERE name = 'chat.scheduled-read' AND data->>'resourceId' = $1",
      [reminderId]
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]!.data).toEqual({
      actorUserId: ids.userA,
      resourceId: reminderId,
      version: reminder.rows[0]!.version
    });
    return reminder.rows[0]!;
  }

  it("P7 saves a one-time check in 30 minutes with its source operation and job", async () => {
    await setGateMode("off");
    resetCounts();
    structured.script = answer(ownedTaskId, "remind me in 30 minutes to check task");
    const before = await snapshot();
    const result = await turn(`Check my ${TASK_TITLE} in 30 minutes`);
    const after = await snapshot();
    const expected = `I'll check ${TASK_TITLE} once in 1800 seconds and report its status here.`;
    expectNoFallback(1);
    expect(result.statusCode).toBe(200);
    expect(result.reply).toBe(expected);
    expect(await newAssistantBodies(before)).toEqual([expected]);
    const row = await expectSavedCheck("P7", before, after);
    expect(row.reminder_text).toBe(`Check task status: ${TASK_TITLE}`);
    expect(row.delay_seconds).toBe(1800);
  });

  it("P8 saves a clock-time check with the persisted local time and zone", async () => {
    await setGateMode("off");
    resetCounts();
    structured.script = answer(ownedTaskId, "remind me tomorrow at 17:00 to check task");
    const before = await snapshot();
    const result = await turn(`Check my ${TASK_TITLE} tomorrow at 17:00`);
    const after = await snapshot();
    expectNoFallback(1);
    expect(result.statusCode).toBe(200);
    expect(result.reply.startsWith(`I'll check ${TASK_TITLE} once`)).toBe(true);
    expect(result.reply).toContain("(America/Los_Angeles)");
    const row = await expectSavedCheck("P8", before, after);
    expect(row.timing).toBe("local_clock");
    expect(row.local_due).toMatch(/T17:00$/);
    expect(row.time_zone).toBe("America/Los_Angeles");
  });

  it("P9 returns the unsaved receipt when reminder storage fails", async () => {
    await bootstrap.query(
      `CREATE OR REPLACE FUNCTION app.n3_terminal_storage_fault_3529() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.owner_user_id = '${ids.userA}' AND NEW.role = 'assistant'
            AND current_setting('app.request_id', true) = 'chat-live:record-reminder-turn' THEN
           RAISE EXCEPTION 'n3 synthetic storage fault';
         END IF;
         RETURN NEW;
       END $$`
    );
    await bootstrap.query(
      "DROP TRIGGER IF EXISTS n3_terminal_storage_fault_3529 ON app.chat_messages"
    );
    await bootstrap.query(
      `CREATE TRIGGER n3_terminal_storage_fault_3529 BEFORE INSERT ON app.chat_messages
       FOR EACH ROW EXECUTE FUNCTION app.n3_terminal_storage_fault_3529()`
    );
    try {
      await setGateMode("off");
      resetCounts();
      structured.script = answer(ABSENT_TASK_ID, "remind me in 30 minutes to check task");
      const before = await snapshot();
      const result = await turn(`Check my ${TASK_TITLE} in 30 minutes`);
      const after = await snapshot();
      expectNoFallback(1);
      expect(result.reply).toBe(STORAGE_FAILURE);
      expect(after.messages).toBe(before.messages);
      await expectNoSavedCheck("P9", before, after);
    } finally {
      await bootstrap.query(
        "DROP TRIGGER IF EXISTS n3_terminal_storage_fault_3529 ON app.chat_messages"
      );
      await bootstrap.query("DROP FUNCTION IF EXISTS app.n3_terminal_storage_fault_3529()");
    }
    const triggers = await bootstrap.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'n3_terminal_storage_fault_3529'"
    );
    expect(Number(triggers.rows[0]!.n)).toBe(0);
  });

  it("P10 keeps a valid repeating check on its existing saved path", async () => {
    await setGateMode("off");
    resetCounts();
    structured.script = answer(ownedTaskId, "remind me every 60 seconds to check task");
    const before = await snapshot();
    const result = await turn(`Check my ${TASK_TITLE} every 60 seconds`);
    const after = await snapshot();
    expectNoFallback(1);
    expect(result.statusCode).toBe(200);
    expect(result.reply).toContain("The first check will establish a quiet baseline");
    const row = await expectSavedCheck("P10", before, after);
    expect(row.repeat_kind).toBe("interval");
    expect(row.repeat_seconds).toBe(60);
  });

  it("P10 refuses an unsupported monthly check before interpretation", async () => {
    await setGateMode("off");
    resetCounts();
    structured.script = answer(ownedTaskId, "remind me every month to check task");
    const before = await snapshot();
    const result = await turn(`Check my ${TASK_TITLE} monthly`);
    const after = await snapshot();
    expectNoFallback(0);
    expect(result.reply).toBe(INVALID_REFUSAL);
    await expectNoSavedCheck("P10-monthly", before, after);
  });
});
