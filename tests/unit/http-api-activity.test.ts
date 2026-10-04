import { describe, expect, it } from "vitest";

import { HttpApiAdapter, type ModelActivityEntry } from "@moss/ai";

function collect() {
  const seen: ModelActivityEntry[] = [];
  return { seen, recorder: (entry: ModelActivityEntry) => seen.push(entry) };
}

function chatFetch(text = "hello") {
  return async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}

function structuredFetch(payload: unknown) {
  return async () => new Response(JSON.stringify(payload), { status: 200 });
}

const structuredPayload = {
  content: [
    {
      type: "tool_use",
      name: "emit_structured_output",
      input: { choice: "a" }
    }
  ],
  usage: { input_tokens: 12, output_tokens: 4 }
};

const model = { provider_kind: "anthropic", provider_model_id: "claude-sonnet-5" } as const;

describe("HttpApiAdapter activity lines", () => {
  it("records a chat turn as chat.answer with owner and turn link", async () => {
    const { seen, recorder } = collect();
    const adapter = new HttpApiAdapter("anthropic", "key", {
      fetch: chatFetch(),
      onModelCall: recorder
    });
    await adapter.generateChat({
      model,
      messages: [{ role: "user", content: "hi" }],
      ownerUserId: "user-1",
      turnId: "turn-1",
      parentId: "answer-1"
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "chat",
      actionCode: "chat.answer",
      ownerUserId: "user-1",
      turnId: "turn-1",
      parentId: "answer-1",
      outcome: "ok"
    });
    expect(typeof seen[0]?.durationMs).toBe("number");
  });

  it("records a structured call with service code and payload tokens", async () => {
    const { seen, recorder } = collect();
    const adapter = new HttpApiAdapter("anthropic", "key", {
      fetch: structuredFetch(structuredPayload),
      onModelCall: recorder
    });
    await adapter.generateStructured({
      service: "module.sorting",
      model,
      messages: [{ role: "user", content: "sort" }],
      schema: { type: "object" },
      maxOutputTokens: 100,
      actorUserId: "user-1",
      turnId: "turn-1"
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "structured",
      actionCode: "structured.sorting",
      ownerUserId: "user-1",
      turnId: "turn-1",
      inputTokens: 12,
      outputTokens: 4,
      outcome: "ok"
    });
  });

  it("lets a caller name its own code instead of the service code", async () => {
    const { seen, recorder } = collect();
    const adapter = new HttpApiAdapter("anthropic", "key", {
      fetch: structuredFetch(structuredPayload),
      onModelCall: recorder
    });
    await adapter.generateStructured({
      service: "module.sorting",
      model,
      messages: [{ role: "user", content: "sort" }],
      schema: { type: "object" },
      maxOutputTokens: 100,
      actionCode: "module.build"
    });
    expect(seen[0]).toMatchObject({ actionCode: "module.build" });
  });

  it("falls back to structured.task when no service names the call", async () => {
    const { seen, recorder } = collect();
    const adapter = new HttpApiAdapter("anthropic", "key", {
      fetch: structuredFetch(structuredPayload),
      onModelCall: recorder
    });
    await adapter.generateStructured({
      model,
      messages: [{ role: "user", content: "sort" }],
      schema: { type: "object" },
      maxOutputTokens: 100
    });
    expect(seen[0]).toMatchObject({ actionCode: "structured.task" });
    expect(seen[0]).not.toHaveProperty("ownerUserId");
  });

  it("omits tokens the provider did not report", async () => {
    const { seen, recorder } = collect();
    const adapter = new HttpApiAdapter("anthropic", "key", {
      fetch: structuredFetch({
        content: [{ type: "tool_use", name: "emit_structured_output", input: {} }]
      }),
      onModelCall: recorder
    });
    await adapter.generateStructured({
      service: "module.sorting",
      model,
      messages: [{ role: "user", content: "sort" }],
      schema: { type: "object" },
      maxOutputTokens: 100
    });
    expect(seen[0]).not.toHaveProperty("inputTokens");
    expect(seen[0]).not.toHaveProperty("outputTokens");
  });

  it("maps a provider refusal to a failure code, never raw text", async () => {
    const { seen, recorder } = collect();
    const adapter = new HttpApiAdapter("anthropic", "key", {
      fetch: async () => new Response("nope", { status: 429 }),
      onModelCall: recorder
    });
    await expect(
      adapter.generateChat({ model, messages: [{ role: "user", content: "hi" }] })
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ outcome: "error", actionCode: "chat.answer" });
    expect(seen[0]?.failureCode).not.toBe("nope");
  });
});
