import { afterEach, describe, expect, it, vi } from "vitest";

import { AiRepository } from "@moss/ai";
import { DEFAULT_CHAT_SURFACE } from "@moss/shared";
import { DataContextRunner, type ChatThread } from "@moss/db";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const actor = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-06T00:00:00Z");
const base: ChatThread = {
  id: "00000000-0000-4000-8000-000000000011",
  owner_user_id: actor,
  title: "Long conversation",
  surface: DEFAULT_CHAT_SURFACE,
  incognito: false,
  is_main: true,
  created_at: now,
  updated_at: now,
  last_active_at: now,
  conversation_summary: null,
  summary_covered_through_message_id: null,
  summary_revision: 0
};

const history = Array.from({ length: 60 }, (_, i) => ({
  id: `m${i + 1}`,
  thread_id: base.id,
  owner_user_id: actor,
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  body: `turn ${i + 1}`,
  status: "stored" as const,
  model_metadata: {},
  tool_metadata: {},
  created_at: now,
  updated_at: now
}));

function fixture(thread: ChatThread) {
  const { scoped } = makeRecordingDb();
  const repository = new ChatRepository();
  const dataContext = Object.create(DataContextRunner.prototype) as DataContextRunner;
  vi.spyOn(dataContext, "withDataContext").mockImplementation((_access, work) => work(scoped));
  vi.spyOn(repository, "getThreadById").mockResolvedValue(thread);
  vi.spyOn(repository, "listMessages").mockResolvedValue(history);
  vi.spyOn(console, "info").mockImplementation(() => {});
  return new DataContextChatPersistence({
    dataContext,
    chatRepository: repository,
    aiRepository: Object.create(AiRepository.prototype) as AiRepository
  });
}
afterEach(() => vi.restoreAllMocks());

async function replay(thread: ChatThread) {
  return fixture(thread).listPriorTurns(actor, { threadId: thread.id }, DEFAULT_CHAT_SURFACE);
}

describe("launch replay with an accepted summary frontier", () => {
  it("replays the accepted summary plus every uncovered turn, with no gap and no truncation", async () => {
    const result = await replay({
      ...base,
      conversation_summary: "Decided: the release ships on Friday.",
      summary_covered_through_message_id: "m10",
      summary_revision: 2
    });
    expect(result.oldSummary).toBe("Decided: the release ships on Friday.");
    expect(result.recent.map((m) => m.content)).toEqual(history.slice(10).map((m) => m.body));
  });

  it("ignores a legacy rolling summary and replays the whole stored history", async () => {
    const result = await replay({ ...base, conversation_summary: "As of turn 8: ..." });
    expect(result.oldSummary).toBeNull();
    expect(result.recent).toHaveLength(60);
  });

  it("ignores a summary whose frontier no longer exists", async () => {
    const result = await replay({
      ...base,
      conversation_summary: "Decided: blue",
      summary_covered_through_message_id: "deleted-message",
      summary_revision: 4
    });
    expect(result.oldSummary).toBeNull();
    expect(result.recent).toHaveLength(60);
  });

  it("replays nothing for a private conversation even with an accepted summary", async () => {
    const result = await replay({
      ...base,
      incognito: true,
      conversation_summary: "Decided: blue",
      summary_covered_through_message_id: "m10",
      summary_revision: 1
    });
    expect(result).toEqual({ recent: [], oldSummary: null });
  });
});
