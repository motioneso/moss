import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleSummarizeConversationJob,
  WITHHELD_TURN,
  type SummaryJobDeps,
  type SummaryJobPayload
} from "../../packages/chat/src/summary-job.js";

// #3156: the summary job publishes only a successful, nonempty, bounded summary for the exact
// checkpoint it was queued against. Every other path leaves the stored summary untouched.

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const THREAD = "00000000-0000-4000-8000-0000000000b1";
const access = { actorUserId: OWNER, requestId: "req-1" };

function message(index: number, body = `turn ${index}`, extra: Record<string, unknown> = {}) {
  return {
    id: `m${index}`,
    thread_id: THREAD,
    role: index % 2 === 1 ? "user" : "assistant",
    status: "stored",
    body,
    tool_metadata: null,
    ...extra
  };
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD,
    owner_user_id: OWNER,
    incognito: false,
    conversation_summary: null,
    summary_covered_through_message_id: null,
    summary_revision: 0,
    ...overrides
  };
}

const model = {
  id: "model-1",
  status: "active",
  provider_status: "active",
  provider_auth_method: "api_key",
  provider_kind: "openai",
  provider_purpose: "assistant",
  provider_config_id: "provider-1",
  provider_model_id: "economy-model",
  capabilities: ["summarization", "json"],
  updated_at: "2026-10-09T00:00:00Z"
};

const provider = {
  id: "provider-1",
  provider_kind: "openai",
  status: "active",
  auth_method: "api_key",
  purpose: "assistant",
  revoked_at: null,
  has_credential: true,
  encrypted_credential: "sealed-v1",
  acp_agent_id: null,
  updated_at: "2026-10-09T00:00:00Z",
  base_url: null
};

const payload: SummaryJobPayload = {
  actorUserId: OWNER,
  threadId: THREAD,
  expectedRevision: 0,
  expectedCoveredThroughMessageId: null,
  throughMessageId: "m4"
};

function setup(
  opts: {
    thread?: ReturnType<typeof thread> | null;
    messages?: ReturnType<typeof message>[];
    result?: unknown;
    publishResult?: "published" | "stale" | "missing";
    providerAfterRun?: Record<string, unknown>;
  } = {}
) {
  const messages = opts.messages ?? Array.from({ length: 6 }, (_, i) => message(i + 1));
  const prompts: string[] = [];
  let ran = false;
  const chatRepository = {
    getOwnedThreadById: vi
      .fn()
      .mockResolvedValue(opts.thread === undefined ? thread() : opts.thread),
    listMessages: vi.fn().mockResolvedValue(messages),
    publishConversationSummary: vi.fn().mockResolvedValue(opts.publishResult ?? "published")
  };
  const aiRepository = {
    selectModelForCapability: vi.fn().mockResolvedValue(model),
    selectProviderWithCredential: vi.fn(async () =>
      ran && opts.providerAfterRun ? { ...provider, ...opts.providerAfterRun } : provider
    )
  };
  const prepare = vi.fn(async (_db: unknown, input: { prompt: string }) => {
    prompts.push(input.prompt);
    return async () => {
      ran = true;
      return opts.result ?? { ok: true, object: { summary: "User chose blue for the logo." } };
    };
  });
  const enqueueNext = vi.fn().mockResolvedValue(undefined);
  const deps: { -readonly [K in keyof SummaryJobDeps]: SummaryJobDeps[K] } = {
    dataContext: {
      withDataContext: (_access: unknown, work: (db: never) => unknown) => work({} as never)
    } as never,
    chatRepository: chatRepository as never,
    aiRepository: aiRepository as never,
    cipher: {} as never,
    prepare: prepare as never,
    enqueueNext
  };
  return { deps, chatRepository, prepare, prompts, enqueueNext };
}

afterEach(() => vi.unstubAllEnvs());

describe("handleSummarizeConversationJob (#3156)", () => {
  it("publishes a valid summary against the exact checkpoint it was queued for", async () => {
    const { deps, chatRepository, prompts } = setup();
    await expect(handleSummarizeConversationJob(access, payload, deps)).resolves.toBe("published");
    expect(chatRepository.publishConversationSummary).toHaveBeenCalledWith(expect.anything(), {
      threadId: THREAD,
      expectedRevision: 0,
      expectedCoveredThroughMessageId: null,
      throughMessageId: "m4",
      summary: "User chose blue for the logo."
    });
    expect(prompts[0]).toContain("turn 4");
    expect(prompts[0]).not.toContain("turn 5");
  });

  it("folds the previous summary in and reads only turns after its frontier", async () => {
    const { deps, prompts } = setup({
      thread: thread({
        conversation_summary: "User chose blue.",
        summary_covered_through_message_id: "m2",
        summary_revision: 1
      })
    });
    const result = await handleSummarizeConversationJob(
      access,
      { ...payload, expectedRevision: 1, expectedCoveredThroughMessageId: "m2" },
      deps
    );
    expect(result).toBe("published");
    expect(prompts[0]).toContain("User chose blue.");
    expect(prompts[0]).not.toContain(`"turn 2"`);
    expect(prompts[0]).toContain("turn 3");
  });

  it.each([
    ["a failed model run", { ok: false, error: "provider_error" }, "failed"],
    ["an aborted model run", { ok: false, error: "aborted" }, "aborted"],
    ["an empty summary", { ok: true, object: { summary: "   " } }, "rejected"],
    ["a missing summary field", { ok: true, object: {} }, "rejected"],
    ["an oversized summary", { ok: true, object: { summary: "x".repeat(8000) } }, "rejected"]
  ])("does not publish %s", async (_label, result, outcome) => {
    const { deps, chatRepository } = setup({ result });
    await expect(handleSummarizeConversationJob(access, payload, deps)).resolves.toBe(outcome);
    expect(chatRepository.publishConversationSummary).not.toHaveBeenCalled();
  });

  it("does not publish after the caller cancels the run", async () => {
    const controller = new AbortController();
    const { deps, chatRepository } = setup();
    const prepare = deps.prepare!;
    deps.prepare = (async (...args: Parameters<typeof prepare>) => {
      const run = await prepare(...args);
      return async () => {
        const result = await run();
        controller.abort();
        return result;
      };
    }) as never;
    const outcome = await handleSummarizeConversationJob(access, payload, {
      ...deps,
      signal: controller.signal
    });
    expect(outcome).toBe("aborted");
    expect(chatRepository.publishConversationSummary).not.toHaveBeenCalled();
  });

  it.each([
    ["the thread is gone or owned by someone else", null],
    ["the thread belongs to another owner", thread({ owner_user_id: "someone-else" })],
    ["the thread is private", thread({ incognito: true })],
    ["the revision moved on", thread({ summary_revision: 3 })],
    ["the frontier moved on", thread({ summary_covered_through_message_id: "m2" })]
  ])("treats the job as stale when %s", async (_label, loaded) => {
    const { deps, chatRepository, prepare } = setup({ thread: loaded });
    await expect(handleSummarizeConversationJob(access, payload, deps)).resolves.toBe("stale");
    expect(prepare).not.toHaveBeenCalled();
    expect(chatRepository.publishConversationSummary).not.toHaveBeenCalled();
  });

  it("treats the job as stale when its end turn is no longer uncovered", async () => {
    const { deps, chatRepository, prepare } = setup();
    const outcome = await handleSummarizeConversationJob(
      access,
      { ...payload, throughMessageId: "gone" },
      deps
    );
    expect(outcome).toBe("stale");
    expect(prepare).not.toHaveBeenCalled();
    expect(chatRepository.publishConversationSummary).not.toHaveBeenCalled();
  });

  it("does not publish when the model route changed during the run", async () => {
    const { deps, chatRepository } = setup({
      providerAfterRun: { encrypted_credential: "sealed-v2" }
    });
    await expect(handleSummarizeConversationJob(access, payload, deps)).resolves.toBe(
      "unavailable"
    );
    expect(chatRepository.publishConversationSummary).not.toHaveBeenCalled();
  });

  it("withholds sensitive and meeting turns from the prompt", async () => {
    const messages = [
      message(1, "my api key is sk_live_ABCDEFGH12345678"),
      message(2, "meeting notes body", { tool_metadata: { meetingChatV1: { id: "x" } } }),
      message(3, "We decided on blue."),
      message(4, "Noted.")
    ];
    const { deps, prompts } = setup({ messages });
    await expect(handleSummarizeConversationJob(access, payload, deps)).resolves.toBe("published");
    expect(prompts[0]).not.toContain("sk_live_ABCDEFGH12345678");
    expect(prompts[0]).not.toContain("meeting notes body");
    expect(prompts[0]).toContain(WITHHELD_TURN);
    expect(prompts[0]).toContain("We decided on blue.");
  });

  it("does not queue more work when the publish lost the race", async () => {
    vi.stubEnv("JARVIS_CHAT_REPLAY_K", "1");
    const messages = Array.from({ length: 12 }, (_, i) => message(i + 1));
    const { deps, enqueueNext } = setup({ messages, publishResult: "stale" });
    await expect(handleSummarizeConversationJob(access, payload, deps)).resolves.toBe("stale");
    expect(enqueueNext).not.toHaveBeenCalled();
  });

  it("queues the next slice against the new checkpoint after a publish", async () => {
    vi.stubEnv("JARVIS_CHAT_REPLAY_K", "1");
    const messages = Array.from({ length: 12 }, (_, i) => message(i + 1));
    const { deps, enqueueNext } = setup({ messages });
    await expect(handleSummarizeConversationJob(access, payload, deps)).resolves.toBe("published");
    expect(enqueueNext).toHaveBeenCalledWith({
      actorUserId: OWNER,
      threadId: THREAD,
      expectedRevision: 1,
      expectedCoveredThroughMessageId: "m4",
      throughMessageId: "m11"
    });
  });

  it("reports an unavailable route instead of throwing", async () => {
    const { deps, chatRepository } = setup();
    (
      deps.aiRepository as unknown as { selectModelForCapability: ReturnType<typeof vi.fn> }
    ).selectModelForCapability.mockResolvedValue(null);
    await expect(handleSummarizeConversationJob(access, payload, deps)).resolves.toBe(
      "unavailable"
    );
    expect(chatRepository.publishConversationSummary).not.toHaveBeenCalled();
  });

  it("needs a ready constrained CLI before using a subscription sign-in", async () => {
    const { deps, chatRepository, prepare } = setup();
    const cliModel = { ...model, provider_auth_method: "cli", provider_kind: "anthropic" };
    const ai = deps.aiRepository as unknown as Record<string, ReturnType<typeof vi.fn>>;
    ai.selectModelForCapability!.mockResolvedValue(cliModel);
    ai.selectProviderWithCredential!.mockResolvedValue({
      ...provider,
      auth_method: "cli",
      provider_kind: "anthropic"
    });
    const outcome = await handleSummarizeConversationJob(access, payload, {
      ...deps,
      createConstrainedCliStructuredAdapter: vi.fn() as never,
      probeConstrainedCli: vi.fn().mockResolvedValue("subscription-isolation-unavailable")
    });
    expect(outcome).toBe("unavailable");
    expect(prepare).not.toHaveBeenCalled();
    expect(chatRepository.publishConversationSummary).not.toHaveBeenCalled();
  });

  it("never throws when a dependency fails", async () => {
    const { deps, chatRepository } = setup();
    deps.prepare = vi.fn().mockRejectedValue(new Error("boom")) as never;
    await expect(handleSummarizeConversationJob(access, payload, deps)).resolves.toBe("failed");
    expect(chatRepository.publishConversationSummary).not.toHaveBeenCalled();
  });
});
