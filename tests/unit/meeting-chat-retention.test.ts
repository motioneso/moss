import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@moss/db";
import { AiRepository, createAiSecretCipher } from "@moss/ai";
import { MemoryGraphRepository } from "@moss/memory";
import { meetingChatSurface } from "@moss/shared";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { createChatFeedbackTargetVerifier } from "../../packages/chat/src/feedback-verifier.js";
import { handleExtractFactsJob } from "../../packages/chat/src/jobs.js";
import { deleteMeetingChatThreads } from "../../packages/chat/src/meeting-chat-boundary.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const meetingId = "12345678-1234-4234-9234-123456789abc";
function message(role: "user" | "assistant"): ChatMessage {
  return {
    id: role,
    thread_id: "thread",
    owner_user_id: "owner",
    role,
    status: "stored",
    body: "private recorded text",
    tool_metadata: { meetingChatV1: {} },
    model_metadata: {},
    created_at: new Date("2026-10-03T12:00:00Z"),
    updated_at: new Date("2026-10-03T12:00:00Z")
  };
}
afterEach(() => vi.restoreAllMocks());

describe("meeting-derived chat retention boundaries", () => {
  it("excludes meeting surfaces from general automatic archive selection", async () => {
    const { scoped, queries } = makeRecordingDb();
    await new ChatRepository().listStoredMessagesInRange(
      scoped,
      "owner",
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z"
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('"t"."surface" not like');
    expect(queries[0]?.parameters).toContain("mtg-%");
  });
  it("deletes all derived meeting threads on the canonical surface in the caller transaction", async () => {
    const { scoped, queries } = makeRecordingDb();
    await deleteMeetingChatThreads(scoped, meetingId);
    expect(queries[0]?.sql).toContain("SELECT app.delete_meeting_chat_threads_for_cleanup(");
    expect(queries[0]?.parameters).toEqual([meetingChatSurface(meetingId)]);
  });
  it("rejects meeting-message remember and feedback before exposing an excerpt", async () => {
    const repository = new ChatRepository();
    vi.spyOn(repository, "getMessageById").mockResolvedValue(message("user"));
    const thread = vi.spyOn(repository, "getThreadById");
    const { scoped } = makeRecordingDb();
    const result = await createChatFeedbackTargetVerifier(repository)(scoped, {
      actorUserId: "owner",
      targetKind: "chat_message",
      targetRef: "user",
      surface: "chat"
    });
    expect(result).toBeNull();
    expect(thread).not.toHaveBeenCalled();
  });
  it("refuses meeting-derived text in the memory worker even if handed its message IDs", async () => {
    const repository = new ChatRepository();
    vi.spyOn(repository, "getThreadById").mockResolvedValue(undefined);
    vi.spyOn(repository, "listMessages").mockResolvedValue([message("user"), message("assistant")]);
    const episode = vi.spyOn(MemoryGraphRepository.prototype, "createEpisode");
    const { scoped } = makeRecordingDb();
    await handleExtractFactsJob(
      scoped,
      "owner",
      {
        actorUserId: "owner",
        threadId: "thread",
        userMessageId: "user",
        assistantMessageId: "assistant"
      },
      { aiRepository: new AiRepository(), cipher: createAiSecretCipher() },
      repository
    );
    expect(episode).not.toHaveBeenCalled();
  });
});
