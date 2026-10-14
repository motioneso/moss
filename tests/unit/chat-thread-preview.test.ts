import { describe, expect, it } from "vitest";
import { serializeThread } from "../../packages/chat/src/route-serializers.js";
import type { ChatThread } from "@moss/db";

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    owner_user_id: "user-1",
    title: "Old chat",
    incognito: false,
    is_main: false,
    surface: "drawer",
    conversation_summary: null,
    summary_covered_through_message_id: null,
    summary_revision: 0,
    created_at: new Date("2026-06-06T12:00:00.000Z"),
    updated_at: new Date("2026-06-06T12:00:00.000Z"),
    last_active_at: new Date("2026-06-06T12:00:00.000Z"),
    ...overrides
  } as ChatThread;
}

describe("serializeThread lastMessagePreview", () => {
  it("includes the durable Main designation", () => {
    expect(serializeThread(makeThread({ is_main: true })).isMain).toBe(true);
  });

  it("is null when there is no last message body", () => {
    const dto = serializeThread(makeThread());
    expect(dto.lastMessagePreview).toBeNull();
  });

  it("uses the first non-blank line of the last message body", () => {
    const dto = serializeThread({
      ...makeThread(),
      lastMessageBody: "\n\n  Second line onward is dropped  \nmore text"
    });
    expect(dto.lastMessagePreview).toBe("Second line onward is dropped");
  });

  it("caps a long preview at 140 characters with an ellipsis", () => {
    const long = "a".repeat(200);
    const dto = serializeThread({ ...makeThread(), lastMessageBody: long });
    expect(dto.lastMessagePreview).toHaveLength(141);
    expect(dto.lastMessagePreview!.endsWith("…")).toBe(true);
  });
});
