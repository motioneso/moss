import { afterEach, describe, expect, it, vi } from "vitest";

import { AiRepository } from "@moss/ai";
import { DEFAULT_CHAT_SURFACE } from "@moss/shared";
import { DataContextRunner, type ChatThread } from "@moss/db";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const actor = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-06T00:00:00Z");
const bound: ChatThread = {
  id: "00000000-0000-4000-8000-000000000011",
  owner_user_id: actor,
  title: "Bound conversation",
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

function fixture(thread: ChatThread | undefined = bound) {
  const { scoped } = makeRecordingDb();
  const repository = new ChatRepository();
  const dataContext = Object.create(DataContextRunner.prototype) as DataContextRunner;
  vi.spyOn(dataContext, "withDataContext").mockImplementation((_access, work) => work(scoped));
  const current = vi.spyOn(repository, "getCurrentThread").mockResolvedValue({
    ...bound,
    id: "00000000-0000-4000-8000-000000000012"
  });
  const byId = vi.spyOn(repository, "getThreadById").mockResolvedValue(thread);
  const messages = vi.spyOn(repository, "listMessages").mockResolvedValue([
    {
      id: "message-1",
      thread_id: bound.id,
      owner_user_id: actor,
      role: "user",
      body: "Original bound conversation",
      status: "stored",
      model_metadata: {},
      tool_metadata: {},
      created_at: now,
      updated_at: now
    }
  ]);
  const completed = vi.spyOn(repository, "recordCompletedTurn").mockResolvedValue(undefined);
  const handled = vi.spyOn(repository, "recordGateCompletedTurn").mockResolvedValue(undefined);
  const touched = vi.spyOn(repository, "touchCurrentThread").mockResolvedValue(thread);
  const selected = vi.spyOn(repository, "touchThread").mockResolvedValue(thread);
  const opened = vi.spyOn(repository, "openNewThread").mockResolvedValue(bound);
  vi.spyOn(console, "info").mockImplementation(() => {});
  const persistence = new DataContextChatPersistence({
    dataContext,
    chatRepository: repository,
    aiRepository: Object.create(AiRepository.prototype) as AiRepository
  });
  return {
    persistence,
    current,
    byId,
    messages,
    scoped,
    completed,
    handled,
    touched,
    opened,
    selected
  };
}
afterEach(() => vi.restoreAllMocks());

describe("conversation-bound launch replay", () => {
  it("replays only the captured thread when a different conversation became current", async () => {
    const { persistence, current, byId, messages, scoped } = fixture();
    expect(
      await persistence.listPriorTurns(actor, { threadId: bound.id }, DEFAULT_CHAT_SURFACE)
    ).toEqual({
      recent: [{ role: "user", content: "Original bound conversation" }],
      oldSummary: null
    });
    expect(byId).toHaveBeenCalledWith(scoped, bound.id, DEFAULT_CHAT_SURFACE);
    expect(messages).toHaveBeenCalledWith(scoped, bound.id);
    expect(current).not.toHaveBeenCalled();
  });

  it("explicit null replays nothing and does not look up the current thread", async () => {
    const { persistence, current, byId, messages } = fixture();
    expect(await persistence.listPriorTurns(actor, { threadId: null })).toEqual({
      recent: [],
      oldSummary: null
    });
    expect(current).not.toHaveBeenCalled();
    expect(byId).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign", { ...bound, owner_user_id: "other-owner" }],
    ["different surface", { ...bound, surface: "workshop" }],
    ["private", { ...bound, incognito: true }]
  ] as const)(
    "does not replay a %s bound thread or fall back to current",
    async (_label, thread) => {
      const { persistence, current, messages } = fixture(thread);
      expect(
        await persistence.listPriorTurns(actor, { threadId: bound.id }, DEFAULT_CHAT_SURFACE)
      ).toEqual({
        recent: [],
        oldSummary: null
      });
      expect(messages).not.toHaveBeenCalled();
      expect(current).not.toHaveBeenCalled();
    }
  );

  it("does not fall back when a bound thread was deleted", async () => {
    const { persistence, byId, current, messages } = fixture();
    byId.mockResolvedValue(undefined);
    expect(
      await persistence.listPriorTurns(actor, { threadId: bound.id }, DEFAULT_CHAT_SURFACE)
    ).toEqual({
      recent: [],
      oldSummary: null
    });
    expect(messages).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
  });

  it("retains current-thread lookup for existing callers that omit binding", async () => {
    const { persistence, byId, current, messages, scoped } = fixture();
    await persistence.listPriorTurns(actor, undefined, DEFAULT_CHAT_SURFACE);
    expect(current).toHaveBeenCalledWith(scoped, actor, DEFAULT_CHAT_SURFACE);
    expect(byId).not.toHaveBeenCalled();
    expect(messages).toHaveBeenCalledWith(scoped, "00000000-0000-4000-8000-000000000012");
  });
});

describe.each(["model", "gate"] as const)("conversation-bound %s completion", (kind) => {
  function complete(persistence: DataContextChatPersistence, threadId: string | null) {
    return kind === "model"
      ? persistence.recordTurn(
          actor,
          "question",
          "answer",
          { provider: "anthropic", model: "test" },
          { threadId },
          DEFAULT_CHAT_SURFACE
        )
      : persistence.recordHandledTurn(
          actor,
          "question",
          "answer",
          {
            version: 1,
            kind: "classifier_gate",
            decisionId: "test",
            moduleId: null,
            toolName: null,
            outcome: "executed-success"
          },
          { threadId },
          DEFAULT_CHAT_SURFACE
        );
  }

  it("persists to the captured conversation after the current conversation changes", async () => {
    const { persistence, current, byId, scoped, completed, handled, touched, opened, selected } =
      fixture();
    await complete(persistence, bound.id);
    expect(byId).toHaveBeenCalledWith(scoped, bound.id, DEFAULT_CHAT_SURFACE);
    expect(kind === "model" ? completed : handled).toHaveBeenCalledWith(
      scoped,
      bound.id,
      "question",
      "answer",
      expect.any(Object),
      expect.any(Object),
      DEFAULT_CHAT_SURFACE
    );
    expect(touched).toHaveBeenCalledWith(scoped, bound.id, DEFAULT_CHAT_SURFACE);
    expect(selected).not.toHaveBeenCalled();
    expect(touched.mock.invocationCallOrder[0]).toBeLessThan(
      (kind === "model" ? completed : handled).mock.invocationCallOrder[0]!
    );
    expect(current).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign", { ...bound, owner_user_id: "other-owner" }],
    ["different surface", { ...bound, surface: "workshop" }]
  ] as const)("does not persist to a %s bound thread or fall back", async (_label, thread) => {
    const { persistence, current, completed, handled, touched, opened } = fixture(thread);
    expect(await complete(persistence, bound.id)).toBeUndefined();
    expect(current).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(handled).not.toHaveBeenCalled();
    expect(touched).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });

  it.each(["null", "deleted"] as const)(
    "does not persist or fall back with a %s binding",
    async (state) => {
      const { persistence, byId, current, completed, handled, touched, opened } = fixture();
      byId.mockResolvedValue(undefined);
      expect(await complete(persistence, state === "null" ? null : bound.id)).toBeUndefined();
      expect(current).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      expect(handled).not.toHaveBeenCalled();
      expect(touched).not.toHaveBeenCalled();
      expect(opened).not.toHaveBeenCalled();
    }
  );
});
