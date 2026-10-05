import { describe, expect, it, vi } from "vitest";
import { HttpApiAdapter } from "../../packages/ai/src/adapters/http-api.js";
import { readTimestampedTranscription } from "../../packages/ai/src/adapters/http-api-transcription.js";

const input = {
  model: { provider_model_id: "configured-model" },
  audio: new Blob([new Uint8Array([1, 2, 3])])
};
const segment = { start: 0, end: 1.25, text: "Generated fixture" };
const payload = { text: segment.text, segments: [segment] };

function adapterFor(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  const adapter = new HttpApiAdapter("openai-compatible", "fixture-key", {
    fetch,
    baseUrl: "https://configured.example.test",
    onModelCall: () => undefined
  });
  return { fetch, adapter };
}

describe("timestamped ASR (generated fixtures, no provider compatibility proof)", () => {
  it("opts into verbose segment timestamps at the configured endpoint and strips speaker claims", async () => {
    const { adapter, fetch } = adapterFor(
      Response.json({ ...payload, segments: [{ ...segment, speaker: "invented" }] })
    );
    const controller = new AbortController();
    expect(
      await adapter.transcribeAudio({ ...input, timestamps: "segment", signal: controller.signal })
    ).toEqual(payload);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://configured.example.test/v1/audio/transcriptions");
    const form = init!.body as FormData;
    expect(form.get("model")).toBe("configured-model");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment"]);
    expect(init!.signal).toBe(controller.signal);
  });

  it("preserves the text-only wire contract and provider form by default", async () => {
    const { adapter, fetch } = adapterFor(Response.json(payload));
    expect(await adapter.transcribeAudio(input)).toEqual({ text: payload.text });
    expect([...(fetch.mock.calls[0]![1]!.body as FormData).keys()]).toEqual(["model", "file"]);
  });

  it.each([
    null,
    {},
    { text: "private", segments: [] },
    { text: "private" },
    { text: "private", segments: [{ ...segment, start: -1 }] },
    { text: "private", segments: [{ ...segment, end: 0 }] },
    { text: "private", segments: [{ ...segment, end: 0.0001 }] },
    { text: "private", segments: [{ ...segment, end: Number.MAX_SAFE_INTEGER }] },
    { text: "private", segments: [{ ...segment, start: 2 }] },
    { text: "private", segments: [{ ...segment, end: "1" }] },
    { text: "private", segments: [{ ...segment, text: null }] },
    { text: "private", segments: [segment, { ...segment, start: 1 }] },
    {
      text: "private",
      segments: Array.from({ length: 10001 }, () => ({ start: 0, end: 0, text: "" }))
    },
    { text: "x".repeat(1024 * 1024 + 1), segments: [] }
  ])("fails closed for malformed/unsupported timestamps %#", async (value) => {
    const { adapter, fetch } = adapterFor(Response.json(value));
    await expect(adapter.transcribeAudio({ ...input, timestamps: "segment" })).rejects.toThrow(
      "Invalid or unsupported timestamped transcription response"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects non-finite parsed timestamps and scrubs JSON syntax errors", async () => {
    for (const body of [
      '{"text":"fixture","segments":[{"start":0,"end":1e400,"text":"fixture"}]}',
      '{"private-fixture-invalid'
    ]) {
      await expect(readTimestampedTranscription(new Response(body))).rejects.toThrow(
        "Invalid or unsupported timestamped transcription response"
      );
    }
  });

  it("accepts explicit silent clips and adjacent ordered segments", async () => {
    expect(await readTimestampedTranscription(Response.json({ text: "", segments: [] }))).toEqual({
      text: "",
      segments: []
    });
    const value = { text: "fixture", segments: [segment, { start: 1.25, end: 2, text: " next" }] };
    expect(await readTimestampedTranscription(Response.json(value))).toEqual(value);
  });

  it("bounds response bytes and cancels oversized response streams", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel
    });
    await expect(readTimestampedTranscription(new Response(stream))).rejects.toThrow(
      "Invalid or unsupported"
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a hung response read on abort even for an injected stream", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const pending = readTimestampedTranscription(new Response(stream), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("cancels an unread pre-aborted response without waiting for a hung cancel hook", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    await expect(readTimestampedTranscription(response, AbortSignal.abort())).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a late fetch response body before rejecting aborted output", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      controller.abort();
      return response;
    });
    const adapter = new HttpApiAdapter("openai-compatible", "fixture-key", {
      fetch,
      onModelCall: () => undefined
    });
    await expect(
      adapter.transcribeAudio({ ...input, signal: controller.signal })
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not start a fetch when already cancelled", async () => {
    const { adapter, fetch } = adapterFor(Response.json(payload));
    const signal = AbortSignal.abort();
    await expect(adapter.transcribeAudio({ ...input, signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes cancellation to fetch and rejects a late success", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      expect(init!.signal).toBe(controller.signal);
      controller.abort();
      return Response.json(payload);
    });
    const adapter = new HttpApiAdapter("openai-compatible", "fixture-key", {
      fetch,
      onModelCall: () => undefined
    });
    await expect(
      adapter.transcribeAudio({ ...input, timestamps: "segment", signal: controller.signal })
    ).rejects.toThrow();
  });

  it("cancels unused HTTP error bodies without awaiting a hung cancel hook", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 429 });
    const { adapter } = adapterFor(response);
    await expect(adapter.transcribeAudio({ ...input, timestamps: "segment" })).rejects.toThrow(
      "HTTP 429"
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not read private upstream error bodies", async () => {
    const response = new Response("private-fixture", { status: 429 });
    const read = vi.spyOn(response, "text");
    const { adapter } = adapterFor(response);
    await expect(adapter.transcribeAudio({ ...input, timestamps: "segment" })).rejects.toThrow(
      "HTTP 429"
    );
    expect(read).not.toHaveBeenCalled();
  });
});
