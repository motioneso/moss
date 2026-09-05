import { describe, expect, it, vi } from "vitest";

import { AiRepository, createAiSecretCipher } from "@moss/ai";
import { createCliStructuredAdapterFactory, type ChatEngineFactory } from "@moss/chat";
import {
  buildEmailExtractDeps,
  runEmailMonitor,
  type EmailExtractDeps,
  type EmailTaskCreationPort
} from "@moss/connectors";
import { PreferencesRepository } from "@moss/structured-state";
import { TaskListsRepository, TasksRepository } from "@moss/tasks";

import {
  handles,
  ids,
  runGoogleSync,
  seedGoogleAccount
} from "./helpers/google-sync-orchestration.js";

const NOW = new Date("2026-08-01T04:00:00.000Z");
const MESSAGE_ID = "sync-monitor-actionable-1";
const SUBJECT = "Approval needed for the launch plan";
const BODY = "Please approve the launch plan today and reply when it is done.";
const ACTIONABLE_SIGNALS = {
  category: "needs_action",
  confidence: 0.95,
  reason: "The sender explicitly requests approval today.",
  action: "Approve the launch plan"
};

// The structured (schema-validated) path requires the first-pass gate (#2274). A maybe_owed row
// stores no verdict and no task: the thread judgement worker decides later.
const GATED_SIGNALS = { ...ACTIONABLE_SIGNALS, gate: "maybe_owed" };

const incompleteCompactExtractDeps: EmailExtractDeps = {
  runChat: async (_prompt, _signal, batchSize = 1) => {
    expect(batchSize).toBe(1);
    return {
      text: JSON.stringify({
        category: "needs_action",
        confidence: 0.9,
        reason: "The sender requests approval.",
        action: ""
      })
    };
  }
};

const actionableExtractDeps: EmailExtractDeps = {
  runChat: async (_prompt, _signal, batchSize = 1) => {
    expect(batchSize).toBe(1);
    return { text: JSON.stringify(ACTIONABLE_SIGNALS) };
  }
};

function googleClientFor(messageId: string) {
  const listMessageIds = vi.fn(async ({ query }: { query?: string }) =>
    query?.includes("older_than:1d") ? [] : [{ id: messageId }]
  );
  const getMessage = vi.fn(async () => ({
    id: messageId,
    threadId: `thread-${messageId}`,
    historyId: `history-${messageId}`,
    labelIds: ["INBOX"],
    internalDate: String(NOW.getTime() - 60_000),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: SUBJECT },
        { name: "From", value: "colleague@example.test" },
        { name: "To", value: "owner@example.test" }
      ],
      body: { data: Buffer.from(BODY).toString("base64") }
    }
  }));
  return { listCalendarEvents: async () => [], listMessageIds, getMessage };
}

function createTaskPort(
  tasksRepository: TasksRepository,
  afterCreate: () => void = () => undefined
): EmailTaskCreationPort {
  return {
    async create(scopedDb, input) {
      const task = await tasksRepository.create(scopedDb, {
        title: input.title,
        description: input.description ?? undefined,
        status: input.status,
        dueAt: input.dueAt ?? undefined,
        priority: input.priority ?? undefined,
        source: input.source,
        sourceRef: input.sourceRef,
        externalKey: input.externalKey,
        suggestionMetadata: input.suggestionMetadata
      });
      afterCreate();
      return { id: task.id };
    }
  };
}

async function setupAccount(requestId: string) {
  const accountId = await seedGoogleAccount(handles.dataContext, [
    "https://www.googleapis.com/auth/gmail.modify"
  ]);
  const context = { actorUserId: ids.userA, requestId };
  await handles.dataContext.withDataContext(context, (scopedDb) =>
    new TaskListsRepository().getOrCreateDefault(scopedDb)
  );
  return { accountId, context };
}

async function emailTaskCount(
  tasksRepository: TasksRepository,
  context: { actorUserId: string; requestId: string },
  messageId: string
) {
  const tasks = await handles.dataContext.withDataContext(context, (scopedDb) =>
    tasksRepository.listVisible(scopedDb)
  );
  return tasks.filter((task) => task.source === "email" && task.external_key?.includes(messageId))
    .length;
}

describe("Google sync → source context → email monitor", () => {
  it("projects actionable mail through the production CLI structured composition", async () => {
    const messageId = "sync-monitor-cli-structured";
    const { accountId, context } = await setupAccount("test:sync-monitor-cli-structured");
    const tasksRepository = new TasksRepository();
    const preferencesRepository = new PreferencesRepository();
    const aiRepository = new AiRepository();
    const aiCipher = createAiSecretCipher();
    await handles.dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "test:sync-monitor-cli-ai-config" },
      async (scopedDb) => {
        const provider = await aiRepository.createProvider(scopedDb, {
          providerKind: "anthropic",
          displayName: "CLI structured fixture",
          authMethod: "cli",
          encryptedCredential: aiCipher.encryptJson({ cli: true })
        });
        const model = await aiRepository.createModel(scopedDb, {
          providerConfigId: provider.id,
          providerModelId: "cli-structured-fixture",
          displayName: "CLI structured fixture",
          capabilities: ["summarization", "json"],
          tier: "economy"
        });
        await aiRepository.setServiceBinding(
          scopedDb,
          "module.connectors.email-extract",
          { kind: "model", modelId: model.id },
          ids.adminUser
        );
      }
    );
    const engineFactory: ChatEngineFactory = vi.fn(() => ({
      provider: "anthropic" as const,
      launch: vi.fn(async () => ({ offset: 0 })),
      submit: vi.fn(async () => undefined),
      readNew: vi.fn(async () => ({
        records: [{ kind: "reply" as const, text: JSON.stringify(GATED_SIGNALS) }],
        offset: 1,
        complete: true
      })),
      interrupt: vi.fn(async () => undefined),
      isAlive: vi.fn(async () => false),
      kill: vi.fn(async () => undefined)
    }));

    const sync = await handles.workerDataContext.withDataContext(context, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "fixture-token",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient: googleClientFor(messageId),
        emailExtractDeps: buildEmailExtractDeps(scopedDb, aiRepository, aiCipher, {
          createCliStructuredAdapter: createCliStructuredAdapterFactory(engineFactory)
        }),
        actionProjection: {
          taskPort: createTaskPort(tasksRepository),
          preferencesRepository,
          actorUserId: ids.userA
        },
        now: () => NOW
      })
    );

    expect(sync).toMatchObject({
      emailUpserted: 1,
      emailFailures: 0,
      errors: [],
      truncated: false
    });
    expect(await emailTaskCount(tasksRepository, context, messageId)).toBe(0);
    expect(engineFactory).toHaveBeenCalledTimes(1);
  });

  it("evaluates a recently synced actionable inbound email into one suggested task", async () => {
    const { accountId, context } = await setupAccount("test:sync-monitor-pipeline");
    const googleClient = googleClientFor(MESSAGE_ID);
    const tasksRepository = new TasksRepository();
    const taskPort = createTaskPort(tasksRepository);
    const preferencesRepository = new PreferencesRepository();

    const sync = await handles.workerDataContext.withDataContext(context, (scopedDb) =>
      runGoogleSync(scopedDb, {
        getFreshAccessToken: async () => "fixture-token",
        getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
        googleClient,
        emailExtractDeps: actionableExtractDeps,
        actionProjection: {
          taskPort,
          preferencesRepository,
          actorUserId: ids.userA
        },
        now: () => NOW
      })
    );
    expect(sync.emailUpserted).toBe(1);
    expect(await emailTaskCount(tasksRepository, context, MESSAGE_ID)).toBe(1);

    const monitor = await handles.dataContext.withDataContext(context, (scopedDb) =>
      runEmailMonitor(scopedDb, accountId, {
        taskPort,
        preferencesRepository,
        now: () => NOW
      })
    );

    expect(monitor).toMatchObject({ degraded: false });
    expect(googleClient.listMessageIds).toHaveBeenCalledTimes(2);
    expect(googleClient.getMessage).toHaveBeenCalledTimes(1);
    expect(await emailTaskCount(tasksRepository, context, MESSAGE_ID)).toBe(1);
  });

  it("recovers saved action projection on the next unchanged sync", async () => {
    const messageId = "sync-monitor-projection-recovery";
    const { accountId, context } = await setupAccount("test:sync-monitor-projection-recovery");
    const googleClient = googleClientFor(messageId);
    const tasksRepository = new TasksRepository();
    const preferencesRepository = new PreferencesRepository();
    let projectionFails = true;
    const taskPort = createTaskPort(tasksRepository, () => {
      if (projectionFails) throw new Error("fixture projection failure");
    });
    const sync = () =>
      handles.workerDataContext.withDataContext(context, (scopedDb) =>
        runGoogleSync(scopedDb, {
          getFreshAccessToken: async () => "fixture-token",
          getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
          googleClient,
          emailExtractDeps: actionableExtractDeps,
          actionProjection: {
            taskPort,
            preferencesRepository,
            actorUserId: ids.userA
          },
          now: () => NOW
        })
      );

    expect((await sync()).emailUpserted).toBe(1);
    expect(await emailTaskCount(tasksRepository, context, messageId)).toBe(0);

    projectionFails = false;
    expect((await sync()).emailUpserted).toBe(0);
    expect(await emailTaskCount(tasksRepository, context, messageId)).toBe(1);
  });

  it("re-extracts unchanged incomplete actionable triage before projecting once", async () => {
    const messageId = "sync-monitor-incomplete-triage";
    const { accountId, context } = await setupAccount("test:sync-monitor-incomplete-triage");
    const googleClient = googleClientFor(messageId);
    const tasksRepository = new TasksRepository();
    const preferencesRepository = new PreferencesRepository();
    const taskPort = createTaskPort(tasksRepository);
    const runSync = (emailExtractDeps: EmailExtractDeps) =>
      handles.workerDataContext.withDataContext(context, (scopedDb) =>
        runGoogleSync(scopedDb, {
          getFreshAccessToken: async () => "fixture-token",
          getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
          googleClient,
          emailExtractDeps,
          actionProjection: {
            taskPort,
            preferencesRepository,
            actorUserId: ids.userA
          },
          now: () => NOW
        })
      );

    expect((await runSync(incompleteCompactExtractDeps)).emailUpserted).toBe(1);
    expect(await emailTaskCount(tasksRepository, context, messageId)).toBe(0);

    const runChat = vi.fn(actionableExtractDeps.runChat);
    expect(
      (
        await runSync({
          ...actionableExtractDeps,
          runChat
        })
      ).emailUpserted
    ).toBe(1);
    expect(runChat).toHaveBeenCalledTimes(1);
    expect(await emailTaskCount(tasksRepository, context, messageId)).toBe(1);
  });
});
