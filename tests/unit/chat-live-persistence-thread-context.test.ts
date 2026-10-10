import { describe, expect, it, vi } from "vitest";

import type { AccessContext, ChatThread, DataContextDb, DataContextRunner } from "@moss/db";
import { DEFAULT_CHAT_SURFACE } from "@moss/shared";
import { DataContextChatPersistence } from "@moss/chat";
import type { AiRepository } from "@moss/ai";
import type { ChatRepository } from "../../packages/chat/src/repository.js";
import { UnsupportedLegacyCliProviderError } from "../../packages/chat/src/live/errors.js";

function dataContext(): DataContextRunner {
  return {
    withDataContext: async <T>(
      _access: AccessContext,
      fn: (scopedDb: DataContextDb) => Promise<T>
    ) => fn({} as DataContextDb)
  } as unknown as DataContextRunner;
}

function chatRepository(thread: ChatThread | undefined): ChatRepository {
  return {
    getCurrentThread: async () => thread
  } as unknown as ChatRepository;
}

const BASE_THREAD: ChatThread = {
  id: "thread-1",
  owner_user_id: "user-1",
  title: "Conversation",
  surface: "chat",
  incognito: false,
  is_main: false,
  created_at: new Date(),
  updated_at: new Date(),
  last_active_at: new Date(),
  conversation_summary: null,
  summary_covered_through_message_id: null,
  summary_revision: 0
};

describe("DataContextChatPersistence.getThreadContext", () => {
  it("round-trips incognito: true from the current thread row", async () => {
    const persistence = new DataContextChatPersistence({
      dataContext: dataContext(),
      chatRepository: chatRepository({ ...BASE_THREAD, incognito: true }),
      aiRepository: {} as unknown as AiRepository
    });

    const context = await persistence.getThreadContext("user-1");

    expect(context.incognito).toBe(true);
  });

  it("round-trips incognito: false from the current thread row", async () => {
    const persistence = new DataContextChatPersistence({
      dataContext: dataContext(),
      chatRepository: chatRepository({ ...BASE_THREAD, incognito: false }),
      aiRepository: {} as unknown as AiRepository
    });

    const context = await persistence.getThreadContext("user-1");

    expect(context.incognito).toBe(false);
  });

  it("defaults to incognito: false when there is no current thread", async () => {
    const persistence = new DataContextChatPersistence({
      dataContext: dataContext(),
      chatRepository: chatRepository(undefined),
      aiRepository: {} as unknown as AiRepository
    });

    const context = await persistence.getThreadContext("user-1");

    expect(context.incognito).toBe(false);
  });
});

describe("DataContextChatPersistence.resolveActiveProvider", () => {
  it("keeps an unsupported legacy CLI provider fail-closed with actionable remediation", async () => {
    const persistence = new DataContextChatPersistence({
      dataContext: dataContext(),
      chatRepository: chatRepository(undefined),
      aiRepository: {
        selectChatModelForUser: async () =>
          ({
            provider_kind: "ollama",
            provider_auth_method: "cli",
            provider_acp_agent_id: null
          }) as never
      } as unknown as AiRepository
    });

    await expect(persistence.resolveActiveProvider("user-1")).rejects.toBeInstanceOf(
      UnsupportedLegacyCliProviderError
    );
  });
});

describe("bound thread context retrieval", () => {
  it("reads private A instead of a newly selected ordinary B", async () => {
    const getCurrentThread = vi.fn(async () => ({
      ...BASE_THREAD,
      id: "thread-b",
      surface: DEFAULT_CHAT_SURFACE,
      incognito: false
    }));
    const getThreadById = vi.fn(async () => ({
      ...BASE_THREAD,
      surface: DEFAULT_CHAT_SURFACE,
      incognito: true
    }));
    const persistence = new DataContextChatPersistence({
      dataContext: dataContext(),
      chatRepository: { getCurrentThread, getThreadById } as unknown as ChatRepository,
      aiRepository: {} as AiRepository
    });
    expect(
      (await persistence.getThreadContext("user-1", DEFAULT_CHAT_SURFACE, "thread-1")).incognito
    ).toBe(true);
    expect(getThreadById).toHaveBeenCalledWith(expect.anything(), "thread-1", DEFAULT_CHAT_SURFACE);
    expect(getCurrentThread).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["foreign", { ...BASE_THREAD, owner_user_id: "someone-else", surface: DEFAULT_CHAT_SURFACE }],
    ["wrong surface", { ...BASE_THREAD, surface: "workshop" }]
  ] as const)("refuses a %s bound thread", async (_label, thread) => {
    const persistence = new DataContextChatPersistence({
      dataContext: dataContext(),
      chatRepository: { getThreadById: async () => thread } as unknown as ChatRepository,
      aiRepository: {} as AiRepository
    });
    await expect(
      persistence.getThreadContext("user-1", DEFAULT_CHAT_SURFACE, "thread-1")
    ).rejects.toThrow("unavailable");
  });

  it("explicit missing binding never falls back to the actor's selected thread", async () => {
    const getCurrentThread = vi.fn(async () => BASE_THREAD);
    const persistence = new DataContextChatPersistence({
      dataContext: dataContext(),
      chatRepository: { getCurrentThread } as unknown as ChatRepository,
      aiRepository: {} as AiRepository
    });
    await expect(
      persistence.getThreadContext("user-1", DEFAULT_CHAT_SURFACE, null)
    ).rejects.toThrow("unavailable");
    expect(getCurrentThread).not.toHaveBeenCalled();
  });
});
