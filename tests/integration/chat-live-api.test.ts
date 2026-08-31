/**
 * Integration tests for the live-chat HTTP/SSE API (Task 8).
 *
 * A FAKE engine factory is injected into createApiServer so no real tmux / `claude`
 * binary is touched. The fake engine serves a scripted reply per turn; the tests
 * assert the route persists a stored user+assistant turn, that an unauthenticated
 * turn is 401, and that the manager subscription is strictly per-actor (no
 * cross-user transcript leakage).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import Fastify from "fastify";

import { createApiServer } from "../../apps/api/src/server.js";
import { ChatRepository, CliChatUnavailableError, registerChatLiveRoutes } from "@moss/chat";
import { PageContextStore } from "../../packages/chat/src/live/page-context-store.js";
import type { ChatEngineFactory } from "@moss/module-registry";
import {
  DataContextRunner,
  SharesRepository,
  createDatabase,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import { ChatStreamLimitError } from "../../packages/chat/src/live/chat-session-manager.js";
import { normalizeChatSurface } from "../../packages/chat/src/live/chat-surface.js";
import type {
  CliChatEngine,
  EngineLaunchOpts,
  TranscriptRecord
} from "../../packages/chat/src/live/types.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/**
 * Fake live engine: launch/submit are no-ops; readNew returns a single scripted
 * reply + complete on the first call after each submit.
 */
class FakeLiveEngine implements CliChatEngine {
  private pending: TranscriptRecord[] = [];

  constructor(
    public readonly provider: CliChatEngine["provider"],
    private readonly sessionKey: string
  ) {}

  async launch(_opts: EngineLaunchOpts): Promise<{ offset: number }> {
    // The fake does not own a server-side replay drain (§4.1.2), so it returns offset 0 and the
    // manager keeps seeding/draining from its own post-launch drain, exactly as today.
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    this.pending = [{ kind: "reply", text: `echo:${text}` }];
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (this.pending.length === 0) {
      return { records: [], offset: afterOffset, complete: false };
    }
    const records = this.pending;
    this.pending = [];
    return { records, offset: afterOffset + 1, complete: true };
  }

  async isAlive(): Promise<boolean> {
    return true;
  }

  async kill(): Promise<void> {}

  async interrupt(): Promise<void> {}
}

const fakeEngineFactory: ChatEngineFactory = (provider, sessionKey) =>
  new FakeLiveEngine(provider, sessionKey);

/**
 * Every turn now carries a fresh `<current_time_context>` block ahead of the user's text
 * (#1869), and this suite runs against the real wall clock (no injected `now`), so the exact
 * timestamp is not asserted — only that the fake engine's echo wraps the original text with
 * that block still in front.
 */
function isTimeEchoOf(body: string, text: string): boolean {
  return body.startsWith("echo:<current_time_context>\n") && body.endsWith(`\n\n${text}`);
}

describe("Chat live API (turn / clear / switch / stream)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;
  let shares: SharesRepository;
  let server: ReturnType<typeof createApiServer>;
  let originalSecretKey: string | undefined;
  let providerId: string;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-chat-live-api-secret-key";

    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
    shares = new SharesRepository();
    server = createApiServer({
      appDb,
      logger: false,
      chatEngineFactory: fakeEngineFactory
    });
    await server.ready();

    // Seed an active chat-capable model for userA so resolveActiveProvider succeeds.
    const providerResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { providerKind: "anthropic", displayName: "Live API Provider", authMethod: "cli" }
    });
    providerId = providerResponse.json<{ provider: { id: string } }>().provider.id;
    await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerConfigId: providerId,
        providerModelId: "claude-live",
        displayName: "Claude Live",
        capabilities: ["chat"]
      }
    });
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  it("POST /api/chat/turn returns a reply and persists a stored user+assistant turn", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { text: "hello jarvis" }
    });

    expect(response.statusCode).toBe(200);
    expect(isTimeEchoOf(response.json<{ reply: string }>().reply, "hello jarvis")).toBe(true);

    // The turn is persisted as a stored user + stored assistant message in the
    // user's current conversation (no pg-boss job, born complete).
    const messages = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const thread = await repository.getCurrentThread(scopedDb, ids.userA);
      expect(thread).toBeDefined();
      return repository.listMessages(scopedDb, thread!.id);
    });

    const stored = messages.filter((m) => m.status === "stored");
    const user = stored.find((m) => m.role === "user");
    const assistant = stored.find((m) => m.role === "assistant");

    expect(user?.body).toBe("hello jarvis");
    expect(isTimeEchoOf(assistant?.body ?? "", "hello jarvis")).toBe(true);
    const metadata = assistant?.model_metadata as { executed?: { provider: string } };
    expect(metadata.executed?.provider).toBe("anthropic");
  });

  it("POST /api/chat/turn rejects an oversized module control context (#1194)", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { text: "hello", controlContext: { values: "x".repeat(8 * 1024) } }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "controlContext exceeds the 8192 byte limit" });
  });

  it("POST /api/chat/turn uses the user's allowed chat model override when enabled", async () => {
    const overrideModel = await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerConfigId: providerId,
        providerModelId: "claude-override",
        displayName: "Claude Override",
        capabilities: ["chat"],
        tier: "economy"
      }
    });
    const overrideId = overrideModel.json<{ model: { id: string } }>().model.id;

    const enabled = await server.inject({
      method: "PUT",
      url: "/api/admin/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { enabled: true }
    });
    const saved = await server.inject({
      method: "PUT",
      url: "/api/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { modelId: overrideId }
    });
    await server.inject({
      method: "POST",
      url: "/api/chat/switch",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    const overrideTurn = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { text: "override model" }
    });

    const disabled = await server.inject({
      method: "PUT",
      url: "/api/admin/ai/chat-model-override",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { enabled: false }
    });
    await server.inject({
      method: "POST",
      url: "/api/chat/switch",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    const defaultTurn = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { text: "default model" }
    });

    const messages = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const thread = await repository.getCurrentThread(scopedDb, ids.userA);
      expect(thread).toBeDefined();
      return repository.listMessages(scopedDb, thread!.id);
    });
    const overrideAssistant = messages.find(
      (m) => m.role === "assistant" && isTimeEchoOf(m.body, "override model")
    );
    const defaultAssistant = messages.find(
      (m) => m.role === "assistant" && isTimeEchoOf(m.body, "default model")
    );
    const overrideMetadata = overrideAssistant?.model_metadata as {
      executed?: { model?: string };
    };
    const defaultMetadata = defaultAssistant?.model_metadata as {
      executed?: { model?: string };
    };

    expect(overrideModel.statusCode).toBe(201);
    expect(enabled.statusCode).toBe(200);
    expect(saved.statusCode).toBe(200);
    expect(overrideTurn.statusCode).toBe(200);
    expect(overrideMetadata.executed?.model).toBe("claude-override");
    expect(disabled.statusCode).toBe(200);
    expect(defaultTurn.statusCode).toBe(200);
    expect(defaultMetadata.executed?.model).toBe("claude-live");
  });

  it("POST /api/chat/turn ignores an attached pageContext field — the turn contract is text-only (#1109)", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: {
        text: "hello text-only",
        pageContext: { route: "/forged", pageTitle: "Forged" }
      }
    });

    expect(response.statusCode).toBe(200);
    // The fake engine echoes back exactly what it received as engine text (§FakeLiveEngine.submit
    // above) other than the always-prepended time block; the echo ending in the original text
    // with nothing else folded in proves no <page_context> block was added server-side.
    expect(isTimeEchoOf(response.json<{ reply: string }>().reply, "hello text-only")).toBe(true);
  });

  it("POST /api/chat/turn without a session returns 401", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      payload: { text: "no auth" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("POST /api/chat/turn rejects text over the per-turn max before processing", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { text: "x".repeat(32_001) }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("text must be 32000 characters or fewer");
  });

  it("POST /api/chat/turn lets another user use the admin-configured instance default", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { text: "hello from user b" }
    });

    expect(response.statusCode).toBe(200);
    expect(isTimeEchoOf(response.json<{ reply: string }>().reply, "hello from user b")).toBe(true);
  });

  it("GET /api/chat/threads/:id/messages returns only the owner's stored thread messages", async () => {
    const thread = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const created = await repository.openNewThread(scopedDb, { title: "Historical thread" });
      await repository.recordCompletedTurn(scopedDb, created.id, "old question", "old answer", {
        provider: "anthropic",
        model: "claude-live"
      });
      return created;
    });

    const owner = await server.inject({
      method: "GET",
      url: `/api/chat/threads/${thread.id}/messages`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    const other = await server.inject({
      method: "GET",
      url: `/api/chat/threads/${thread.id}/messages`,
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });

    expect(owner.statusCode).toBe(200);
    expect(owner.json<{ messages: Array<{ body: string; role: string }> }>().messages).toEqual([
      expect.objectContaining({ role: "user", body: "old question" }),
      expect.objectContaining({ role: "assistant", body: "old answer" })
    ]);
    expect(other.statusCode).toBe(404);
  });

  it("GET /api/chat/threads/:id/messages returns 404 for a shared thread grantee", async () => {
    const thread = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const created = await repository.openNewThread(scopedDb, {
        title: "Shared historical thread"
      });
      await repository.recordCompletedTurn(
        scopedDb,
        created.id,
        "shared question",
        "shared answer",
        {
          provider: "anthropic",
          model: "claude-live"
        }
      );
      await shares.grant(scopedDb, {
        resourceType: "chat_thread",
        resourceId: created.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      });
      return created;
    });

    const response = await server.inject({
      method: "GET",
      url: `/api/chat/threads/${thread.id}/messages`,
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });

    expect(response.statusCode).toBe(404);
  });

  it("subscriptions are per-actor: user B's stream never receives user A's records", async () => {
    // Access the live runtime's manager directly via a second server instance that
    // shares the same DB but its own manager — instead, assert against the manager
    // behaviour: subscribe as B, run a turn as A, B sees nothing.
    //
    // We exercise this through the public manager API by reaching the runtime that
    // the routes built. The simplest deterministic assertion: subscribe two actors
    // and confirm records only fan out to the matching actor.
    const { createChatSessionRuntime } = await import("@moss/chat");
    const runtime = createChatSessionRuntime({
      dataContext,
      engineFactory: fakeEngineFactory
    });

    const aRecords: TranscriptRecord[] = [];
    const bRecords: TranscriptRecord[] = [];
    const unsubA = runtime.manager.subscribe(ids.userA, (r) => aRecords.push(r));
    const unsubB = runtime.manager.subscribe(ids.userB, (r) => bRecords.push(r));

    try {
      await runtime.manager.submitTurn(ids.userA, "User A", "private to A");
    } finally {
      unsubA();
      unsubB();
    }

    // A received its own records (at least the echoed user + reply); B received none.
    expect(aRecords.length).toBeGreaterThan(0);
    expect(bRecords).toHaveLength(0);
  });

  it("keeps drawer and surface sessions independent, including their persisted transcripts", async () => {
    const { createChatSessionRuntime } = await import("@moss/chat");
    const drawerSurface = normalizeChatSurface("drawer");
    const jobSearchSurface = normalizeChatSurface("job-search");
    const runtime = createChatSessionRuntime({
      dataContext,
      engineFactory: fakeEngineFactory
    });

    const drawerRecords: TranscriptRecord[] = [];
    const surfaceRecords: TranscriptRecord[] = [];
    const unsubscribeDrawer = runtime.manager.subscribe(
      ids.userA,
      (record) => {
        drawerRecords.push(record);
      },
      "drawer"
    );
    const unsubscribeSurface = runtime.manager.subscribe(
      ids.userA,
      (record) => {
        surfaceRecords.push(record);
      },
      "job-search"
    );

    try {
      await runtime.manager.submitTurn(ids.userA, "User A", "drawer-only", undefined, "drawer");
      await runtime.manager.submitTurn(
        ids.userA,
        "User A",
        "surface-only",
        undefined,
        "job-search"
      );

      expect(drawerRecords.map((record) => record.text).join("\n")).toContain("drawer-only");
      expect(drawerRecords.map((record) => record.text).join("\n")).not.toContain("surface-only");
      expect(surfaceRecords.map((record) => record.text).join("\n")).toContain("surface-only");
      expect(surfaceRecords.map((record) => record.text).join("\n")).not.toContain("drawer-only");

      const drawerBeforeClear = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.listThreadsByActivity(scopedDb, 50, drawerSurface)
      );
      const drawerThreadId = drawerBeforeClear[0]?.id;
      await runtime.manager.clear(ids.userA, undefined, "job-search");

      const [surfaceThreads, drawerThreads] = await dataContext.withDataContext(
        userAContext(),
        async (scopedDb) => [
          await repository.listThreadsByActivity(scopedDb, 50, jobSearchSurface),
          await repository.listThreadsByActivity(scopedDb, 50, drawerSurface)
        ]
      );
      expect(surfaceThreads.length).toBeGreaterThan(0);
      expect(drawerThreads.some((thread) => thread.id === drawerThreadId)).toBe(true);
    } finally {
      unsubscribeDrawer();
      unsubscribeSurface();
      runtime.shutdown();
    }
  });

  it("GET /api/chat/stream returns 429 when the actor has too many open streams", async () => {
    const app = Fastify({ logger: false });
    registerChatLiveRoutes(app, {
      resolveAccessContext: async () => userAContext(),
      runtime: {
        resolveUserName: async () => "User A",
        manager: {
          subscribe: () => {
            throw new ChatStreamLimitError();
          }
        }
      } as never,
      pageContextStore: newTestPageContextStore()
    });
    await app.ready();

    try {
      const response = await app.inject({ method: "GET", url: "/api/chat/stream" });

      expect(response.statusCode).toBe(429);
      expect(response.json<{ error: string }>().error).toBe("Too many open chat streams.");
    } finally {
      await app.close();
    }
  });

  it("POST /api/chat/private/end ends the authenticated actor's private session", async () => {
    const endPrivateSession = vi.fn().mockResolvedValue(undefined);
    const app = Fastify({ logger: false });
    registerChatLiveRoutes(app, {
      resolveAccessContext: async () => userAContext(),
      runtime: {
        resolveUserName: async () => "User A",
        manager: { endPrivateSession }
      } as never,
      pageContextStore: newTestPageContextStore()
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/chat/private/end",
        headers: { "content-type": "text/plain" },
        payload: ""
      });

      expect(response.statusCode).toBe(204);
      expect(endPrivateSession).toHaveBeenCalledWith(ids.userA, "drawer");
    } finally {
      await app.close();
    }
  });

  it("GET /api/chat/privacy returns the authenticated actor's current thread privacy state", async () => {
    const getPrivacyState = vi.fn().mockResolvedValue({ incognito: true });
    const app = Fastify({ logger: false });
    registerChatLiveRoutes(app, {
      resolveAccessContext: async () => userAContext(),
      runtime: {
        resolveUserName: async () => "User A",
        manager: { getPrivacyState }
      } as never,
      pageContextStore: newTestPageContextStore()
    });
    await app.ready();

    try {
      const response = await app.inject({ method: "GET", url: "/api/chat/privacy" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ incognito: true });
      expect(getPrivacyState).toHaveBeenCalledWith(ids.userA, "drawer");
    } finally {
      await app.close();
    }
  });

  it("POST /api/chat/evening-interview seeds hidden context then starts a prep turn", async () => {
    const calls: string[] = [];
    const app = Fastify({ logger: false });
    registerChatLiveRoutes(app, {
      resolveAccessContext: async () => userAContext(),
      runtime: {
        resolveUserName: async () => "User A",
        resolveEveningInterviewSeed: async (_actorUserId: string, briefingRunId?: string) => ({
          context:
            "<trusted_instructions>\nEvening interview seed.\n</trusted_instructions>\n\n" +
            '<external_source type="evening_review">\nSeed from ' +
            (briefingRunId ?? "today") +
            "\n</external_source>",
          openingPrompt: "Prep me for tomorrow."
        }),
        manager: {
          seedContext: async (_actorUserId: string, _userName: string, seed: string) => {
            calls.push(`seed:${seed}`);
          },
          submitTurn: async (_actorUserId: string, _userName: string, text: string) => {
            calls.push(`turn:${text}`);
            return { reply: "started" };
          }
        }
      } as never,
      pageContextStore: newTestPageContextStore()
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/chat/evening-interview",
        payload: { briefingRunId: "run-1" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ reply: string }>()).toEqual({ reply: "started" });
      expect(calls[0]).toContain('<external_source type="evening_review">');
      expect(calls[0]).toContain("run-1");
      expect(calls[1]).toBe("turn:Prep me for tomorrow.");
    } finally {
      await app.close();
    }
  });

  it("does not write SSE records after the stream response is ended", async () => {
    const app = Fastify({ logger: false });
    let onRecord: ((record: TranscriptRecord) => void) | undefined;
    let writes = 0;

    app.addHook("onRequest", (_request, reply, done) => {
      const raw = reply.raw;
      raw.writeHead = (() => raw) as typeof raw.writeHead;
      raw.write = (() => {
        writes += 1;
        return true;
      }) as typeof raw.write;
      raw.end();
      done();
    });
    registerChatLiveRoutes(app, {
      resolveAccessContext: async () => userAContext(),
      runtime: {
        resolveUserName: async () => "User A",
        manager: {
          subscribe: (_actorUserId: string, fn: (record: TranscriptRecord) => void) => {
            onRecord = fn;
            return () => undefined;
          }
        }
      } as never,
      pageContextStore: newTestPageContextStore()
    });
    await app.ready();

    try {
      await app.inject({ method: "GET", url: "/api/chat/stream" });
      onRecord?.({ kind: "reply", text: "late" });

      expect(writes).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("Chat live API — no multiplexer available", () => {
  let appDb: Kysely<MossDatabase>;
  let server: ReturnType<typeof createApiServer>;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-chat-live-api-secret-key";

    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    server = createApiServer({
      appDb,
      logger: false,
      // A factory that refuses to launch — mirrors a host with no tmux/herdr installed.
      chatEngineFactory: () => {
        throw new CliChatUnavailableError("no terminal multiplexer (tmux/herdr) installed");
      }
    });
    await server.ready();

    // Seed an active chat-capable model for userA so resolveActiveProvider succeeds
    // and the failure surfaces at engine-launch (503), not at provider resolution.
    const providerResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { providerKind: "anthropic", displayName: "Live API Provider", authMethod: "cli" }
    });
    const providerId = providerResponse.json<{ provider: { id: string } }>().provider.id;
    await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerConfigId: providerId,
        providerModelId: "claude-live",
        displayName: "Claude Live",
        capabilities: ["chat"]
      }
    });
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  it("returns 503 when no multiplexer is available", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { text: "hello jarvis" }
    });
    expect(res.statusCode).toBe(503);
  });

  it("PUT /api/chat/page-context stores the actor's view, isolated from other actors (#1109)", async () => {
    const store = newTestPageContextStore();
    const app = Fastify({ logger: false });
    let resolveAs = userAContext();
    registerChatLiveRoutes(app, {
      resolveAccessContext: async () => resolveAs,
      runtime: { resolveUserName: async () => "User A", manager: {} } as never,
      pageContextStore: store
    });
    await app.ready();
    try {
      const putRes = await app.inject({
        method: "PUT",
        url: "/api/chat/page-context",
        payload: {
          snapshot: {
            route: "/news",
            pageTitle: "News",
            headings: [],
            buttons: [],
            labels: [],
            visibleText: ["Unavailable"],
            focused: null,
            selectedText: null,
            errors: [],
            capturedAt: "2026-07-16T00:00:00.000Z"
          }
        }
      });
      expect(putRes.statusCode).toBe(204);
      expect(store.get(ids.userA)).toMatchObject({ snapshot: { route: "/news" } });

      // A different actor never sees user A's stored view.
      resolveAs = userBContext();
      expect(store.get(ids.userB)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("PUT /api/chat/page-context 400s on a malformed snapshot", async () => {
    const app = Fastify({ logger: false });
    registerChatLiveRoutes(app, {
      resolveAccessContext: async () => userAContext(),
      runtime: { resolveUserName: async () => "User A", manager: {} } as never,
      pageContextStore: newTestPageContextStore()
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/chat/page-context",
        payload: { snapshot: { route: 123 } }
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("Chat live API — engine factory selection (RPC vs in-process)", () => {
  it("selects the RPC client when JARVIS_CLI_RUNNER_SOCKET is set", async () => {
    const { selectEngineFactory, ChatEngineRpcClient } = await import("@moss/chat");
    const { factory, connection } = selectEngineFactory({
      env: {
        JARVIS_CLI_RUNNER_SOCKET: "/run/jarv1s/cli-runner.sock",
        JARVIS_CLI_RUNNER_RPC_SECRET: "test-secret"
      } as NodeJS.ProcessEnv
    });
    try {
      const engine = await factory("anthropic", ids.userA);
      expect(engine).toBeInstanceOf(ChatEngineRpcClient);
      expect(engine.provider).toBe("anthropic");
      expect(connection).toBeDefined();
    } finally {
      connection?.close();
    }
  });

  it("falls back to the in-process engine when the socket env is absent", async () => {
    const { selectEngineFactory, ChatEngineRpcClient } = await import("@moss/chat");
    const { factory, connection } = selectEngineFactory({ env: {} as NodeJS.ProcessEnv });
    const engine = factory("anthropic", ids.userA);
    expect(engine).not.toBeInstanceOf(ChatEngineRpcClient);
    expect(connection).toBeUndefined();
  });
});

function userAContext(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:chat-live-api-a" };
}

function userBContext(): AccessContext {
  return { actorUserId: ids.userB, requestId: "request:chat-live-api-b" };
}

function newTestPageContextStore(): PageContextStore {
  return new PageContextStore({ now: () => Date.now(), ttlMs: 300_000 });
}
