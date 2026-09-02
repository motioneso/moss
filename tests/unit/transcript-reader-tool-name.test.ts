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

function userToolResultLine(opts: {
  readonly toolUseId: string;
  readonly isError: boolean;
}): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.toolUseId,
          is_error: opts.isError,
          content: "Error: No such tool available"
        }
      ]
    },
    uuid: "u2",
    timestamp: "2026-09-02T00:00:01.000Z"
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

describe("parseTranscript — #2164 r21 correction: rejected mcp__ call is reported rejected", () => {
  it("carries the tool_use block id on the emitted tool event", () => {
    const jsonl =
      assistantLine({
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "mcp__jarvis__sports_confirmSourceRecipe",
            input: {}
          }
        ]
      }) + "\n";
    const result = parseTranscript("anthropic", jsonl, 0);
    const toolEvent = result.events.find((e) => e.kind === "tool");
    expect(toolEvent).toBeDefined();
    expect((toolEvent as { toolCallId?: string }).toolCallId).toBe("toolu_01");
  });

  it("emits a rejected-call signal keyed by tool_use_id when a user record carries an errored tool_result", () => {
    const jsonl =
      assistantLine({
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_02",
            name: "mcp__jarvis__sports_confirmSourceRecipe",
            input: {}
          }
        ]
      }) +
      "\n" +
      userToolResultLine({ toolUseId: "toolu_02", isError: true }) +
      "\n";
    const result = parseTranscript("anthropic", jsonl, 0);
    const rejectedEvent = result.events.find(
      (e) => (e as { rejected?: boolean }).rejected === true
    ) as { rejected?: boolean; toolCallId?: string } | undefined;
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent?.toolCallId).toBe("toolu_02");
  });

  it("does not emit a rejected-call signal for a successful tool_result", () => {
    const jsonl =
      assistantLine({
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_03",
            name: "mcp__jarvis__sports_confirmSourceRecipe",
            input: {}
          }
        ]
      }) +
      "\n" +
      userToolResultLine({ toolUseId: "toolu_03", isError: false }) +
      "\n";
    const result = parseTranscript("anthropic", jsonl, 0);
    const rejectedEvent = result.events.find(
      (e) => (e as { rejected?: boolean }).rejected === true
    );
    expect(rejectedEvent).toBeUndefined();
  });
});
