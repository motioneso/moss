import { describe, expect, it } from "vitest";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { chatMessagesQuery } from "../../packages/settings/src/data-export-queries.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const repository = new ChatRepository();
const owner = "00000000-0000-4000-8000-000000000001";
const thread = "00000000-0000-4000-8000-000000000002";

describe("chat message timestamp ties", () => {
  it.each(["reload", "archive", "export"] as const)(
    "%s keeps the user before the reply and uses IDs only within equal roles",
    async (source) => {
      const { scoped, queries } = makeRecordingDb();
      if (source === "reload") await repository.listMessages(scoped, thread);
      else if (source === "archive")
        await repository.listStoredMessagesInRange(
          scoped,
          owner,
          "2026-10-01T00:00:00Z",
          "2026-11-01T00:00:00Z"
        );
      else await chatMessagesQuery(owner).execute(scoped.db);
      expect(queries).toHaveLength(1);
      const statement = queries[0]!.sql.replaceAll('"', "").replace(/\s+/g, " ");
      expect(statement).toMatch(
        source === "archive"
          ? /order by threadFirstMessageAt, m\.created_at, CASE WHEN m\.role = 'user' THEN 0 ELSE 1 END, m\.id/i
          : /order by created_at, CASE WHEN role = 'user' THEN 0 ELSE 1 END, id/i
      );
    }
  );

  it("keeps the reply first in the newest-message preview", async () => {
    const { scoped, queries } = makeRecordingDb();
    await repository.listThreads(scoped);
    expect(queries[0]!.sql.replaceAll('"', "")).toContain(
      "order by created_at desc, CASE WHEN role = 'user' THEN 0 ELSE 1 END desc, id desc limit"
    );
  });

  it("uses an ID tie-break when selecting one assistant message for a late action", async () => {
    const { scoped, queries } = makeRecordingDb({
      rows: [{ id: thread, owner_user_id: owner, incognito: false, tool_metadata: {} }]
    });
    await repository.persistActionRecord(scoped, owner, thread, {
      kind: "action_result",
      actionRequestId: "order-fixture-action",
      text: "",
      outcome: "executed"
    });
    const matching = queries.find((query) => query.sql.includes('from "app"."chat_messages"'));
    expect(matching?.sql.replaceAll('"', "")).toContain(
      "order by CASE WHEN tool_metadata->>'actionOutcomeOnly' = 'true' THEN 1 ELSE 0 END, created_at desc, id desc limit"
    );
  });
});
