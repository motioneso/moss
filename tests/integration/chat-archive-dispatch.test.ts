import { beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { ChatRepository, DataContextChatPersistence } from "@moss/chat";
import { AiRepository } from "@moss/ai";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("chat turn-hook archive-day dispatch", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;
  let aiRepository: AiRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
    aiRepository = new AiRepository();
  });

  it("dispatches the archive-day job only when archiving is enabled and the thread is not incognito", async () => {
    function fakeLocalePreferences(store: Map<string, unknown>) {
      return {
        get: async (_scopedDb: unknown, key: string) => store.get(key) ?? null,
        getWithMetadata: async () => null,
        upsert: async (_scopedDb: unknown, key: string, value: unknown) => {
          store.set(key, value);
        }
      };
    }

    // Enabled + non-incognito turn: the job is sent with today's local date.
    const enabledSent: Array<{
      readonly queue: string;
      readonly payload: Record<string, unknown>;
    }> = [];
    const enabledStore = new Map<string, unknown>([
      ["chat-archive.enabled", true],
      ["locale", { timezone: "UTC" }]
    ]);
    const enabledPersistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: repository,
      aiRepository,
      localePreferences: fakeLocalePreferences(enabledStore) as never,
      boss: {
        send: async (queue: string, payload: Record<string, unknown>) => {
          enabledSent.push({ queue, payload });
          return "job-id";
        }
      } as never
    });
    await enabledPersistence.openNewConversation(ids.userA);
    await enabledPersistence.recordTurn(ids.userA, "Archive this please.", "Noted.", {
      provider: "anthropic",
      model: "claude-economy"
    });
    const archiveCall = enabledSent.find((call) => call.queue === "chat.archive-day");
    expect(archiveCall).toBeDefined();
    expect(archiveCall?.payload).toEqual(
      expect.objectContaining({
        actorUserId: ids.userA,
        localDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
      })
    );

    // Archiving disabled: no archive job sent (embed/extract jobs still are).
    const disabledSent: Array<{
      readonly queue: string;
      readonly payload: Record<string, unknown>;
    }> = [];
    const disabledStore = new Map<string, unknown>([["chat-archive.enabled", false]]);
    const disabledPersistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: repository,
      aiRepository,
      localePreferences: fakeLocalePreferences(disabledStore) as never,
      boss: {
        send: async (queue: string, payload: Record<string, unknown>) => {
          disabledSent.push({ queue, payload });
          return "job-id";
        }
      } as never
    });
    await disabledPersistence.openNewConversation(ids.userA);
    await disabledPersistence.recordTurn(ids.userA, "Do not archive this.", "Noted.", {
      provider: "anthropic",
      model: "claude-economy"
    });
    expect(disabledSent.find((call) => call.queue === "chat.archive-day")).toBeUndefined();

    // Incognito thread: no archive job sent even though archiving is enabled
    // (falls under the existing !thread.incognito guard).
    const incognitoSent: Array<{
      readonly queue: string;
      readonly payload: Record<string, unknown>;
    }> = [];
    const incognitoStore = new Map<string, unknown>([
      ["chat-archive.enabled", true],
      ["locale", { timezone: "UTC" }]
    ]);
    const incognitoPersistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: repository,
      aiRepository,
      localePreferences: fakeLocalePreferences(incognitoStore) as never,
      boss: {
        send: async (queue: string, payload: Record<string, unknown>) => {
          incognitoSent.push({ queue, payload });
          return "job-id";
        }
      } as never
    });
    await incognitoPersistence.openNewConversation(ids.userA, { incognito: true });
    await incognitoPersistence.recordTurn(ids.userA, "Incognito, do not archive.", "Noted.", {
      provider: "anthropic",
      model: "claude-economy"
    });
    expect(incognitoSent).toEqual([]);
  });
});
