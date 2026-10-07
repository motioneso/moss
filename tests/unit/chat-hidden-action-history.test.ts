import { describe, expect, it } from "vitest";

import { ChatRepository } from "../../packages/chat/src/repository.js";
import { chatMessagesQuery } from "../../packages/settings/src/data-export-queries.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const repository = new ChatRepository();
const owner = "00000000-0000-4000-8000-000000000001";
const threadId = "00000000-0000-4000-8000-000000000002";
const terminal = {
  kind: "action_result",
  actionRequestId: "action-1",
  text: "",
  outcome: "executed",
  decidedBy: "person"
};

function expectHiddenSyntheticFilter(statement: string) {
  expect(statement).toMatch(/NOT COALESCE\(/i);
  expect(statement).toMatch(/body"? = ''/);
  expect(statement).toMatch(/role"? = 'assistant'/);
  expect(statement).toMatch(/status"? = 'stored'/);
  expect(statement).toContain("->'actionOutcomeOnly' = 'true'::jsonb");
  expect(statement).toContain("->'actionOutcomeHidden' = 'true'::jsonb");
  expect(statement).toMatch(/false\s*\)/);
}

describe("retained action-only history", () => {
  it.each(["history", "message", "preview", "archive", "export"] as const)(
    "excludes only hidden synthetic rows from the compiled %s query",
    async (source) => {
      const { scoped, queries } = makeRecordingDb();
      switch (source) {
        case "history":
          await repository.listMessages(scoped, threadId);
          break;
        case "message":
          await repository.getMessageById(scoped, "message-1");
          break;
        case "preview":
          await repository.listThreads(scoped);
          break;
        case "archive":
          await repository.listStoredMessagesInRange(
            scoped,
            owner,
            "2026-10-01T00:00:00Z",
            "2026-11-01T00:00:00Z"
          );
          break;
        case "export":
          await chatMessagesQuery(owner).execute(scoped.db);
          break;
      }
      expect(queries).toHaveLength(1);
      expectHiddenSyntheticFilter(queries[0]!.sql);
    }
  );

  it("absorbs a result by updating metadata and never issuing DELETE or rewriting prose", async () => {
    const synthetic = {
      id: "synthetic-1",
      thread_id: threadId,
      owner_user_id: owner,
      role: "assistant",
      status: "stored",
      body: "",
      tool_metadata: {
        actionOutcomeOnly: true,
        selectedTools: [],
        activity: [terminal],
        actionResults: [terminal]
      }
    };
    const rows: Record<string, unknown>[] = [];
    const { scoped, queries } = makeRecordingDb({
      rows,
      beforeQuery: async (statement) => {
        const row = statement.includes('from "app"."chat_threads"')
          ? { id: threadId, owner_user_id: owner, incognito: false, surface: "drawer" }
          : synthetic;
        rows.splice(0, rows.length, row);
      }
    });
    await repository.recordCompletedTurn(
      scoped,
      threadId,
      "Create it",
      "Done",
      { provider: "fixture", model: "offline" },
      { activityRecords: [{ kind: "action_request", actionRequestId: "action-1", text: "Create" }] }
    );
    const update = queries.find((query) => query.sql.startsWith('update "app"."chat_messages"'));
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/set "tool_metadata" = \$1, "updated_at" = \$2 where/);
    expect(update!.parameters[0]).toEqual({
      ...synthetic.tool_metadata,
      actionOutcomeHidden: true
    });
    expect(update!.parameters).toContain(synthetic.id);
    expect(update!.parameters).toContain(threadId);
    expect(update!.parameters).toContain(owner);
    expect(queries.some((query) => /\bdelete\s+from\b/i.test(query.sql))).toBe(false);
    const matches = queries.find((query) =>
      query.sql.startsWith('select * from "app"."chat_messages"')
    );
    expectHiddenSyntheticFilter(matches!.sql);
    const assistantInsert = queries
      .filter((query) => query.sql.startsWith('insert into "app"."chat_messages"'))
      .at(-1)!;
    const savedMetadata = assistantInsert.parameters.find(
      (value) => value !== null && typeof value === "object" && "actionResults" in value
    );
    expect(savedMetadata).toEqual(expect.objectContaining({ actionResults: [terminal] }));
  });
});
