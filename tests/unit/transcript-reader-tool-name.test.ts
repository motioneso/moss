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

// ─── #2228: sources from the CLI's own web search ─────────────────────────────────────────────
describe("parseTranscript — #2228 web search sources", () => {
  function sourcesOf(result: ReturnType<typeof parseTranscript>) {
    return result.events.flatMap(
      (e) => (e as { sources?: readonly { title: string; url: string }[] }).sources ?? []
    );
  }

  it("reads a Claude WebSearch result's pages from the record's toolUseResult", () => {
    const jsonl =
      assistantLine({
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_ws1", name: "WebSearch", input: { query: "q" } }]
      }) +
      "\n" +
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_ws1",
              content: "Web search results for query: q"
            }
          ]
        },
        toolUseResult: {
          query: "q",
          results: [
            {
              tool_use_id: "srvtoolu_1",
              content: [
                { title: "First page", url: "https://example.com/a" },
                { title: "Second page", url: "https://example.com/b" },
                { title: "Repeat", url: "https://example.com/a" }
              ]
            },
            "Some summary text"
          ]
        },
        uuid: "u3",
        timestamp: "2026-09-05T00:00:00.000Z"
      }) +
      "\n";
    const result = parseTranscript("anthropic", jsonl, 0);
    expect(sourcesOf(result)).toEqual([
      { title: "First page", url: "https://example.com/a" },
      { title: "Second page", url: "https://example.com/b" }
    ]);
    const sourced = result.events.find((e) => (e as { sources?: unknown }).sources) as
      | { toolCallId?: string; rejected?: boolean }
      | undefined;
    expect(sourced?.toolCallId).toBe("toolu_ws1");
    expect(sourced?.rejected).toBeUndefined();
  });

  it("falls back to the Links list inside the tool_result text", () => {
    const text =
      'Web search results for query: "q"\n\nLinks: [{"title":"Only page","url":"https://example.com/only"}]\n\nSummary.';
    const jsonl =
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_ws2", content: [{ type: "text", text }] }
          ]
        },
        uuid: "u4",
        timestamp: "2026-09-05T00:00:01.000Z"
      }) + "\n";
    const result = parseTranscript("anthropic", jsonl, 0);
    expect(sourcesOf(result)).toEqual([{ title: "Only page", url: "https://example.com/only" }]);
  });

  it("emits no source event for a successful tool_result without pages", () => {
    const jsonl = userToolResultLine({ toolUseId: "toolu_04", isError: false }) + "\n";
    const result = parseTranscript("anthropic", jsonl, 0);
    expect(result.events).toEqual([]);
  });

  it("maps codex exec web_search items: opened pages become sources, a bare search does not", () => {
    const item = (action: Record<string, unknown>, id: string) =>
      JSON.stringify({
        type: "item.completed",
        item: { id, type: "web_search", query: "q", action }
      });
    const jsonl =
      [
        item({ type: "search", query: "q" }, "ws_1"),
        item({ type: "open_page", url: "https://example.com/page" }, "ws_2"),
        item({ type: "find_in_page", url: "https://example.com/page", pattern: "x" }, "ws_3"),
        JSON.stringify({
          type: "item.completed",
          item: { id: "msg_1", type: "agent_message", text: "done" }
        })
      ].join("\n") + "\n";
    const result = parseTranscript("openai-compatible", jsonl, 0);
    const toolEvents = result.events.filter((e) => e.kind === "tool");
    expect(toolEvents).toHaveLength(3);
    expect(sourcesOf(result)).toEqual([
      { title: "https://example.com/page", url: "https://example.com/page" },
      { title: "https://example.com/page", url: "https://example.com/page" }
    ]);
    expect(result.reply).toBe("done");
  });
});
