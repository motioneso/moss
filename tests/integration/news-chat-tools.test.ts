// tests/integration/news-chat-tools.test.ts
//
// News Slice 4 Task 7 (#975): news.previewSource / news.confirmSource drive the
// SAME machinery assistant chat uses (AssistantToolGateway), not the REST route —
// the REST invoke path can only 403 a write tool. Proven here end-to-end:
// preview runs unconfirmed (read risk) and returns verified candidates; confirm
// is gated by default (news_personalization family defaults to ask_each_time —
// see Task 10 classification in packages/news/src/manifest.ts), nothing executes
// until the owner resolves the pending action; a tampered resubmitted domain is a
// security violation (execute throws, sanitized error, no row); a cross-owner
// confirmationId replay dies as "expired" (preview store is owner-checked); and
// no tool output ever leaks provider/model fingerprint material.
//
// Task 8 (#975) write tools (removeSource/addTopic/removeTopic/addExclusion) are
// split into tests/integration/news-chat-tools-write-tools.test.ts, sharing this
// file's setup and helpers via tests/integration/news-chat-tools-harness.ts.
//
// Harness skeleton: tests/integration/js08-decide-confirm-audit.test.ts.
// Discovery/availability stubs: tests/integration/news-personalization-routes.test.ts.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApiServer } from "../../apps/api/src/server.js";
import { AiRepository, SessionTokenRegistry, createPlatformDiagnosticsService } from "@moss/ai";
import {
  createNewsDiagnosticsProvider,
  enqueueNewsRefresh,
  registerNewsJobWorkers
} from "@moss/news";
import type { ChatEngineFactory } from "@moss/module-registry";
import type {
  CliChatEngine,
  EngineLaunchOpts,
  TranscriptRecord
} from "../../packages/chat/src/live/types.js";

import { ids } from "./test-database.js";
import {
  NewsChatToolsHarness,
  feedForRefresh,
  parseToolText,
  type McpResponse,
  type PreviewPayload
} from "./news-chat-tools-harness.js";

class DeterministicDiagnosticsEngine implements CliChatEngine {
  private launchOptions: EngineLaunchOpts | undefined;
  private pending: TranscriptRecord[] = [];

  constructor(
    public readonly provider: CliChatEngine["provider"],
    private readonly invokeMcp: (
      token: string,
      request: { readonly name: string; readonly arguments: Record<string, unknown> }
    ) => Promise<McpResponse>
  ) {}

  async launch(options: EngineLaunchOpts): Promise<{ offset: number }> {
    this.launchOptions = options;
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    const toolName = text.includes("UAT-2032-refresh")
      ? "news.refreshNews"
      : "settings.platformDiagnostics";
    const response = await this.invokeMcp(this.launchOptions?.mcpToken ?? "", {
      name: toolName,
      arguments: toolName === "settings.platformDiagnostics" ? { module: "news" } : {}
    });
    const content = response.result?.content?.[0]?.text;
    if (response.result?.isError || !content) throw new Error(`MCP ${toolName} failed`);

    if (toolName === "news.refreshNews") {
      this.pending = [
        { kind: "tool", text: toolName, toolName },
        { kind: "reply", text: "Refresh accepted and queued; work is still pending." }
      ];
      return;
    }

    const report = JSON.parse(content) as {
      readonly modules?: readonly {
        readonly status?: string;
        readonly facts?: Record<string, unknown>;
      }[];
    };
    const facts = report.modules?.[0]?.facts ?? {};
    this.pending = [
      { kind: "tool", text: toolName, toolName },
      {
        kind: "reply",
        text: `News is ${report.modules?.[0]?.status ?? "unknown"}; last success ${String(facts.lastSuccessAt)}, latest attempt ${String(facts.lastAttemptAt)}, ${String(facts.itemCount)} items.`
      }
    ];
  }

  async readNew(afterOffset: number) {
    if (this.pending.length === 0) return { records: [], offset: afterOffset, complete: false };
    const records = this.pending;
    this.pending = [];
    return { records, offset: afterOffset + records.length, complete: true };
  }

  async isAlive(): Promise<boolean> {
    return true;
  }

  async kill(): Promise<void> {}

  async interrupt(): Promise<void> {}
}

describe("news chat tools — previewSource/confirmSource via assistant gateway (#975)", () => {
  const harness = new NewsChatToolsHarness();

  beforeAll(async () => harness.setup(), 60_000);
  afterAll(async () => harness.teardown());

  it("previewSource runs unconfirmed (read risk) and returns verified candidates", async () => {
    const { gateway, emitted, mint } = harness.makeGateway();
    const token = mint(ids.userA, "news-chat-preview");

    const result = await gateway.callTool(token, "news.previewSource", {
      source: "https://example.com/feed.xml"
    });
    expect(result).toMatchObject({ ok: true });
    // Read-risk tool: no confirmation round-trip happened.
    expect(emitted.filter((entry) => entry.kind === "action_request")).toHaveLength(0);

    const payload = parseToolText(result) as unknown as PreviewPayload;
    expect(typeof payload.confirmationId).toBe("string");
    expect(payload.candidates[0]).toMatchObject({ domain: "example.com" });
    // Validation fingerprints are provider/model-derived — never in tool output.
    expect(JSON.stringify(result)).not.toContain("fingerprint");
  }, 30_000);

  it("diagnoses, refreshes, and rechecks through the real service and worker", async () => {
    const diagnostics = createPlatformDiagnosticsService({
      appMap: { getBuildInfo: () => ({ version: "test", buildId: "test-build" }) },
      repository: new AiRepository(),
      moduleProviders: async () => [
        { moduleId: "news", provider: createNewsDiagnosticsProvider(harness.newsRepository) }
      ],
      runInContext: (work, context) =>
        harness.appContext.withDataContext(
          { actorUserId: context.actorUserId, requestId: context.requestId },
          work
        ),
      isInstanceAdmin: async () => false,
      assertDiagnosticsSafe: () => undefined
    });
    harness.configureChatTools(harness.appBoss);
    await harness.appContext.withDataContext(
      { actorUserId: ids.userA, requestId: "diagnostics-initial-request" },
      (db) => harness.newsRepository.bumpRefreshRequest(db)
    );
    await enqueueNewsRefresh(harness.appBoss, ids.userA);
    await registerNewsJobWorkers(harness.workerBoss, harness.workerContext, {
      fetchWithOptions: async () => ({ ok: false, reason: "network" }),
      fetch: async (url) => ({
        ok: true as const,
        status: 200,
        finalUrl: url,
        contentType: "application/rss+xml",
        body: feedForRefresh(url),
        truncated: false
      }),
      search: { search: async () => ({ results: [] }) },
      ai: {
        fingerprint: async () => "test",
        generateJson: async () => ({ ok: false as const, error: "provider_error" as const })
      },
      logger: { info: () => undefined }
    });
    await harness.waitForRefreshSuccess("diagnostics-initial-wait");

    const { gateway, emitted, mint } = harness.makeGateway({ diagnostics, boss: harness.appBoss });
    const token = mint(ids.userA, "diagnostics-refresh");
    const first = await gateway.callTool(token, "settings.platformDiagnostics", {
      module: "news",
      include: ["modules", "runtime", "errors", "actions"]
    });
    expect(first).toMatchObject({ ok: true });
    const firstPayload = parseToolText(first) as {
      modules: Array<{ status: string; facts?: Record<string, unknown> }>;
      errors: readonly Record<string, unknown>[];
      actions: readonly Record<string, unknown>[];
      redactions: string[];
    };
    expect(firstPayload.modules[0]).toMatchObject({ status: "ok" });
    expect(firstPayload.modules[0]?.facts).toMatchObject({
      lastSuccessAt: expect.any(String),
      itemCount: expect.any(Number)
    });
    const firstSuccessAt = firstPayload.modules[0]?.facts?.lastSuccessAt;
    expect(firstSuccessAt).toEqual(expect.any(String));
    expect(firstPayload.redactions).toContain("runtime");
    expect(JSON.stringify(firstPayload)).not.toMatch(
      /Refresh test item|opaque-test-fingerprint|secret|provider body/i
    );

    const otherToken = mint(ids.userB, "diagnostics-foreign-owner");
    const other = await gateway.callTool(otherToken, "settings.platformDiagnostics", {
      module: "news",
      include: ["modules", "errors", "actions"]
    });
    expect(other).toMatchObject({ ok: true });
    const otherPayload = parseToolText(other) as {
      modules: Array<{ status: string; facts?: Record<string, unknown> }>;
      errors: readonly Record<string, unknown>[];
      actions: readonly Record<string, unknown>[];
    };
    expect(otherPayload.modules[0]).toMatchObject({ status: "unknown" });
    expect(otherPayload.modules[0]?.facts).toMatchObject({
      lastAttemptAt: null,
      lastSuccessAt: null,
      itemCount: 0
    });
    expect(otherPayload.errors).toEqual([]);
    expect(otherPayload.actions).toEqual([]);
    expect(JSON.stringify(otherPayload)).not.toContain(firstSuccessAt as string);

    const pending = gateway.callTool(token, "news.refreshNews", {});
    const request = await harness.waitForActionRequest(emitted, 0);
    expect(request.toolName).toBe("news.refreshNews");
    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    const refreshResult = await pending;
    expect(refreshResult).toMatchObject({ ok: true });
    const refreshPayload = parseToolText(refreshResult);
    expect(refreshPayload).toMatchObject({
      status: expect.stringMatching(/^(accepted|queued)$/),
      asynchronous: true
    });
    expect(JSON.stringify(refreshPayload)).not.toMatch(/complete/i);

    await harness.waitForRefreshSuccess("diagnostics-refresh-wait");

    const second = await gateway.callTool(token, "settings.platformDiagnostics", {
      module: "news",
      include: ["modules"]
    });
    const secondPayload = parseToolText(second) as {
      modules: Array<{ status: string; facts?: Record<string, unknown> }>;
    };
    expect(secondPayload.modules[0]).toMatchObject({ status: "ok" });
    expect(secondPayload.modules[0]?.facts).toMatchObject({
      lastSuccessAt: expect.any(String),
      itemCount: expect.any(Number)
    });
    expect(secondPayload.modules[0]?.facts?.lastSuccessAt).not.toBe(firstSuccessAt);

    const otherAfterRefresh = await gateway.callTool(otherToken, "settings.platformDiagnostics", {
      module: "news",
      include: ["modules", "errors", "actions"]
    });
    const otherAfterRefreshPayload = parseToolText(otherAfterRefresh) as {
      errors: readonly Record<string, unknown>[];
      actions: readonly Record<string, unknown>[];
    };
    expect(otherAfterRefreshPayload.errors).toEqual([]);
    expect(otherAfterRefreshPayload.actions).toEqual([]);
    expect(await harness.listActorAudits(ids.userB)).toEqual([]);
  }, 60_000);

  it("carries a real assistant conversation through chat, MCP, confirmation, and the worker", async () => {
    // #2159: this fake engine drives tool calls directly over MCP but never runs a real
    // tools/list round trip, so the server's readiness wait (SessionTokenRegistry's
    // waitForToolsListObserved) would otherwise time out on every session launch below. Stub
    // it to resolve ready immediately — this test isn't exercising readiness.
    const toolsListReadySpy = vi
      .spyOn(SessionTokenRegistry.prototype, "waitForToolsListObserved")
      .mockResolvedValue(true);

    // #2164 r21: this fake engine reports its tool calls as news.refreshNews and
    // settings.platformDiagnostics, neither of which is mcp__-namespaced, so the per-turn gate
    // (SessionTokenRegistry.getToolsListObservationCount, compared against a per-turn baseline in
    // ChatSessionManager.waitForNewToolsListObservation) would otherwise time out waiting for an
    // observation that never comes. Stub it to a strictly increasing count so every baseline
    // capture is immediately exceeded on the next read — readiness isn't under test here.
    let toolsListObservationCounter = 0;
    const toolsListObservationCountSpy = vi
      .spyOn(SessionTokenRegistry.prototype, "getToolsListObservationCount")
      .mockImplementation(() => ++toolsListObservationCounter);
    harness.configureChatTools(harness.appBoss);
    await harness.appContext.withDataContext(
      { actorUserId: ids.userA, requestId: "diagnostics-chat-policy" },
      (db) =>
        new AiRepository().setActionPolicy(db, "news", "news_personalization", "ask_each_time")
    );
    const initialRequestId = "diagnostics-chat-initial-request";
    await harness.appContext.withDataContext(
      { actorUserId: ids.userA, requestId: initialRequestId },
      (db) => harness.newsRepository.bumpRefreshRequest(db)
    );
    await enqueueNewsRefresh(harness.appBoss, ids.userA);
    await harness.waitForRefreshSuccess("diagnostics-chat-initial-wait");

    const serverRef: { current?: ReturnType<typeof createApiServer> } = {};
    const engineFactory: ChatEngineFactory = (provider) =>
      new DeterministicDiagnosticsEngine(provider, async (token, request) => {
        const server = serverRef.current;
        if (!server) throw new Error("chat test server is not ready");
        const response = await server.inject({
          method: "POST",
          url: "/api/mcp",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: request
          }
        });
        return response.json<McpResponse>();
      });
    const server = createApiServer({
      appDb: harness.appDb,
      workerDb: harness.workerDb,
      boss: harness.appBoss,
      logger: false,
      chatEngineFactory: engineFactory,
      apiServerConfig: {
        host: "127.0.0.1",
        port: 0,
        mcpServerUrl: "http://test.invalid/api/mcp",
        externalModulesDir: "/tmp"
      }
    });
    serverRef.current = server;
    await server.ready();

    try {
      const provider = await server.inject({
        method: "POST",
        url: "/api/ai/providers",
        headers: { authorization: `Bearer ${ids.sessionAdmin}` },
        payload: {
          providerKind: "anthropic",
          displayName: "Diagnostics test provider",
          authMethod: "cli"
        }
      });
      expect(provider.statusCode).toBe(201);
      const providerId = provider.json<{ provider: { id: string } }>().provider.id;
      const model = await server.inject({
        method: "POST",
        url: "/api/ai/models",
        headers: { authorization: `Bearer ${ids.sessionAdmin}` },
        payload: {
          providerConfigId: providerId,
          providerModelId: "diagnostics-test-model",
          displayName: "Diagnostics test model",
          capabilities: ["chat"]
        }
      });
      expect(model.statusCode).toBe(201);

      const first = await server.inject({
        method: "POST",
        url: "/api/chat/turn",
        headers: { authorization: `Bearer ${ids.sessionA}` },
        payload: { text: "UAT-2032-diagnose: is my news fresh?" }
      });
      expect(first.statusCode).toBe(200);
      const firstReply = first.json<{ reply: string }>().reply;
      expect(firstReply).toMatch(/last success .*latest attempt .*items/i);
      expect(firstReply).not.toMatch(/Refresh test item|opaque-test-fingerprint|secret/i);

      const before = await harness.appContext.withDataContext(
        { actorUserId: ids.userA, requestId: "diagnostics-chat-before" },
        (db) => harness.newsRepository.readRefreshState(db)
      );
      const refresh = server.inject({
        method: "POST",
        url: "/api/chat/turn",
        headers: { authorization: `Bearer ${ids.sessionA}` },
        payload: { text: "UAT-2032-refresh: refresh my news" }
      });
      const actionId = await harness.waitForPendingAction(ids.userA, "news.refreshNews");
      const pendingState = await harness.appContext.withDataContext(
        { actorUserId: ids.userA, requestId: "diagnostics-chat-pending" },
        (db) => harness.newsRepository.readRefreshState(db)
      );
      expect(pendingState.lastRequestedAt).toEqual(before.lastRequestedAt);
      const resolution = await server.inject({
        method: "POST",
        url: `/api/chat/action-requests/${actionId}/resolve`,
        headers: { authorization: `Bearer ${ids.sessionA}` },
        payload: { status: "confirmed" }
      });
      expect(resolution.statusCode).toBe(204);
      const refreshResponse = await refresh;
      expect(refreshResponse.statusCode).toBe(200);
      expect(refreshResponse.json<{ reply: string }>().reply).toMatch(/accepted and queued/i);
      expect(refreshResponse.json<{ reply: string }>().reply).not.toMatch(/complete/i);

      await harness.waitForRefreshSuccess("diagnostics-chat-refresh-wait");
      const recheck = await server.inject({
        method: "POST",
        url: "/api/chat/turn",
        headers: { authorization: `Bearer ${ids.sessionA}` },
        payload: { text: "UAT-2032-recheck: is my news current now?" }
      });
      expect(recheck.statusCode).toBe(200);
      expect(recheck.json<{ reply: string }>().reply).toMatch(
        /last success .*latest attempt .*items/i
      );

      const other = await server.inject({
        method: "POST",
        url: "/api/chat/turn",
        headers: { authorization: `Bearer ${ids.sessionB}` },
        payload: { text: "UAT-2032-diagnose: is my news fresh?" }
      });
      expect(other.statusCode).toBe(200);
      expect(other.json<{ reply: string }>().reply).toMatch(/null.*null.*0 items/i);
      expect(await harness.listActorAudits(ids.userB)).toEqual([]);
    } finally {
      await server.close();
      toolsListReadySpy.mockRestore();
      toolsListObservationCountSpy.mockRestore();
    }
    harness.configureChatTools(null);
  }, 60_000);

  it("confirmSource is confirm-gated: nothing executes until the owner confirms, then row + audit", async () => {
    const { gateway, emitted, mint } = harness.makeGateway();
    const token = mint(ids.userA, "news-chat-confirm");
    const preview = await harness.previewExampleFeed(gateway, token);
    const candidate = preview.candidates[0]!;
    const before = await harness.sourceRowCount();

    const pending = gateway.callTool(token, "news.confirmSource", {
      confirmationId: preview.confirmationId,
      candidateId: candidate.candidateId,
      label: candidate.label,
      domain: candidate.domain
    });
    const request = await harness.waitForActionRequest(emitted, 0);

    // Blocking confirmation: no source row while the action sits pending.
    expect(await harness.sourceRowCount()).toBe(before);

    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    const result = await pending;
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain("fingerprint");

    expect(await harness.sourceRowCount()).toBe(before + 1);
    const row = await harness.bootstrap.query(
      `SELECT owner_user_id, canonical_domain FROM app.news_custom_sources ORDER BY created_at DESC LIMIT 1`
    );
    expect(row.rows[0]).toMatchObject({
      owner_user_id: ids.userA,
      canonical_domain: "example.com"
    });

    expect(
      await harness.waitForAudit({ toolName: "news.confirmSource", outcome: "success" })
    ).toMatchObject({
      owner_user_id: ids.userA,
      approval_mode: "confirmed",
      outcome: "success",
      tool_name: "news.confirmSource"
    });
  }, 30_000);

  it("confirmSource with a tampered domain fails closed: sanitized error, no row", async () => {
    const { gateway, emitted, mint } = harness.makeGateway();
    const token = mint(ids.userA, "news-chat-tamper");
    const preview = await harness.previewExampleFeed(gateway, token);
    const candidate = preview.candidates[0]!;
    const before = await harness.sourceRowCount();

    // Resubmitted display fields must match the STORED candidate — a mismatch is
    // a security violation (LLM/client tried to swap the write target).
    const pending = gateway.callTool(token, "news.confirmSource", {
      confirmationId: preview.confirmationId,
      candidateId: candidate.candidateId,
      label: candidate.label,
      domain: "evil.example.net"
    });
    const request = await harness.waitForActionRequest(emitted, 0);
    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    const result = await pending;

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("Tool news.confirmSource failed");
    expect(await harness.sourceRowCount()).toBe(before);
    expect(
      await harness.waitForAudit({ toolName: "news.confirmSource", outcome: "failed" })
    ).toMatchObject({
      owner_user_id: ids.userA,
      approval_mode: "confirmed",
      outcome: "failed"
    });
  }, 30_000);

  it("rejects a cross-owner confirmationId replay as expired without writing", async () => {
    const { gateway, emitted, mint } = harness.makeGateway();
    const tokenA = mint(ids.userA, "news-chat-owner-a");
    const tokenB = mint(ids.userB, "news-chat-owner-b");
    const preview = await harness.previewExampleFeed(gateway, tokenA);
    const candidate = preview.candidates[0]!;
    const before = await harness.sourceRowCount();

    const pending = gateway.callTool(tokenB, "news.confirmSource", {
      confirmationId: preview.confirmationId,
      candidateId: candidate.candidateId,
      label: candidate.label,
      domain: candidate.domain
    });
    const request = await harness.waitForActionRequest(emitted, 0);
    await gateway.resolveActionRequest(ids.userB, request.actionRequestId, "confirmed");
    const result = await pending;

    // Benign failure: owner-checked preview store yields nothing for B, the
    // tool reports "expired" as data (no throw), and nothing was written.
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain("expired");
    expect(await harness.sourceRowCount()).toBe(before);
  }, 30_000);

  it("refreshNews is confirmed, audited, and honest about asynchronous work", async () => {
    const { gateway, emitted, mint } = harness.makeGateway();
    const token = mint(ids.userA, "news-chat-refresh");
    const pending = gateway.callTool(token, "news.refreshNews", {});
    const request = await harness.waitForActionRequest(emitted, 0);

    expect(request.toolName).toBe("news.refreshNews");
    expect(request.summary).toBe("Refresh news");
    const before = await harness.bootstrap.query(
      `SELECT last_requested_at FROM app.news_refresh_state WHERE owner_user_id = $1`,
      [ids.userA]
    );
    expect(before.rowCount).toBeLessThanOrEqual(1);
    const beforeRequestedAt = before.rows[0]?.last_requested_at ?? null;
    const whilePending = await harness.bootstrap.query(
      `SELECT last_requested_at FROM app.news_refresh_state WHERE owner_user_id = $1`,
      [ids.userA]
    );
    expect(whilePending.rows[0]?.last_requested_at?.getTime?.() ?? null).toBe(
      beforeRequestedAt?.getTime?.() ?? null
    );

    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    const result = await pending;
    expect(result).toMatchObject({ ok: true });
    const payload = parseToolText(result);
    expect(payload).toMatchObject({ status: "accepted", asynchronous: true });
    expect(JSON.stringify(result)).not.toMatch(/completed|complete/i);
    expect(
      await harness.waitForAudit({ toolName: "news.refreshNews", outcome: "success" })
    ).toMatchObject({
      owner_user_id: ids.userA,
      approval_mode: "confirmed"
    });
  }, 30_000);
});
