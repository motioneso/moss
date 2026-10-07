import { describe, expect, it } from "vitest";
import { AiRepository } from "../../packages/ai/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

describe("assistant-action lifecycle SQL", () => {
  it("bounds recovery to due pending requests and unwritten bound timeouts", async () => {
    const { scoped, queries } = makeRecordingDb();
    await new AiRepository().listRecoverableAssistantActions(scoped, 1000, "previous-timeout");
    expect(queries[0]?.sql).toContain('"status" = $1 and "expires_at" <= now()');
    expect(queries[1]?.sql).toContain(
      '"status" = $1 and "outcome_recorded_at" is null and "outcome_ignored_at" is null and "chat_thread_id" is not null and "chat_session_id" is not null and "id" > $2'
    );
    expect(queries[0]?.sql).toContain('order by "expires_at", "id" limit $2');
    expect(queries[0]?.parameters).toEqual(["pending", 25]);
    expect(queries[1]?.sql).toContain('order by "id" limit $3');
    expect(queries[1]?.parameters).toEqual(["timed_out", "previous-timeout", 25]);
  });

  it("reads only the nearest future expiry and acknowledges only a terminal timeout", async () => {
    const { scoped, queries } = makeRecordingDb();
    const repository = new AiRepository();
    await repository.nextAssistantActionExpiry(scoped);
    expect(queries[0]?.sql).toContain('select "expires_at"');
    expect(queries[0]?.sql).toContain('"expires_at" > now() order by "expires_at" limit $2');
    expect(queries[0]?.parameters).toEqual(["pending", 1]);
    await repository.markAssistantActionOutcomeRecorded(scoped, "action-1");
    expect(queries[1]?.sql).toContain(
      'set "outcome_recorded_at" = now() where "id" = $1 and "status" = $2 and "outcome_recorded_at" is null and "outcome_ignored_at" is null'
    );
    expect(queries[1]?.parameters).toEqual(["action-1", "timed_out"]);
    await repository.markAssistantActionOutcomeIgnored(scoped, "action-2");
    expect(queries[2]?.sql).toContain(
      'set "outcome_ignored_at" = now() where "id" = $1 and "status" = $2 and "outcome_recorded_at" is null and "outcome_ignored_at" is null'
    );
    expect(queries[2]?.parameters).toEqual(["action-2", "timed_out"]);
  });

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
