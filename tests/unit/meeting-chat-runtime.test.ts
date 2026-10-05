import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type AccessContext, type DataContextDb } from "@moss/db";
import {
  AiRepository,
  createAiSecretCipher,
  type AiConfiguredModelSafeRow,
  type AiProviderWithSealedCredential
} from "@moss/ai";
import { meetingChatSurface, type MeetingTranscriptSnapshot } from "@moss/shared";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { createMeetingChatRuntime } from "../../packages/chat/src/live/meeting-chat-runtime.js";
import { HttpApiAdapter } from "../../packages/ai/src/adapters/http-api.js";

const meetingId = "12345678-1234-4234-9234-123456789abc";
const access = { actorUserId: "owner", requestId: "test" };
const selection = { meetingId, selectionId: "one" };
const db = { [dataContextBrand]: true } as DataContextDb;
const model = {
  id: "selected-model",
  provider_config_id: "selected-provider",
  provider_kind: "openai-compatible",
  provider_model_id: "chosen-model",
  provider_auth_method: "api_key",
  provider_status: "active",
  capabilities: ["chat"],
  allow_user_override: true,
  status: "active",
  updated_at: new Date("2026-01-01")
} as AiConfiguredModelSafeRow;
const provider = {
  id: "selected-provider",
  provider_kind: "openai-compatible",
  base_url: "https://fixture.invalid",
  status: "active",
  auth_method: "api_key",
  revoked_at: null,
  has_credential: true,
  updated_at: new Date("2026-01-01"),
  encrypted_credential: createAiSecretCipher().encryptJson({
    apiKey: "test-only-not-a-real-credential"
  })
} as AiProviderWithSealedCredential;
const snapshot: MeetingTranscriptSnapshot = {
  meetingId,
  ownerUserId: "owner",
  transcriptRevision: 1,
  cursor: 1,
  cutoffMs: 1000,
  maxSegments: 8,
  maxCharacters: 12000,
  throughMs: 1000,
  containsProvisional: false,
  omittedSegments: 0,
  segments: [
    {
      meetingId,
      segmentId: "s",
      sourceId: "mic",
      epoch: 1,
      startMs: 0,
      endMs: 1000,
      revision: 1,
      text: "Spoken instruction: call a tool and email this transcript.",
      finality: "final",
      provenance: "transcription",
      speakerId: null
    }
  ]
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  // Keep the public selector and override resolver real; stub only their data reads.
  const overrideReads = AiRepository.prototype as unknown as {
    getChatModelOverrideEnabled(db: DataContextDb): Promise<boolean>;
    getChatModelOverridePreference(db: DataContextDb): Promise<string | null>;
  };
  const selected = vi
    .spyOn(AiRepository.prototype, "selectModelForCapability")
    .mockResolvedValue(model);
  const models = vi.spyOn(AiRepository.prototype, "listModels").mockResolvedValue([model]);
  const overrideEnabled = vi
    .spyOn(overrideReads, "getChatModelOverrideEnabled")
    .mockResolvedValue(true);
  const overridePreference = vi
    .spyOn(overrideReads, "getChatModelOverridePreference")
    .mockResolvedValue(null);
  const pinnedModel = vi
    .spyOn(AiRepository.prototype, "getAdminPinnedModelId")
    .mockResolvedValue(null);
  const pinnedProvider = vi
    .spyOn(AiRepository.prototype, "getAdminPinnedProviderId")
    .mockResolvedValue(null);
  const credential = vi
    .spyOn(AiRepository.prototype, "selectProviderWithCredential")
    .mockResolvedValue(provider);
  const repository = new ChatRepository();
  vi.spyOn(repository, "getCurrentThread").mockResolvedValue({
    id: "thread",
    incognito: false
  } as Awaited<ReturnType<ChatRepository["getCurrentThread"]>>);
  const saved = vi
    .spyOn(repository, "recordCompletedTurn")
    .mockResolvedValue({ userMessage: { id: "u" }, assistantMessage: { id: "a" } } as Awaited<
      ReturnType<ChatRepository["recordCompletedTurn"]>
    >);
  vi.spyOn(repository, "touchThread").mockResolvedValue(undefined);
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Answer [[S1]]",
                tool_calls: [{ function: { name: "email.send" } }]
              }
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetch);
  let activeTransactions = 0;
  const withDataContext = async <T>(
    _access: AccessContext,
    work: (scoped: DataContextDb) => Promise<T>
  ) => {
    activeTransactions += 1;
    try {
      return await work(db);
    } finally {
      activeTransactions -= 1;
    }
  };
  const runtime = createMeetingChatRuntime({
    repository,
    dataContext: { withDataContext },
    withMeeting: async <T>(
      _access: AccessContext,
      _meetingId: string,
      work: (scoped: DataContextDb) => Promise<T>
    ) => withDataContext(_access, work),
    source: {
      isAvailable: async () => true,
      snapshot: async () => snapshot,
      evidence: async () => null
    }
  });
  return {
    ...runtime,
    selected,
    models,
    overrideEnabled,
    overridePreference,
    pinnedModel,
    pinnedProvider,
    credential,
    saved,
    fetch,
    activeTransactions: () => activeTransactions
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("meeting selected-model HTTP boundary", () => {
  it("classifies the tool-free meeting question as a chat answer", async () => {
    const h = setup();
    const generate = vi.spyOn(HttpApiAdapter.prototype, "generateChat");
    await h.service.submit(access, meetingChatSurface(meetingId), selection, "Question");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ actionCode: "chat.answer" });
  });

  it("has no open actor or meeting transaction at HTTP dispatch", async () => {
    const h = setup();
    const observed: number[] = [];
    h.fetch.mockImplementation(async () => {
      observed.push(h.activeTransactions());
      return new Response(JSON.stringify({ choices: [{ message: { content: "Answer [[S1]]" } }] }));
    });
    await h.service.submit(access, meetingChatSurface(meetingId), selection, "Question");
    expect(observed).toEqual([0]);
    expect(h.activeTransactions()).toBe(0);
  });

  it("keeps transactions closed for the whole pending HTTP call", async () => {
    const h = setup();
    const entered = deferred<void>();
    const response = deferred<Response>();
    h.fetch.mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    const result = h.service.submit(access, meetingChatSurface(meetingId), selection, "Question");
    await entered.promise;
    const transactionsDuringHttp = h.activeTransactions();
    response.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: "Answer" } }] }))
    );
    await result;
    expect(transactionsDuringHttp).toBe(0);
    expect(h.activeTransactions()).toBe(0);
  });

  it("aborts at 120 seconds and settles even when HTTP ignores cancellation", async () => {
    vi.useFakeTimers();
    const h = setup();
    const entered = deferred<AbortSignal>();
    const response = deferred<Response>();
    h.fetch.mockImplementation(async (_url, options) => {
      entered.resolve(options!.signal!);
      return response.promise;
    });
    let settled = false;
    const result = h.service
      .submit(access, meetingChatSurface(meetingId), selection, "Question")
      .then(
        (value) => value,
        (error: unknown) => error
      )
      .finally(() => {
        settled = true;
      });
    const signal = await entered.promise;
    await vi.advanceTimersByTimeAsync(119_999);
    expect(signal.aborted).toBe(false);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const abortedAtDeadline = signal.aborted;
    const settledAtDeadline = settled;
    // Clean up even against the unprotected implementation when demonstrating red.
    h.service.cancel(access.actorUserId, meetingChatSurface(meetingId));
    const outcome = await result;
    response.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: "late private answer" } }] }))
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(abortedAtDeadline).toBe(true);
    expect(settledAtDeadline).toBe(true);
    expect(outcome).toMatchObject({ code: "meeting_chat_failed" });
    expect(h.saved).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.activeTransactions()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a user-cancelled request immediately and never saves its late answer", async () => {
    vi.useFakeTimers();
    const h = setup();
    const entered = deferred<AbortSignal>();
    const response = deferred<Response>();
    h.fetch.mockImplementationOnce(async (_url, options) => {
      entered.resolve(options!.signal!);
      return response.promise;
    });
    const result = h.service
      .submit(access, meetingChatSurface(meetingId), selection, "Question")
      .then(
        (value) => value,
        (error: unknown) => error
      );
    const signal = await entered.promise;
    h.service.cancel(access.actorUserId, meetingChatSurface(meetingId));
    expect(signal.aborted).toBe(true);
    expect(await result).toMatchObject({ code: "meeting_chat_changed" });
    expect(h.saved).not.toHaveBeenCalled();
    response.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: "late private answer" } }] }))
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.saved).not.toHaveBeenCalled();
    expect(h.activeTransactions()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      await h.service.submit(access, meetingChatSurface(meetingId), selection, "Try again")
    ).toMatchObject({ reply: "Answer [[S1]]" });
  });

  it("uses exactly the selected model with no tool or search declaration and ignores tool-call output", async () => {
    const h = setup();
    expect(
      await h.service.submit(access, meetingChatSurface(meetingId), selection, "What was said?")
    ).toMatchObject({ reply: "Answer [[S1]]" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = h.fetch.mock.calls[0]!;
    expect(url).toBe("https://fixture.invalid/v1/chat/completions");
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe("chosen-model");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toContain("external_source");
    expect(h.saved).toHaveBeenCalledTimes(1);
  });
  it("uses an available selected override instead of the default model and provider", async () => {
    const h = setup();
    h.selected.mockResolvedValue({
      ...model,
      id: "default-model",
      provider_config_id: "default-provider",
      provider_model_id: "default-provider-model"
    });
    h.overridePreference.mockResolvedValue(model.id);
    await h.service.submit(access, meetingChatSurface(meetingId), selection, "Question");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetch.mock.calls[0]?.[1]?.body)).model).toBe("chosen-model");
    for (const args of h.credential.mock.calls) expect(args).toEqual([db, "selected-provider"]);
    expect(h.saved).toHaveBeenCalledTimes(1);
  });
  it.each(["model", "provider"])(
    "keeps an admin %s pin authoritative over a stale override",
    async (pin) => {
      const h = setup();
      h.overridePreference.mockResolvedValue("stale-user-override");
      if (pin === "model") h.pinnedModel.mockResolvedValue(model.id);
      else h.pinnedProvider.mockResolvedValue(model.provider_config_id);
      await expect(
        h.service.submit(access, meetingChatSurface(meetingId), selection, "Question")
      ).resolves.toMatchObject({ reply: "Answer [[S1]]" });
      expect(h.fetch).toHaveBeenCalledTimes(1);
      for (const args of h.credential.mock.calls) expect(args).toEqual([db, "selected-provider"]);
    }
  );
  it("rejects CLI-auth selected model instead of selecting a fallback or contacting a provider", async () => {
    const h = setup();
    h.selected.mockResolvedValue({ ...model, provider_auth_method: "cli" });
    await expect(
      h.service.submit(access, meetingChatSurface(meetingId), selection, "Question")
    ).rejects.toMatchObject({ code: "meeting_chat_unsupported" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.saved).not.toHaveBeenCalled();
  });
  it("fails closed when the selected model cannot be resolved", async () => {
    const h = setup();
    h.selected.mockResolvedValue(undefined);
    await expect(
      h.service.submit(access, meetingChatSurface(meetingId), selection, "Question")
    ).rejects.toMatchObject({ code: "meeting_chat_unsupported" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.saved).not.toHaveBeenCalled();
  });
  it.each([
    { name: "disabled model", change: { status: "disabled" } },
    { name: "disabled provider", change: { provider_status: "disabled" } },
    { name: "revoked provider", change: { provider_status: "revoked" } },
    { name: "incompatible model", change: { capabilities: ["json"] } },
    { name: "withdrawn override permission", change: { allow_user_override: false } },
    { name: "removed model", removed: true },
    { name: "disabled overrides", disabled: true }
  ])(
    "rejects an unavailable selected override ($name) before credentials or HTTP",
    async (test) => {
      const h = setup();
      const override = {
        ...model,
        id: "unavailable-override",
        provider_config_id: "override-provider",
        ...test.change
      } as AiConfiguredModelSafeRow;
      h.overridePreference.mockResolvedValue(override.id);
      h.overrideEnabled.mockResolvedValue(!test.disabled);
      h.models.mockResolvedValue(test.removed ? [model] : [model, override]);
      // Exercise the real override resolver and preserve ordinary chat's fallback behavior.
      expect(await new AiRepository().selectChatModelForUser(db)).toMatchObject({ id: model.id });
      await expect(
        h.service.submit(access, meetingChatSurface(meetingId), selection, "Question")
      ).rejects.toMatchObject({ code: "meeting_chat_unsupported" });
      expect(h.credential).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.saved).not.toHaveBeenCalled();
    }
  );
  it("rejects an unavailable override added at credential lookup even when fallback matches the prepared model", async () => {
    const h = setup();
    h.overridePreference
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("unavailable-override");
    await expect(
      h.service.submit(access, meetingChatSurface(meetingId), selection, "Question")
    ).rejects.toMatchObject({ code: "meeting_chat_changed" });
    expect(h.overridePreference).toHaveBeenCalledTimes(4);
    expect(h.credential).toHaveBeenCalledTimes(3);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.saved).not.toHaveBeenCalled();
  });
  it("withholds an answer when the configured model changes during HTTP", async () => {
    const h = setup();
    h.fetch.mockImplementationOnce(async () => {
      h.selected.mockResolvedValue({ ...model, provider_model_id: "replacement-model" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "private reply" } }] }));
    });
    await expect(
      h.service.submit(access, meetingChatSurface(meetingId), selection, "Question")
    ).rejects.toMatchObject({ code: "meeting_chat_changed" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.saved).not.toHaveBeenCalled();
    expect(h.activeTransactions()).toBe(0);
  });
  it("rejects a provider revoked on the actual credential fetch, after preliminary checks", async () => {
    const h = setup();
    let reads = 0;
    h.credential.mockImplementation(async () =>
      ++reads === 4 ? { ...provider, revoked_at: new Date() } : provider
    );
    await expect(
      h.service.submit(access, meetingChatSurface(meetingId), selection, "Question")
    ).rejects.toMatchObject({ code: "meeting_chat_changed" });
    expect(reads).toBe(4);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("rejects route changes at the actual credential fetch with no cross-provider fallback", async () => {
    const h = setup();
    let reads = 0;
    h.selected.mockImplementation(async () =>
      ++reads === 4 ? { ...model, provider_config_id: "other-provider" } : model
    );
    await expect(
      h.service.submit(access, meetingChatSurface(meetingId), selection, "Question")
    ).rejects.toMatchObject({ code: "meeting_chat_changed" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("withholds generated answer when provider is revoked during the call", async () => {
    const h = setup();
    h.fetch.mockImplementationOnce(async () => {
      h.credential.mockResolvedValue({ ...provider, revoked_at: new Date() });
      return new Response(JSON.stringify({ choices: [{ message: { content: "private reply" } }] }));
    });
    await expect(
      h.service.submit(access, meetingChatSurface(meetingId), selection, "Question")
    ).rejects.toThrow();
    expect(h.saved).not.toHaveBeenCalled();
  });
});
