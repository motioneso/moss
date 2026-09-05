import { describe, expect, it, vi } from "vitest";

import type { AiRepository } from "@moss/ai";
import { createCliStructuredAdapterFactory, type ChatEngineFactory } from "@moss/chat";
import type { DataContextDb } from "@moss/db";

import { buildEmailExtractDeps } from "../../packages/connectors/src/extract-deps.js";
import {
  extractEmailSignals,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

const ACTIONABLE_SIGNALS = {
  category: "needs_action",
  reason: "The sender requests approval.",
  action: "Approve the launch plan",
  confidence: 0.95
};

const MODEL = {
  id: "model-fixture",
  provider_config_id: "provider-fixture",
  provider_kind: "anthropic",
  provider_model_id: "model-fixture",
  tier: "economy"
};

const FIXTURE: ParsedEmail = {
  externalId: "synthetic-binding",
  historyId: "history-binding",
  subject: "Synthetic request",
  from: "sender@example.invalid",
  recipients: ["recipient@example.invalid"],
  receivedAt: "2026-08-01T12:00:00.000Z",
  labelIds: ["INBOX"],
  snippet: "A harmless synthetic request.",
  body: "Please complete this harmless synthetic request.",
  bodyTruncated: false
};

describe("buildEmailExtractDeps", () => {
  it("does not silently inherit the instance-default CLI when email extraction is unbound", async () => {
    const repository = {
      getModuleServiceBinding: vi.fn(async () => null),
      resolveModelForService: vi.fn(async (_db, _service, options) =>
        options.requireExplicitBinding
          ? { model: null, reason: "needs-config" as const }
          : { model: MODEL, reason: "matched-active-model" as const }
      ),
      selectProviderWithCredential: vi.fn(async () => ({
        auth_method: "cli",
        encrypted_credential: { marker: "sealed" },
        base_url: null
      }))
    } as unknown as AiRepository;
    const createCliStructuredAdapter = vi.fn(() => ({
      generateStructured: vi.fn(async () => ({
        rawObject: ACTIONABLE_SIGNALS,
        usage: { inputTokens: 1, outputTokens: 1 }
      }))
    }));
    const deps = buildEmailExtractDeps(
      {} as DataContextDb,
      repository,
      { decryptJson: vi.fn() } as never,
      { createCliStructuredAdapter }
    );

    await expect(extractEmailSignals(FIXTURE, deps)).rejects.toThrow(/needs.?config/i);
    expect(createCliStructuredAdapter).not.toHaveBeenCalled();
  });

  it("follows two explicit Settings bindings without an extractor-owned tier or transport choice", async () => {
    const apiModel = {
      ...MODEL,
      id: "api-model",
      provider_config_id: "api-provider",
      provider_kind: "openai-compatible",
      tier: "reasoning"
    };
    const cliModel = {
      ...MODEL,
      id: "cli-model",
      provider_config_id: "cli-provider",
      tier: "interactive"
    };
    let selected = apiModel;
    const repository = {
      getModuleServiceBinding: vi.fn(async () => ({ kind: "model", modelId: selected.id })),
      resolveModelForService: vi.fn(async () => ({
        model: selected,
        reason: "manual-route" as const
      })),
      selectProviderWithCredential: vi.fn(async (_db, providerId: string) =>
        providerId === "cli-provider"
          ? { auth_method: "cli", encrypted_credential: { marker: "sealed" }, base_url: null }
          : {
              auth_method: "api_key",
              encrypted_credential: { ciphertext: "sealed" },
              base_url: null
            }
      )
    } as unknown as AiRepository;
    const apiGenerate = vi.fn(async () => ({
      rawObject: ACTIONABLE_SIGNALS,
      usage: { inputTokens: 1, outputTokens: 1 }
    }));
    const cliGenerate = vi.fn(async () => ({
      rawObject: ACTIONABLE_SIGNALS,
      usage: { inputTokens: 1, outputTokens: 1 }
    }));
    const createAdapter = vi.fn(() => ({ generateStructured: apiGenerate }));
    const createCliStructuredAdapter = vi.fn(() => ({ generateStructured: cliGenerate }));
    const deps = buildEmailExtractDeps(
      {} as DataContextDb,
      repository,
      { decryptJson: vi.fn(() => ({ apiKey: "fixture-key" })) } as never,
      { createAdapter, createCliStructuredAdapter }
    );

    const apiResult = await extractEmailSignals(FIXTURE, deps);
    selected = cliModel;
    const cliResult = await extractEmailSignals(
      { ...FIXTURE, externalId: "synthetic-binding-cli" },
      deps
    );
    const scope = {
      actorUserId: "actor-1",
      connectorAccountId: "account-1",
      lineageId: "run-1"
    };
    await deps.runChat("synthetic scoped call", undefined, 1, undefined, "foreground", scope, true);

    expect([apiResult.summary, cliResult.summary]).toEqual([FIXTURE.snippet, FIXTURE.snippet]);
    expect(createAdapter).toHaveBeenCalledTimes(1);
    expect(createCliStructuredAdapter).toHaveBeenCalledTimes(2);
    expect(cliGenerate).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope, closeScope: true })
    );
  });

  it("rejects a late reply after caller cancellation and releases the slot for the next call", async () => {
    const repository = {
      resolveModelForService: vi.fn(async () => ({
        model: MODEL,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(async () => ({
        auth_method: "cli",
        encrypted_credential: { marker: "sealed" },
        base_url: null
      }))
    } as unknown as AiRepository;
    let engineIndex = 0;
    const killed = new Set<number>();
    let cancelledEngineStoppedBeforeNext = false;
    const engineFactory: ChatEngineFactory = vi.fn(() => {
      const index = engineIndex++;
      if (index === 2) cancelledEngineStoppedBeforeNext = killed.has(1);
      return {
        provider: "anthropic" as const,
        launch: vi.fn(async () => ({ offset: 0 })),
        submit: vi.fn(async () => undefined),
        readNew: vi.fn(async () => {
          if (index === 1) await new Promise((resolve) => setTimeout(resolve, 250));
          return {
            records: [{ kind: "reply" as const, text: JSON.stringify(ACTIONABLE_SIGNALS) }],
            offset: 1,
            complete: true
          };
        }),
        interrupt: vi.fn(async () => undefined),
        isAlive: vi.fn(async () => false),
        kill: vi.fn(async () => {
          killed.add(index);
        })
      };
    });
    const warn = vi.fn();
    const deps = buildEmailExtractDeps(
      {} as DataContextDb,
      repository,
      { decryptJson: vi.fn() } as never,
      {
        createCliStructuredAdapter: createCliStructuredAdapterFactory(engineFactory),
        logger: { info: vi.fn(), warn }
      }
    );
    const fixtures: ParsedEmail[] = ["one", "two", "three"].map((id) => ({
      externalId: `synthetic-${id}`,
      historyId: `history-${id}`,
      subject: `Synthetic request ${id}`,
      from: "sender@example.invalid",
      recipients: ["recipient@example.invalid"],
      receivedAt: "2026-08-01T12:00:00.000Z",
      labelIds: ["INBOX"],
      snippet: "A harmless synthetic request.",
      body: `Please complete harmless synthetic request ${id}.`,
      bodyTruncated: false
    }));
    const outcomes = [];

    for (const fixture of fixtures) {
      const startedAt = performance.now();
      const result = await extractEmailSignals(fixture, deps, { callTimeoutMs: 100 });
      const elapsedMs = Math.round(performance.now() - startedAt);
      const actionability = result.signals.actionability;
      outcomes.push({
        summary: result.summary !== null,
        complete:
          Boolean(actionability?.inferredSubject) &&
          Boolean(actionability?.suggestedTasks?.length) &&
          (result.signals.confidence ?? 0) > 0,
        category:
          result.summary !== null ? "ok" : elapsedMs >= 80 ? "caller_timeout" : "provider_busy",
        elapsedMs
      });
    }
    expect(
      outcomes.map(({ summary, complete, category }) => ({ summary, complete, category })),
      `sanitized outcomes: ${JSON.stringify(outcomes)}`
    ).toEqual([
      { summary: true, complete: true, category: "ok" },
      // A caller timeout cancels authority to accept even a valid late reply.
      { summary: false, complete: false, category: "caller_timeout" },
      { summary: true, complete: true, category: "ok" }
    ]);
    expect(cancelledEngineStoppedBeforeNext).toBe(true);
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "CLI structured generation is already busy" }),
      "ai.structured provider error"
    );
  });

  it("routes a CLI-marker provider through the existing structured transport", async () => {
    const repository = {
      selectModelForCapability: vi.fn(async () => MODEL),
      resolveModelForService: vi.fn(async () => ({
        model: MODEL,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(async () => ({
        auth_method: "cli",
        encrypted_credential: { marker: "sealed" },
        base_url: null
      }))
    } as unknown as AiRepository;
    const decryptJson = vi.fn(() => ({ cli: true }));
    const engineFactory: ChatEngineFactory = vi.fn(() => ({
      provider: "anthropic" as const,
      launch: vi.fn(async () => ({ offset: 0 })),
      submit: vi.fn(async () => undefined),
      readNew: vi.fn(async () => ({
        records: [{ kind: "reply" as const, text: JSON.stringify(ACTIONABLE_SIGNALS) }],
        offset: 1,
        complete: true
      })),
      interrupt: vi.fn(async () => undefined),
      isAlive: vi.fn(async () => false),
      kill: vi.fn(async () => undefined)
    }));
    const deps = buildEmailExtractDeps({} as DataContextDb, repository, { decryptJson } as never, {
      createCliStructuredAdapter: createCliStructuredAdapterFactory(engineFactory)
    });

    const reply = await deps.runChat("Extract actionable email signals.");

    expect(JSON.parse(reply.text)).toEqual(ACTIONABLE_SIGNALS);
    expect(engineFactory).toHaveBeenCalledTimes(1);
    expect(decryptJson).not.toHaveBeenCalled();
  });

  it("preserves the API-key structured transport", async () => {
    const repository = {
      resolveModelForService: vi.fn(async () => ({
        model: MODEL,
        reason: "matched-active-model" as const
      })),
      selectProviderWithCredential: vi.fn(async () => ({
        auth_method: "api_key",
        encrypted_credential: { ciphertext: "sealed" },
        base_url: null
      }))
    } as unknown as AiRepository;
    const decryptJson = vi.fn(() => ({ apiKey: "fixture-key" }));
    const generateStructured = vi.fn(async () => ({
      rawObject: ACTIONABLE_SIGNALS,
      usage: { inputTokens: 1, outputTokens: 1 }
    }));
    const createAdapter = vi.fn(() => ({ generateStructured }));
    const createCliStructuredAdapter = vi.fn();
    const deps = buildEmailExtractDeps({} as DataContextDb, repository, { decryptJson } as never, {
      createAdapter,
      createCliStructuredAdapter
    });

    const signal = new AbortController().signal;
    const reply = await deps.runChat(
      "Extract actionable email signals.",
      signal,
      1,
      undefined,
      "background"
    );

    expect(JSON.parse(reply.text)).toEqual(ACTIONABLE_SIGNALS);
    expect(createAdapter).toHaveBeenCalledTimes(1);
    expect(generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ signal, priority: "background" })
    );
    expect(decryptJson).toHaveBeenCalledTimes(1);
    expect(createCliStructuredAdapter).not.toHaveBeenCalled();
  });
});
