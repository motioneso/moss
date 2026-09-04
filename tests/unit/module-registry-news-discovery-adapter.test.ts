import { describe, expect, it, vi } from "vitest";

import { CliChatUnavailableError, type ChatEngineFactory } from "@moss/chat";
import type { AccessContext, DataContextDb } from "@moss/db";
import { getBuiltInModuleRegistrations } from "@moss/module-registry";
import type * as AiModule from "@moss/ai";
import type * as NewsModule from "@moss/news";

/**
 * #2229: Settings > News > Add a source always failed with
 * "news.add_source.discovery_unavailable" when the API runs behind the cli-runner socket
 * (prod compose and the dev box). The cause was `buildNewsDiscoveryPorts` building its own
 * structured-AI adapter from the raw, late-bound `deps.chatEngineFactory` bridge, whose
 * `resolvedChatFactory` is only ever populated on the in-process path — on the socket path it
 * always throws "chat engine factory is not resolved yet". The fix threads the already-working
 * `deps.createCliStructuredAdapter` (built from `structuredChatEngineFactory`, which handles the
 * socket path correctly) into news discovery instead.
 *
 * This test proves the news route registration now wires the working adapter even when the raw
 * chat-engine factory is the still-broken, unresolved bridge — reproducing the socket-configured
 * production shape without a real cli-runner process or database.
 */

const newsRoutesCapture = vi.hoisted(() => ({
  discovery: undefined as unknown
}));

vi.mock("@moss/news", async (importOriginal) => {
  const actual = await importOriginal<typeof NewsModule>();
  return {
    ...actual,
    registerNewsRoutes: vi.fn((_server: unknown, deps: { discovery: unknown }) => {
      newsRoutesCapture.discovery = deps.discovery;
    })
  };
});

const fakeAiCapture = vi.hoisted(() => ({
  providerId: "provider-1",
  modelId: "model-1"
}));

vi.mock("@moss/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  class FakeAiRepository {
    async resolveModelForService() {
      return {
        model: {
          id: fakeAiCapture.modelId,
          provider_config_id: fakeAiCapture.providerId,
          provider_kind: "anthropic",
          provider_model_id: "claude-sonnet-5"
        }
      };
    }
    async selectProviderWithCredential() {
      // A CLI-auth provider: the branch that used to reach the unresolved bridge.
      return { auth_method: "cli", base_url: null, encrypted_credential: null };
    }
  }
  return {
    ...actual,
    AiRepository: FakeAiRepository
  };
});

function fakeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    child: () => logger
  };
  return logger;
}

describe("news discovery source preview (#2229)", () => {
  it("uses the resolving structured adapter, not the unresolved chat-engine bridge, on the socket path", async () => {
    newsRoutesCapture.discovery = undefined;

    const registration = getBuiltInModuleRegistrations().find(
      (item) => item.manifest.id === "news"
    );
    expect(registration?.registerRoutes).toBeDefined();

    // Mirrors the socket-configured production shape: the raw late-bound bridge always throws,
    // because its onReady resolver is skipped when a cli-runner socket is configured.
    const brokenChatEngineFactory: ChatEngineFactory = () => {
      throw new CliChatUnavailableError("chat engine factory is not resolved yet");
    };

    // Mirrors deps.createCliStructuredAdapter as built by the composition root from
    // structuredChatEngineFactory, which resolves correctly against a stub RPC connection.
    const workingCreateCliStructuredAdapter = () => ({
      generateStructured: async () => ({
        rawObject: { allowed: true, category: "news_publisher" },
        usage: { inputTokens: 10, outputTokens: 5 }
      })
    });

    const fakeServer = { log: fakeLogger(), post: vi.fn(), get: vi.fn() };

    registration!.registerRoutes!(
      fakeServer as never,
      {
        rootDb: {} as never,
        dataContext: {} as never,
        resolveAccessContext: async () => ({}) as AccessContext,
        boss: {} as never,
        chatEngineFactory: brokenChatEngineFactory,
        createCliStructuredAdapter: workingCreateCliStructuredAdapter as never
      } as never
    );

    const discovery = newsRoutesCapture.discovery as {
      ai: {
        generateJson(
          scopedDb: DataContextDb,
          input: { schema: Record<string, unknown>; prompt: string }
        ): Promise<{ ok: true; object: unknown } | { ok: false; error: string }>;
      };
    };
    expect(discovery).toBeDefined();

    const result = await discovery.ai.generateJson({} as DataContextDb, {
      schema: { type: "object" },
      prompt: "is this a news publisher?"
    });

    expect(result).toMatchObject({
      ok: true,
      object: { allowed: true, category: "news_publisher" }
    });
  });
});
