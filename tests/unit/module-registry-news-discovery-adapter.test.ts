import { beforeEach, describe, expect, it, vi } from "vitest";

import { CliChatUnavailableError, type ChatEngineFactory } from "@moss/chat";
import type { AccessContext, DataContextDb } from "@moss/db";
import { getBuiltInModuleRegistrations } from "@moss/module-registry";
import type * as AiModule from "@moss/ai";
import type * as NewsModule from "@moss/news";
import type { NewsFetchOptions, RedditFetchOptions } from "@moss/news";
import type * as WebResearchModule from "@moss/web-research";

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

const webResearchCapture = vi.hoisted(() => ({
  calls: [] as { url: string; options: Record<string, unknown> | undefined }[],
  result: undefined as unknown
}));

// #2282 task 1.5: capture the options the News ports hand to the shared web fetch helper, so the
// tests below can prove which gates each port keeps without touching the network.
vi.mock("@moss/web-research", async (importOriginal) => {
  const actual = await importOriginal<typeof WebResearchModule>();
  return {
    ...actual,
    fetchWebResource: vi.fn(async (url: string, options?: Record<string, unknown>) => {
      webResearchCapture.calls.push({ url, options });
      return (
        webResearchCapture.result ?? {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "text/html",
          body: "",
          truncated: false,
          bytesRead: 0,
          hopCount: 0
        }
      );
    })
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

/** Registers the News routes against a fake server and returns the discovery ports it was given. */
function captureNewsDiscovery(): unknown {
  newsRoutesCapture.discovery = undefined;
  const registration = getBuiltInModuleRegistrations().find((item) => item.manifest.id === "news");
  expect(registration?.registerRoutes).toBeDefined();
  const fakeServer = { log: fakeLogger(), post: vi.fn(), get: vi.fn() };
  registration!.registerRoutes!(
    fakeServer as never,
    {
      rootDb: {} as never,
      dataContext: {} as never,
      resolveAccessContext: async () => ({}) as AccessContext,
      boss: {} as never,
      chatEngineFactory: (() => {
        throw new CliChatUnavailableError("chat engine factory is not resolved yet");
      }) as ChatEngineFactory,
      createCliStructuredAdapter: (() => ({
        generateStructured: async () => ({
          rawObject: {},
          usage: { inputTokens: 0, outputTokens: 0 }
        })
      })) as never
    } as never
  );
  expect(newsRoutesCapture.discovery).toBeDefined();
  return newsRoutesCapture.discovery;
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

describe("news fetch port with options (#2282 task 1.5)", () => {
  type Ports = {
    fetch: (url: string) => Promise<unknown>;
    fetchWithOptions: (url: string, options?: NewsFetchOptions) => Promise<unknown>;
  };
  const ports = () => captureNewsDiscovery() as Ports;
  const lastOptions = () => {
    expect(webResearchCapture.calls).toHaveLength(1);
    return webResearchCapture.calls[0]!.options!;
  };

  beforeEach(() => {
    webResearchCapture.calls.length = 0;
    webResearchCapture.result = undefined;
  });

  it("keeps the robots gate and the News rate limiter by default", async () => {
    await ports().fetchWithOptions("https://example.com/feed.xml");
    const options = lastOptions();
    expect(options.requireHttps).toBe(true);
    expect(options.robots).toBeDefined();
    expect(options.rateLimiter).toBeDefined();
  });

  it("drops the robots gate when skipRobots is set and forwards the Reddit reader's options", async () => {
    const beforeRequest = () => true;
    const signal = new AbortController().signal;
    const readerOptions: RedditFetchOptions = {
      allowedHosts: ["www.reddit.com"],
      requestHeaders: { accept: "application/json" },
      userAgent: "jarv1s-news/1.0",
      allowedContentTypes: ["application/json"],
      beforeRequest,
      maxBytes: 1024,
      rejectOversizedResponses: true,
      timeoutMs: 5000,
      signal,
      skipRobots: true
    };
    await ports().fetchWithOptions("https://www.reddit.com/r/news/top.json", readerOptions);
    const options = lastOptions();
    expect(options.robots).toBeUndefined();
    expect(options.rateLimiter).toBeDefined();
    expect(options).toMatchObject({
      requireHttps: true,
      allowedHosts: ["www.reddit.com"],
      requestHeaders: { accept: "application/json" },
      userAgent: "jarv1s-news/1.0",
      allowedContentTypes: ["application/json"],
      maxBytes: 1024,
      rejectOversizedResponses: true,
      timeoutMs: 5000
    });
    expect(options.beforeRequest).toBe(beforeRequest);
    expect(options.signal).toBe(signal);
    expect("skipRobots" in options).toBe(false);
  });

  it("passes the helper's rate-limit Retry-After and failure detail through unchanged", async () => {
    webResearchCapture.result = {
      ok: false,
      reason: "rate_limited",
      status: 429,
      retryAfter: "30"
    };
    await expect(
      ports().fetchWithOptions("https://www.reddit.com/r/news/top.json", { skipRobots: true })
    ).resolves.toEqual({ ok: false, reason: "rate_limited", status: 429, retryAfter: "30" });

    webResearchCapture.calls.length = 0;
    webResearchCapture.result = { ok: false, reason: "http_error", detail: "response_too_large" };
    await expect(ports().fetchWithOptions("https://example.com/big.xml")).resolves.toEqual({
      ok: false,
      reason: "http_error",
      detail: "response_too_large"
    });
  });

  it("the URL-only fetch port still applies the robots gate for every current caller", async () => {
    await ports().fetch("https://example.com/");
    const options = lastOptions();
    expect(options.robots).toBeDefined();
    expect(options.rateLimiter).toBeDefined();
  });
});
