import { describe, expect, it, vi } from "vitest";

import { HttpApiAdapter } from "../../packages/ai/src/adapters/http-api.js";
import {
  createDbModelActivityRecorder,
  type ModelActivityEntry
} from "../../packages/ai/src/model-activity.js";

const openaiModel = {
  provider_kind: "openai-compatible",
  provider_model_id: "gpt-test-model"
} as const;

function okFetch(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
}

describe("model activity recording (plan 3.6a, #2889)", () => {
  it("records one entry for a chat call with the actual model name and outcome", async () => {
    const entries: ModelActivityEntry[] = [];
    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: okFetch({ choices: [{ message: { role: "assistant", content: "hi" } }] }),
      onModelCall: (entry) => entries.push(entry)
    });

    const out = await adapter.generateChat({
      model: openaiModel,
      messages: [{ role: "user", content: "hello" }]
    });

    expect(out.text).toBe("hi");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "chat",
      action: "chat",
      outcome: "ok",
      modelName: "gpt-test-model",
      result: "completed"
    });
  });

  it("records a structured call with the caller's service as the action", async () => {
    const entries: ModelActivityEntry[] = [];
    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: okFetch({ choices: [{ message: { content: '{"ok":true}' } }] }),
      onModelCall: (entry) => entries.push(entry)
    });

    await adapter.generateStructured({
      service: "module.classifier",
      model: openaiModel,
      messages: [{ role: "user", content: "pick" }],
      schema: { type: "object" },
      maxOutputTokens: 100
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "structured",
      action: "classifier",
      outcome: "ok",
      modelName: "gpt-test-model"
    });
  });

  it("records a transcription call", async () => {
    const entries: ModelActivityEntry[] = [];
    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: okFetch({ text: "words" }),
      onModelCall: (entry) => entries.push(entry)
    });

    await adapter.transcribeAudio({
      model: { provider_model_id: "whisper-test-model" },
      audio: new Blob([new Uint8Array([1, 2, 3])])
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "transcription",
      action: "transcription",
      outcome: "ok",
      modelName: "whisper-test-model"
    });
  });

  it("records an error outcome and still throws when the provider call fails", async () => {
    const entries: ModelActivityEntry[] = [];
    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      onModelCall: (entry) => entries.push(entry)
    });

    await expect(
      adapter.generateChat({ model: openaiModel, messages: [{ role: "user", content: "x" }] })
    ).rejects.toThrow(/500/);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "error", result: "failed" });
  });

  it("never records the message text passed to the adapter", async () => {
    const SENTINEL = "SENTINEL-private-message-do-not-record";
    const entries: ModelActivityEntry[] = [];
    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: okFetch({ choices: [{ message: { content: "ok" } }] }),
      onModelCall: (entry) => entries.push(entry)
    });

    await adapter.generateChat({
      model: openaiModel,
      messages: [{ role: "user", content: SENTINEL }]
    });

    expect(JSON.stringify(entries)).not.toContain(SENTINEL);
    // The entry carries only the six short fields.
    expect(Object.keys(entries[0]!).sort()).toEqual([
      "action",
      "kind",
      "modelName",
      "outcome",
      "result"
    ]);
  });

  it("does not fail or reject the model call when the recorder throws synchronously", async () => {
    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: okFetch({ choices: [{ message: { content: "unaffected" } }] }),
      onModelCall: () => {
        throw new Error("recorder exploded");
      }
    });

    const out = await adapter.generateChat({
      model: openaiModel,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.text).toBe("unaffected");
  });

  it("does not fail the model call when a database recorder is installed but the write rejects", async () => {
    const logger = { warn: vi.fn() };
    const recorder = createDbModelActivityRecorder(async () => {
      throw new Error("db down");
    }, logger as never);

    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: okFetch({ choices: [{ message: { content: "still fine" } }] }),
      onModelCall: recorder
    });

    const out = await adapter.generateChat({
      model: openaiModel,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.text).toBe("still fine");
  });

  it("truncates over-long fields to the column limits instead of dropping the row", () => {
    const written: ModelActivityEntry[] = [];
    const recorder = createDbModelActivityRecorder(async (entry) => {
      written.push(entry);
    });

    recorder({
      kind: "chat",
      action: "a".repeat(300),
      outcome: "ok",
      modelName: "m".repeat(300),
      result: "r".repeat(600)
    });

    expect(written).toHaveLength(1);
    expect(written[0]!.action.length).toBe(200);
    expect(written[0]!.modelName.length).toBe(200);
    expect(written[0]!.result.length).toBe(500);
  });
});
