import { describe, expect, it } from "vitest";

import type { AccessContext, ChatThread, DataContextDb, DataContextRunner } from "@moss/db";
import { DataContextChatPersistence } from "@moss/chat";
import type { AiRepository } from "@moss/ai";
import type { ChatRepository } from "../../packages/chat/src/repository.js";

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
  created_at: new Date(),
  updated_at: new Date(),
  last_active_at: new Date(),
  conversation_summary: null
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
