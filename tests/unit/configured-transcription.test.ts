import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type AccessContext, type DataContextDb } from "@moss/db";
import {
  AiRepository,
  createAiSecretCipher,
  createConfiguredTranscription,
  installModelActivityRecorder,
  type AiConfiguredModelSafeRow,
  type AiProviderWithSealedCredential
} from "@moss/ai";

const db = { [dataContextBrand]: true } as DataContextDb;
const actor = { actorUserId: "synthetic-owner", requestId: "fixture" };
const model = {
  id: "model-id",
  provider_config_id: "provider-id",
  provider_kind: "openai-compatible",
  provider_model_id: "configured-stt",
  provider_auth_method: "api_key",
  provider_status: "active",
  provider_purpose: "voice",
  status: "active",
  capabilities: ["transcription"],
  updated_at: new Date("2026-01-01")
} as AiConfiguredModelSafeRow;
const provider = {
  id: "provider-id",
  provider_kind: "openai-compatible",
  base_url: "https://synthetic.invalid",
  status: "active",
  auth_method: "api_key",
  purpose: "voice",
  revoked_at: null,
  has_credential: true,
  updated_at: new Date("2026-01-01"),
  encrypted_credential: createAiSecretCipher().encryptJson({ apiKey: "synthetic-secret" })
} as AiProviderWithSealedCredential;
const response = () =>
  new Response(
    JSON.stringify({
      text: "Generated fixture",
      segments: [{ start: 0.125, end: 1.5, text: "Generated fixture" }]
    })
  );
function setup() {
  const route = vi
    .spyOn(AiRepository.prototype, "resolveModelForCapability")
    .mockResolvedValue({ model, reason: "manual-route" });
  const metadata = vi
    .spyOn(AiRepository.prototype, "selectProviderConfiguration")
    .mockResolvedValue(provider);
  const credential = vi
    .spyOn(AiRepository.prototype, "selectProviderWithCredential")
    .mockResolvedValue(provider);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  let transactions = 0;
  const runtime = createConfiguredTranscription({
    fetch,
    dataContext: {
      withDataContext: async <T>(
        _actor: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ) => {
        transactions += 1;
        try {
          return await work(db);
        } finally {
          transactions -= 1;
        }
      }
    }
  });
  const input = async () => ({
    audio: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    signal: new AbortController().signal,
    expectedModelRoute: (await runtime.availability(actor)).modelRoute!,
    dispatch: async <T>(
      send: () => Promise<T>,
      validate?: (db: DataContextDb) => Promise<void>
    ) => {
      await validate?.(db);
      return send();
    }
  });
  return {
    ...runtime,
    route,
    metadata,
    credential,
    fetch,
    input,
    transactions: () => transactions
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  installModelActivityRecorder(null);
});

describe("configured timestamped transcription", () => {
  it("retries a response-body connection failure without retaining transport text", async () => {
    const h = setup();
    const input = await h.input();
    const activity = vi.fn();
    installModelActivityRecorder(activity);
    h.fetch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new TypeError("private transcript synthetic-secret"));
          }
        })
      )
    );
    const error = await h.transcribe(actor, input).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ reason: "provider-network", stage: "response", retryable: true });
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "provider_down" })
    );
    expect(JSON.stringify([error, activity.mock.calls])).not.toMatch(
      /private transcript|synthetic-secret/
    );
  });
  it.each([
    [429, "provider-rate-limited", true, "rate_limited"],
    [503, "provider-unavailable", true, "provider_down"],
    [401, "provider-authentication", false, "auth_failed"],
    [400, "provider-response-invalid", false, "bad_shape"]
  ] as const)(
    "describes HTTP %i failures without provider content",
    async (status, reason, retryable, activityCode) => {
      const h = setup();
      const input = await h.input();
      const activity = vi.fn();
      installModelActivityRecorder(activity);
      h.fetch.mockResolvedValue(
        new Response("private transcript synthetic-secret", {
          status,
          headers: { "retry-after": "7" }
        })
      );
      const error = await h.transcribe(actor, input).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        code: "failed",
        reason,
        stage: "response",
        retryable,
        httpStatus: status
      });
      if (retryable) expect(error).toMatchObject({ retryAfterMs: 7000 });
      expect(activity).toHaveBeenCalledWith(expect.objectContaining({ failureCode: activityCode }));
      expect(JSON.stringify([error, activity.mock.calls])).not.toMatch(
        /private transcript|synthetic-secret/
      );
      expect(h.fetch).toHaveBeenCalledTimes(1);
    }
  );
  it("distinguishes invalid provider timestamps from a network failure", async () => {
    const h = setup();
    const input = await h.input();
    h.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          text: "private transcript",
          segments: [{ start: 4, end: 2, text: "private transcript" }]
        })
      )
    );
    await expect(h.transcribe(actor, input)).rejects.toMatchObject({
      reason: "provider-response-invalid",
      stage: "validation",
      retryable: false
    });
    h.fetch.mockRejectedValue(new Error("private transcript synthetic-secret"));
    await expect(h.transcribe(actor, input)).rejects.toMatchObject({
      reason: "provider-network",
      stage: "dispatch",
      retryable: true
    });
  });
  it("distinguishes the provider deadline from explicit capture cancellation", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const h = setup();
    const input = await h.input();
    h.fetch.mockImplementation(() => new Promise<Response>(() => {}));
    const pending = h.transcribe(actor, input);
    const assertion = expect(pending).rejects.toMatchObject({
      code: "failed",
      reason: "provider-timeout",
      retryable: true
    });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledOnce());
    deadline.abort(new DOMException("synthetic deadline", "TimeoutError"));
    await assertion;
    await expect(
      h.transcribe(actor, { ...input, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({
      code: "interrupted",
      reason: "cancelled",
      retryable: false
    });
  });
  it("revalidates a provider changed while waiting for final dispatch admission", async () => {
    const h = setup();
    const input = await h.input();
    const dispatch = async <T>(
      send: () => Promise<T>,
      validate?: (db: DataContextDb) => Promise<void>
    ) => {
      h.metadata.mockResolvedValue({ ...provider, status: "revoked" });
      await validate?.(db);
      return send();
    };
    await expect(h.transcribe(actor, { ...input, dispatch })).rejects.toMatchObject({
      code: "unavailable"
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("checks the caller dispatch fence at the real fetch boundary", async () => {
    const h = setup();
    const input = await h.input();
    const dispatch = vi.fn(async () => {
      throw new Error("capture paused");
    });
    await expect(h.transcribe(actor, { ...input, dispatch })).rejects.toMatchObject({
      code: "failed"
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("does not initiate a fetch when cancelled while waiting for dispatch admission", async () => {
    const h = setup();
    const input = await h.input();
    const controller = new AbortController();
    const dispatch = async <T>(send: () => Promise<T>) => {
      controller.abort();
      return send();
    };
    await expect(
      h.transcribe(actor, { ...input, signal: controller.signal, dispatch })
    ).rejects.toMatchObject({ code: "interrupted" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("preflights safe metadata without credential reads, provider requests or fallback", async () => {
    const h = setup();
    await expect(h.availability(actor)).resolves.toEqual({
      ready: true,
      modelRoute: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(h.route).toHaveBeenCalledWith(db, "transcription", "interactive", {
      logNeedsConfig: false
    });
    expect(h.credential).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...model, status: "disabled" },
    { ...model, provider_kind: "google" },
    { ...model, capabilities: [] },
    { ...model, provider_auth_method: "cli" }
  ])("fails closed on unavailable selected route %#", async (selected) => {
    const h = setup();
    h.route.mockResolvedValue({
      model: selected as AiConfiguredModelSafeRow | null,
      reason: "admin-pin-unavailable"
    });
    await expect(h.availability(actor)).resolves.toEqual({ ready: false, modelRoute: null });
    expect(h.credential).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { status: "revoked" },
    { has_credential: false },
    { revoked_at: new Date() },
    { id: "wrong-provider" }
  ])("rejects unusable provider metadata %#", async (change) => {
    const h = setup();
    h.metadata.mockResolvedValue({ ...provider, ...change } as typeof provider);
    await expect(h.availability(actor)).resolves.toEqual({ ready: false, modelRoute: null });
    expect(h.credential).not.toHaveBeenCalled();
  });
  it("sends selected-model separate WAV and bounded timestamps outside a transaction", async () => {
    const h = setup();
    const input = await h.input();
    const activity = vi.fn();
    installModelActivityRecorder(activity);
    h.fetch.mockImplementation(async (_url, options) => {
      expect(h.transactions()).toBe(0);
      expect(options?.redirect).toBe("error");
      expect(options?.headers).toEqual({ authorization: "Bearer synthetic-secret" });
      const form = options?.body as FormData;
      expect(form.get("model")).toBe("configured-stt");
      expect(form.get("response_format")).toBe("verbose_json");
      expect(form.get("timestamp_granularities[]")).toBe("segment");
      expect((form.get("file") as Blob).type).toBe("audio/wav");
      return response();
    });
    await expect(h.transcribe(actor, input)).resolves.toEqual({
      modelRoute: input.expectedModelRoute,
      segments: [{ startMs: 125, endMs: 1500, text: "Generated fixture" }]
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0]?.[0]).toBe("https://synthetic.invalid/v1/audio/transcriptions");
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: actor.actorUserId, actionCode: "transcribe.meeting" })
    );
    expect(JSON.stringify(activity.mock.calls)).not.toContain("Generated fixture");
    expect(JSON.stringify(activity.mock.calls)).not.toContain("synthetic-secret");
  });
  it("rejects a changed configured destination before sending", async () => {
    const h = setup();
    const input = await h.input();
    h.metadata.mockResolvedValue({ ...provider, base_url: "https://other.invalid" });
    h.credential.mockResolvedValue({ ...provider, base_url: "https://other.invalid" });
    await expect(h.transcribe(actor, input)).rejects.toMatchObject({ code: "route-changed" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("discards a result after same-timestamp credential rotation", async () => {
    const h = setup();
    const input = await h.input();
    h.fetch.mockImplementation(async () => {
      h.credential.mockResolvedValue({
        ...provider,
        encrypted_credential: createAiSecretCipher().encryptJson({ apiKey: "rotated-fixture" })
      });
      return response();
    });
    await expect(h.transcribe(actor, input)).rejects.toMatchObject({ code: "route-changed" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("discards a result if the selected model becomes unavailable", async () => {
    const h = setup();
    const input = await h.input();
    h.fetch.mockImplementation(async () => {
      h.route.mockResolvedValue({ model: null, reason: "admin-pin-unavailable" });
      return response();
    });
    await expect(h.transcribe(actor, input)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("aborts promptly and rejects output from an adapter ignoring cancellation", async () => {
    const h = setup();
    const input = await h.input();
    const controller = new AbortController();
    let settle!: (value: Response) => void;
    h.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const pending = h.transcribe(actor, { ...input, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ code: "interrupted" });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejection;
    settle(response());
  });
  it("does not dispatch after cancellation", async () => {
    const h = setup();
    const input = await h.input();
    await expect(
      h.transcribe(actor, { ...input, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: "interrupted" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("scrubs provider errors without retrying or persisting private audio text", async () => {
    const h = setup();
    const input = await h.input();
    h.fetch.mockRejectedValue(new Error("private transcript synthetic-secret"));
    await expect(h.transcribe(actor, input)).rejects.toEqual(
      expect.objectContaining({ message: "Configured transcription failed", code: "failed" })
    );
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
