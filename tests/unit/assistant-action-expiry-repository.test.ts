import { describe, expect, it } from "vitest";
import { AiRepository } from "../../packages/ai/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

describe("assistant-action lifecycle SQL", () => {
  it("atomically expires only the owned pending row at its durable deadline", async () => {
    const { scoped, queries } = makeRecordingDb();
    await new AiRepository().expireAssistantAction(scoped, "action-1");
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain(
      'where "id" = $2 and "status" = $3 and "expires_at" <= now()'
    );
    expect(queries[0]?.parameters).toEqual(["timed_out", "action-1", "pending"]);
  });

  it("guards confirmation itself with the durable deadline", async () => {
    const { scoped, queries } = makeRecordingDb();
    await new AiRepository().resolveAssistantAction(scoped, "action-1", { status: "confirmed" });
    expect(queries[0]?.sql).toContain(
      '"status" = $5 and ("expires_at" is null or "expires_at" > now())'
    );
    expect(queries[0]?.parameters[0]).toBe("confirmed");
  });

  it.each(["rejected", "cancelled"] as const)(
    "permits %s after expiry without overriding a terminal decision",
    async (status) => {
      const { scoped, queries } = makeRecordingDb();
      await new AiRepository().resolveAssistantAction(scoped, "action-1", { status });
      expect(queries[0]?.sql).toContain('"status" = $5');
      expect(queries[0]?.sql).not.toContain('"expires_at"');
      expect(queries[0]?.parameters.at(-1)).toBe("pending");
    }
  );

  it("stores only the supplied origin/deadline and filters history by exact thread", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [{ id: "action-1" }] });
    const repository = new AiRepository();
    const deadline = new Date("2026-10-07T12:00:00Z");
    await repository.createPendingAssistantAction(scoped, {
      toolModuleId: "notes",
      toolModuleName: "Notes",
      toolName: "notes.edit",
      permissionId: "notes.edit",
      risk: "write",
      inputSummary: {},
      chatThreadId: "conversation-a",
      chatSessionId: "owner-a:drawer",
      expiresAt: deadline
    });
    expect(queries[0]?.sql).toContain('"chat_thread_id", "chat_session_id", "expires_at"');
    expect(queries[0]?.parameters).toEqual(
      expect.arrayContaining(["conversation-a", "owner-a:drawer", deadline])
    );
    await repository.listAssistantActions(scoped, "conversation-a");
    expect(queries[1]?.sql).toContain('where "chat_thread_id" = $1');
    expect(queries[1]?.parameters).toEqual(["conversation-a"]);
  });
});
