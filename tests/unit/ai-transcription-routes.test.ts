import { EventEmitter } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAiTranscriptionRoutes } from "../../packages/ai/src/transcription-routes.js";
import type { AiRoutesDependencies } from "../../packages/ai/src/routes.js";
import type { AiRepository } from "../../packages/ai/src/repository.js";
import type { AiSecretCipher } from "../../packages/ai/src/crypto.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixtures() {
  const scopedDb = {};
  const dependencies = {
    resolveAccessContext: vi.fn(async () => ({
      actorUserId: "fixture-owner",
      requestId: "fixture-request"
    })),
    dataContext: {
      withDataContext: vi.fn(async (_context: unknown, fn: (db: unknown) => unknown) =>
        fn(scopedDb)
      )
    }
  } as unknown as AiRoutesDependencies;
  const selectModel = vi.fn().mockResolvedValue({
    provider_config_id: "pinned-fixture-provider",
    provider_model_id: "configured-model"
  });
  const selectProvider = vi.fn().mockResolvedValue({
    provider_kind: "openai-compatible",
    base_url: "https://configured.example.test",
    encrypted_credential: {}
  });
  const repository = {
    selectModelForCapability: selectModel,
    selectProviderWithCredential: selectProvider
  } as unknown as AiRepository;
  const cipher = { decryptJson: () => ({ apiKey: "fixture-key" }) } as unknown as AiSecretCipher;
  return { dependencies, repository, cipher, scopedDb, selectModel, selectProvider };
}
const upload = {
  method: "POST" as const,
  url: "/api/ai/transcriptions",
  headers: { "content-type": "audio/wav" },
  payload: Buffer.from([1, 2, 3])
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ASR route: configured routing, timestamp opt-in and cancellation", () => {
  it("preserves a normal completed upload and text-only response", async () => {
    const f = fixtures();
    const server = Fastify();
    registerAiTranscriptionRoutes(server, f.dependencies, f.repository, f.cipher);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ text: "fixture" }));
    vi.stubGlobal("fetch", fetch);
    try {
      const response = await server.inject(upload);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ text: "fixture" });
      expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
      expect(f.selectModel).toHaveBeenCalledWith(f.scopedDb, "transcription");
      expect(f.selectProvider).toHaveBeenCalledWith(f.scopedDb, "pinned-fixture-provider");
    } finally {
      await server.close();
    }
  });

  it("passes and serializes timestamps only when explicitly requested", async () => {
    const f = fixtures();
    const server = Fastify();
    registerAiTranscriptionRoutes(server, f.dependencies, f.repository, f.cipher);
    const payload = { text: "fixture", segments: [{ start: 0, end: 1, text: "fixture" }] };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetch);
    try {
      const response = await server.inject({ ...upload, url: `${upload.url}?timestamps=segment` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(payload);
      expect((fetch.mock.calls[0]![1]!.body as FormData).get("response_format")).toBe(
        "verbose_json"
      );
      expect(
        (await server.inject({ ...upload, url: `${upload.url}?timestamps=word` })).statusCode
      ).toBe(400);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("fails closed for a pin-blocked model without calling another provider", async () => {
    const f = fixtures();
    f.selectModel.mockResolvedValue(null);
    const server = Fastify();
    registerAiTranscriptionRoutes(server, f.dependencies, f.repository, f.cipher);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      expect((await server.inject(upload)).statusCode).toBe(422);
      expect(f.selectProvider).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects unsupported timestamps with a scrubbed 502 and no text-only retry", async () => {
    const f = fixtures();
    const server = Fastify();
    registerAiTranscriptionRoutes(server, f.dependencies, f.repository, f.cipher);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ text: "private-fixture" }));
    vi.stubGlobal("fetch", fetch);
    try {
      const response = await server.inject({ ...upload, url: `${upload.url}?timestamps=segment` });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain("private-fixture");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});

// The lifecycle harness emits socket events without pretending that an aborted HTTP
// client can still receive a response. Normal wire/serialization behavior is covered above.
function lifecycleHarness() {
  const f = fixtures();
  let handler: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
  const server = {
    addContentTypeParser: vi.fn(),
    post: (_path: string, _opts: unknown, fn: typeof handler) => {
      handler = fn;
    }
  } as unknown as FastifyInstance;
  registerAiTranscriptionRoutes(server, f.dependencies, f.repository, f.cipher);
  const raw = Object.assign(new EventEmitter(), { aborted: false });
  const replyRaw = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
  const reply = { raw: replyRaw, code: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
  const log = { error: vi.fn() };
  const request = { body: Buffer.from([1, 2, 3]), raw, query: {}, log };
  return { ...f, request, reply, run: () => handler!(request, reply) };
}

describe("ASR route disconnect/timeout lifecycle", () => {
  it("aborts upstream fetch on timeout even if fetch ignores the signal", async () => {
    vi.useFakeTimers();
    const h = lifecycleHarness();
    let signal: AbortSignal | null | undefined;
    const started = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
        signal = init!.signal;
        started.resolve();
        return new Promise<Response>(() => undefined);
      })
    );
    const pending = h.run();
    await started.promise;
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    expect(signal!.aborted).toBe(true);
    expect(h.reply.code).toHaveBeenCalledWith(504);
    expect(h.request.raw.listenerCount("aborted")).toBe(0);
    expect(h.reply.raw.listenerCount("close")).toBe(0);
  });

  it.each(["aborted", "response-close"])("discards late output after %s", async (event) => {
    const h = lifecycleHarness();
    const started = deferred<void>();
    const response = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
        signal = init!.signal;
        started.resolve();
        return response.promise;
      })
    );
    const pending = h.run();
    await started.promise;
    if (event === "aborted") h.request.raw.emit("aborted");
    else h.reply.raw.emit("close");
    expect(await pending).toBe(h.reply);
    response.resolve(Response.json({ text: "private-late-fixture" }));
    await Promise.resolve();
    expect(signal!.aborted).toBe(true);
    expect(h.reply.send).not.toHaveBeenCalled();
    expect(h.request.log.error).not.toHaveBeenCalled();
  });

  it("makes no provider call after an early client abort", async () => {
    const h = lifecycleHarness();
    h.request.raw.aborted = true;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await h.run()).toBe(h.reply);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never logs thrown provider payloads", async () => {
    const h = lifecycleHarness();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private-fixture-key-and-text")));
    await h.run();
    expect(h.request.log.error).toHaveBeenCalledWith("Transcription provider request failed");
    expect(JSON.stringify(h.request.log.error.mock.calls)).not.toContain("private-fixture");
    expect(h.reply.code).toHaveBeenCalledWith(502);
  });
});
