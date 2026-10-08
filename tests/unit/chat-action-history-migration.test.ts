import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../packages/chat/sql/0297_chat_action_history_permissions.sql", import.meta.url),
  "utf8"
)
  .replace(/--[^\n]*/g, "")
  .replace(/\s+/g, " ")
  .trim();

describe("chat action-history migration permissions", () => {
  it("grants only the two metadata UPDATE columns, with no DELETE or broad UPDATE grant", () => {
    expect(migration.match(/\bGRANT\b[^;]*;/gi)).toEqual([
      "GRANT UPDATE (tool_metadata, updated_at) ON app.chat_messages TO jarvis_app_runtime;"
    ]);
  });

  it("creates only the action-history UPDATE policy, with no DELETE policy", () => {
    const policies = migration.match(/\bCREATE POLICY\b[^;]*;/gi) ?? [];
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatch(
      /^CREATE POLICY chat_messages_action_history_update ON app\.chat_messages FOR UPDATE TO jarvis_app_runtime /i
    );
    expect(migration).not.toMatch(/\bFOR (?:DELETE|ALL)\b/i);
    expect(migration).not.toContain("chat_messages_action_history_delete");
  });
});
