import { describe, expect, it } from "vitest";

import { parseTranscript } from "../../packages/ai/src/adapters/transcript-reader.js";

function assistantLine(opts: { readonly stopReason: string; readonly content: unknown[] }): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", stop_reason: opts.stopReason, content: opts.content },
    uuid: "u1",
    timestamp: "2026-09-02T00:00:00.000Z"
  });
}

describe("parseTranscript — #2164 r21 (item 3) toolName carry-through", () => {
  it("carries the tool name on an anthropic tool_use event", () => {
    const jsonl =
      assistantLine({
        stopReason: "tool_use",
        content: [{ type: "tool_use", name: "read_note", input: {} }]
      }) + "\n";
    const result = parseTranscript("anthropic", jsonl, 0);
    const toolEvent = result.events.find((e) => e.kind === "tool");
    expect(toolEvent).toBeDefined();
    expect(toolEvent?.text).toBe("read_note");
    expect((toolEvent as { toolName?: string }).toolName).toBe("read_note");
  });

  it("leaves toolName undefined for non-tool events", () => {
    const jsonl =
      assistantLine({
        stopReason: "tool_use",
        content: [{ type: "thinking", thinking: "considering" }]
      }) + "\n";
    const result = parseTranscript("anthropic", jsonl, 0);
    const thinkingEvent = result.events.find((e) => e.kind === "thinking");
    expect(thinkingEvent).toBeDefined();
    expect((thinkingEvent as { toolName?: string }).toolName).toBeUndefined();
  });
});
