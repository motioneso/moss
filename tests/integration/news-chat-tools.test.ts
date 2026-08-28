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
// Task 8 (#975) extends the same harness with the four remaining write tools
// (removeSource/addTopic/removeTopic/addExclusion) in a nested describe below.
//
// Harness skeleton: tests/integration/js08-decide-confirm-audit.test.ts.
// Discovery/availability stubs: tests/integration/news-personalization-routes.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  createPlatformDiagnosticsService,
  type GatewaySessionRecord,
  type PlatformDiagnosticsService
} from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import {
  createNewsDiagnosticsProvider,
  enqueueNewsRefresh,
  registerNewsJobWorkers
} from "@moss/news";
import { settingsModuleManifest } from "@moss/settings";
import type { ChatEngineFactory } from "@moss/module-registry";
import type {
  CliChatEngine,
  EngineLaunchOpts,
  TranscriptRecord
} from "../../packages/chat/src/live/types.js";

import { configureNewsChatTools } from "../../packages/news/src/chat-tools.js";
import { createPreviewStore } from "../../packages/news/src/discovery/preview-store.js";
import { newsModuleManifest } from "../../packages/news/src/manifest.js";
import {
  NEWS_MAX_CUSTOM_TOPICS,
  NewsPersonalizationRepository
} from "../../packages/news/src/personalization-repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

type McpResponse = {
  readonly result?: {
    readonly content?: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  };
};

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
        { kind: "reply", text: "Refresh accepted and queued; it has not completed." }
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

const feed = `<?xml version="1.0"?><rss><channel><title>Example News</title><item><title>Verified publisher headline</title><link>https://example.com/story</link><pubDate>Fri, 11 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

function feedForRefresh(url: string): string {
  const host = new URL(url).hostname;
  const publisher = host.includes("bbci")
    ? "www.bbc.com"
    : host.includes("guardian")
      ? "www.theguardian.com"
      : "www.npr.org";
  return `<?xml version="1.0"?><rss><channel><item><title>Refresh test item from ${publisher}</title><link>https://${publisher}/story</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
}

/**
 * Gateway output is always `{ text }` (renderAndCap). For `externalContent`
 * tools the rendered JSON additionally sits HTML-escaped inside a
 * `<tool_result source="…">` trust envelope — strip + unescape + parse to get
 * the structured payload back for follow-up calls.
 */
function parseToolText(result: unknown): Record<string, unknown> {
  const text = (result as { data?: { text?: string } }).data?.text;
  if (typeof text !== "string")
    throw new Error(`tool result has no text: ${JSON.stringify(result)}`);
  const inner = text
    .replace(/^<tool_result[^>]*>\n/, "")
    .replace(/\n<\/tool_result>$/, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return JSON.parse(inner) as Record<string, unknown>;
}

type PreviewPayload = {
  confirmationId: string;
  candidates: Array<{ candidateId: string; label: string; domain: string }>;
};

describe("news chat tools — previewSource/confirmSource via assistant gateway (#975)", () => {
  let bootstrap: pg.Client;
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let appContext: DataContextRunner;
  let workerContext: DataContextRunner;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  const newsRepository = new NewsPersonalizationRepository();

  function configureChatTools(boss: PgBoss | null): void {
    // Same deferred-deps seam routes.ts uses at composition time: one shared
    // preview store, stubbed discovery/availability, and an optional real queue.
    configureNewsChatTools({
      previews: createPreviewStore(),
      discovery: {
        fetch: async (url: string) => ({
          ok: true as const,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: feed,
          truncated: false
        }),
        search: { search: async () => ({ results: [] }) },
        ai: {
          fingerprint: async () => "opaque-test-fingerprint",
          generateJson: async (_db: unknown, input: { prompt: string }) => ({
            ok: true as const,
            object: input.prompt.includes("news TOPIC")
              ? { allowed: true, category: "news_topic" }
              : { allowed: true, category: "news_publisher" }
          })
        }
      },
      availability: {
        hasJsonModel: async () => true,
        hasWebSearch: async () => true
      },
      boss,
      repository: newsRepository,
      credentials: { readStatuses: async () => [] }
    });
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    appContext = new DataContextRunner(appDb);
    workerContext = new DataContextRunner(workerDb);
    appBoss = createPgBossClient(connectionStrings.app);
    workerBoss = createPgBossClient(connectionStrings.worker);
    await Promise.all([appBoss.start(), workerBoss.start()]);
    configureChatTools(null);
  }, 60_000);

  afterAll(async () =>
    Promise.allSettled([
      bootstrap?.end(),
      appDb?.destroy(),
      workerDb?.destroy(),
      appBoss?.stop({ graceful: false }),
      workerBoss?.stop({ graceful: false })
    ])
  );

  function makeGateway(options: { diagnostics?: PlatformDiagnosticsService } = {}) {
    const tokens = new SessionTokenRegistry();
    const emitted: GatewaySessionRecord[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [
        newsModuleManifest,
        ...(options.diagnostics ? [settingsModuleManifest] : [])
      ],
      repository: new AiRepository(),
      runner: new DataContextRunner(appDb),
      tokens,
      confirmations: new ConfirmationRegistry(),
      notifier: { emit: (_session, record) => emitted.push(record) },
      confirmTimeoutMs: 5_000,
      readToolServices: options.diagnostics
        ? { platformDiagnostics: options.diagnostics }
        : undefined,
      toolServices: { writeOnly: { secret: "never passed to read tools" } }
    });
    const mint = (actorUserId: string, chatSessionId: string) =>
      tokens.mint({ actorUserId, chatSessionId, allowedToolNames: null });
    return { gateway, emitted, mint };
  }

  async function previewExampleFeed(
    gateway: AssistantToolGateway,
    token: string
  ): Promise<PreviewPayload> {
    const result = await gateway.callTool(token, "news.previewSource", {
      source: "https://example.com/feed.xml"
    });
    expect(result).toMatchObject({ ok: true });
    const payload = parseToolText(result) as unknown as PreviewPayload;
    expect(typeof payload.confirmationId).toBe("string");
    expect(payload.candidates.length).toBeGreaterThan(0);
    return payload;
  }

  async function waitForActionRequest(
    emitted: GatewaySessionRecord[],
    from: number
  ): Promise<Extract<GatewaySessionRecord, { kind: "action_request" }>> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const record = emitted
        .slice(from)
        .find((entry): entry is Extract<GatewaySessionRecord, { kind: "action_request" }> => {
          return entry.kind === "action_request";
        });
      if (record) return record;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("action request never emitted");
  }

  async function sourceRowCount(): Promise<number> {
    const rows = await bootstrap.query(`SELECT count(*)::int AS n FROM app.news_custom_sources`);
    return rows.rows[0].n as number;
  }

  async function waitForAudit(where: {
    toolName: string;
    outcome: string;
    ownerUserId?: string;
  }): Promise<Record<string, unknown>> {
    // Audit writes are fire-and-forget — poll for the row. The optional owner
    // filter disambiguates when two actors exercised the same tool in one test.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const audit = await bootstrap.query(
        `SELECT owner_user_id, approval_mode, outcome, tool_name
         FROM app.moss_action_audit_log
         WHERE tool_name = $1 AND outcome = $2
           AND ($3::uuid IS NULL OR owner_user_id = $3::uuid)`,
        [where.toolName, where.outcome, where.ownerUserId ?? null]
      );
      if (audit.rowCount) return audit.rows[0] as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`audit row not written for ${where.toolName}/${where.outcome}`);
  }

  async function waitForRefreshSuccess(requestId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await appContext.withDataContext({ actorUserId: ids.userA, requestId }, (db) =>
        newsRepository.readRefreshState(db)
      );
      if (state.state === "idle" && state.lastSuccessAt) return;
      if (attempt === 99) throw new Error("news refresh worker did not complete successfully");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function waitForPendingAction(ownerUserId: string, toolName: string): Promise<string> {
    const repository = new AiRepository();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const actions = await appContext.withDataContext(
        { actorUserId: ownerUserId, requestId: `wait-pending-${attempt}` },
        (db) => repository.listAssistantActions(db)
      );
      const action = actions.find(
        (entry) => entry.status === "pending" && entry.tool_name === toolName
      );
      if (action) return action.id;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no pending action request appeared for ${toolName}`);
  }

  async function listActorAudits(ownerUserId: string): Promise<readonly unknown[]> {
    return appContext.withDataContext(
      { actorUserId: ownerUserId, requestId: `list-audits-${ownerUserId}` },
      (db) => new AiRepository().listActionAuditLog(db, { since: new Date(0), limit: 100 })
    );
  }

  it("previewSource runs unconfirmed (read risk) and returns verified candidates", async () => {
    const { gateway, emitted, mint } = makeGateway();
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
        { moduleId: "news", provider: createNewsDiagnosticsProvider(newsRepository) }
      ],
      runInContext: (work, context) =>
        appContext.withDataContext(
          { actorUserId: context.actorUserId, requestId: context.requestId },
          work
        ),
      isInstanceAdmin: async () => false,
      assertDiagnosticsSafe: () => undefined
    });
    configureChatTools(appBoss);
    await appContext.withDataContext(
      { actorUserId: ids.userA, requestId: "diagnostics-initial-request" },
      (db) => newsRepository.bumpRefreshRequest(db)
    );
    await enqueueNewsRefresh(appBoss, ids.userA);
    await registerNewsJobWorkers(workerBoss, workerContext, {
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
    await waitForRefreshSuccess("diagnostics-initial-wait");

    const { gateway, emitted, mint } = makeGateway({ diagnostics });
    const token = mint(ids.userA, "diagnostics-refresh");
    const first = await gateway.callTool(token, "settings.platformDiagnostics", {
      module: "news",
      include: ["modules", "runtime"]
    });
    expect(first).toMatchObject({ ok: true });
    const firstPayload = parseToolText(first) as {
      modules: Array<{ status: string; facts?: Record<string, unknown> }>;
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

    const otherToken = mint(ids.userB, "diagnostics-foreign-owner");
    const other = await gateway.callTool(otherToken, "settings.platformDiagnostics", {
      module: "news",
      include: ["modules"]
    });
    expect(other).toMatchObject({ ok: true });
    const otherPayload = parseToolText(other) as {
      modules: Array<{ status: string; facts?: Record<string, unknown> }>;
    };
    expect(otherPayload.modules[0]).toMatchObject({ status: "unknown" });
    expect(otherPayload.modules[0]?.facts).toMatchObject({
      lastAttemptAt: null,
      lastSuccessAt: null,
      itemCount: 0
    });
    expect(JSON.stringify(otherPayload)).not.toContain(firstSuccessAt as string);

    const pending = gateway.callTool(token, "news.refreshNews", {});
    const request = await waitForActionRequest(emitted, 0);
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

    await waitForRefreshSuccess("diagnostics-refresh-wait");

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

    expect(await listActorAudits(ids.userB)).toEqual([]);
  }, 60_000);

  it("carries a real assistant conversation through chat, MCP, confirmation, and the worker", async () => {
    configureChatTools(appBoss);
    const initialRequestId = "diagnostics-chat-initial-request";
    await appContext.withDataContext(
      { actorUserId: ids.userA, requestId: initialRequestId },
      (db) => newsRepository.bumpRefreshRequest(db)
    );
    await enqueueNewsRefresh(appBoss, ids.userA);
    await waitForRefreshSuccess("diagnostics-chat-initial-wait");

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
      appDb,
      workerDb,
      boss: appBoss,
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

      const before = await appContext.withDataContext(
        { actorUserId: ids.userA, requestId: "diagnostics-chat-before" },
        (db) => newsRepository.readRefreshState(db)
      );
      const refresh = server.inject({
        method: "POST",
        url: "/api/chat/turn",
        headers: { authorization: `Bearer ${ids.sessionA}` },
        payload: { text: "UAT-2032-refresh: refresh my news" }
      });
      const actionId = await waitForPendingAction(ids.userA, "news.refreshNews");
      const pendingState = await appContext.withDataContext(
        { actorUserId: ids.userA, requestId: "diagnostics-chat-pending" },
        (db) => newsRepository.readRefreshState(db)
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

      await waitForRefreshSuccess("diagnostics-chat-refresh-wait");
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
      expect(await listActorAudits(ids.userB)).toEqual([]);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("confirmSource is confirm-gated: nothing executes until the owner confirms, then row + audit", async () => {
    const { gateway, emitted, mint } = makeGateway();
    const token = mint(ids.userA, "news-chat-confirm");
    const preview = await previewExampleFeed(gateway, token);
    const candidate = preview.candidates[0]!;
    const before = await sourceRowCount();

    const pending = gateway.callTool(token, "news.confirmSource", {
      confirmationId: preview.confirmationId,
      candidateId: candidate.candidateId,
      label: candidate.label,
      domain: candidate.domain
    });
    const request = await waitForActionRequest(emitted, 0);

    // Blocking confirmation: no source row while the action sits pending.
    expect(await sourceRowCount()).toBe(before);

    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    const result = await pending;
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain("fingerprint");

    expect(await sourceRowCount()).toBe(before + 1);
    const row = await bootstrap.query(
      `SELECT owner_user_id, canonical_domain FROM app.news_custom_sources ORDER BY created_at DESC LIMIT 1`
    );
    expect(row.rows[0]).toMatchObject({
      owner_user_id: ids.userA,
      canonical_domain: "example.com"
    });

    expect(
      await waitForAudit({ toolName: "news.confirmSource", outcome: "success" })
    ).toMatchObject({
      owner_user_id: ids.userA,
      approval_mode: "confirmed",
      outcome: "success",
      tool_name: "news.confirmSource"
    });
  }, 30_000);

  it("confirmSource with a tampered domain fails closed: sanitized error, no row", async () => {
    const { gateway, emitted, mint } = makeGateway();
    const token = mint(ids.userA, "news-chat-tamper");
    const preview = await previewExampleFeed(gateway, token);
    const candidate = preview.candidates[0]!;
    const before = await sourceRowCount();

    // Resubmitted display fields must match the STORED candidate — a mismatch is
    // a security violation (LLM/client tried to swap the write target).
    const pending = gateway.callTool(token, "news.confirmSource", {
      confirmationId: preview.confirmationId,
      candidateId: candidate.candidateId,
      label: candidate.label,
      domain: "evil.example.net"
    });
    const request = await waitForActionRequest(emitted, 0);
    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    const result = await pending;

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("Tool news.confirmSource failed");
    expect(await sourceRowCount()).toBe(before);
    expect(await waitForAudit({ toolName: "news.confirmSource", outcome: "failed" })).toMatchObject(
      {
        owner_user_id: ids.userA,
        approval_mode: "confirmed",
        outcome: "failed"
      }
    );
  }, 30_000);

  it("rejects a cross-owner confirmationId replay as expired without writing", async () => {
    const { gateway, emitted, mint } = makeGateway();
    const tokenA = mint(ids.userA, "news-chat-owner-a");
    const tokenB = mint(ids.userB, "news-chat-owner-b");
    const preview = await previewExampleFeed(gateway, tokenA);
    const candidate = preview.candidates[0]!;
    const before = await sourceRowCount();

    const pending = gateway.callTool(tokenB, "news.confirmSource", {
      confirmationId: preview.confirmationId,
      candidateId: candidate.candidateId,
      label: candidate.label,
      domain: candidate.domain
    });
    const request = await waitForActionRequest(emitted, 0);
    await gateway.resolveActionRequest(ids.userB, request.actionRequestId, "confirmed");
    const result = await pending;

    // Benign failure: owner-checked preview store yields nothing for B, the
    // tool reports "expired" as data (no throw), and nothing was written.
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain("expired");
    expect(await sourceRowCount()).toBe(before);
  }, 30_000);

  it("refreshNews is confirmed, audited, and honest about asynchronous work", async () => {
    const { gateway, emitted, mint } = makeGateway();
    const token = mint(ids.userA, "news-chat-refresh");
    const pending = gateway.callTool(token, "news.refreshNews", {});
    const request = await waitForActionRequest(emitted, 0);

    expect(request.toolName).toBe("news.refreshNews");
    expect(request.summary).toBe("Refresh news");
    const before = await bootstrap.query(
      `SELECT last_requested_at FROM app.news_refresh_state WHERE owner_user_id = $1`,
      [ids.userA]
    );
    expect(before.rowCount).toBeLessThanOrEqual(1);
    const beforeRequestedAt = before.rows[0]?.last_requested_at ?? null;
    const whilePending = await bootstrap.query(
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
    expect(await waitForAudit({ toolName: "news.refreshNews", outcome: "success" })).toMatchObject({
      owner_user_id: ids.userA,
      approval_mode: "confirmed"
    });
  }, 30_000);

  // #975 Task 8 — the four remaining write tools. All confirm-gated by default (write
  // risk, news_personalization family defaults to ask_each_time), all mirroring their
  // REST route's write path exactly.
  describe("topic/exclusion/removal write tools (#975 Task 8)", () => {
    const repository = new NewsPersonalizationRepository();

    async function topicRowCount(ownerUserId: string): Promise<number> {
      const rows = await bootstrap.query(
        `SELECT count(*)::int AS n FROM app.news_custom_topics WHERE owner_user_id = $1`,
        [ownerUserId]
      );
      return rows.rows[0].n as number;
    }

    async function exclusionRows(ownerUserId: string): Promise<Array<{ domain: string }>> {
      const rows = await bootstrap.query(
        `SELECT canonical_domain AS domain FROM app.news_source_exclusions WHERE owner_user_id = $1`,
        [ownerUserId]
      );
      return rows.rows as Array<{ domain: string }>;
    }

    async function ownerSourceRows(ownerUserId: string): Promise<Array<{ id: string }>> {
      const rows = await bootstrap.query(
        `SELECT id FROM app.news_custom_sources WHERE owner_user_id = $1`,
        [ownerUserId]
      );
      return rows.rows as Array<{ id: string }>;
    }

    it("addTopic is confirm-gated: no row while pending, then row + confirmed audit", async () => {
      const { gateway, emitted, mint } = makeGateway();
      const token = mint(ids.userA, "news-chat-add-topic");
      const before = await topicRowCount(ids.userA);

      const pending = gateway.callTool(token, "news.addTopic", {
        label: "Local climate policy",
        guidance: "prefer municipal coverage"
      });
      const request = await waitForActionRequest(emitted, 0);
      expect(request.toolName).toBe("news.addTopic");
      // Confirmation card text comes from tool INPUT only (execute hasn't run).
      expect(request.summary).toContain("Local climate policy");
      expect(await topicRowCount(ids.userA)).toBe(before);

      await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
      const result = await pending;
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain("fingerprint");
      const payload = parseToolText(result);
      expect(payload.error).toBeUndefined();
      expect(payload.topic).toMatchObject({ label: "Local climate policy" });

      expect(await topicRowCount(ids.userA)).toBe(before + 1);
      expect(await waitForAudit({ toolName: "news.addTopic", outcome: "success" })).toMatchObject({
        owner_user_id: ids.userA,
        approval_mode: "confirmed"
      });

      // Regression: `guidance` was dropped from the tool schema, but the gateway validator does
      // not strip undeclared keys (input-validation.ts), so the input above still carried
      // guidance: "prefer municipal coverage" as if the model had emitted it anyway. Assert the
      // execute fn — not the schema — is what refuses it: the persisted row must be null.
      const rows = await bootstrap.query(
        `SELECT guidance FROM app.news_custom_topics WHERE owner_user_id = $1 AND label = $2`,
        [ids.userA, "Local climate policy"]
      );
      expect(rows.rows[0].guidance).toBeNull();
    }, 30_000);

    it("addTopic at the per-user cap returns a friendly error and writes nothing", async () => {
      const runner = new DataContextRunner(appDb);
      await runner.withDataContext(
        { actorUserId: ids.userB, requestId: "seed-topic-limit" },
        async (db) => {
          const existing = await topicRowCount(ids.userB);
          for (let i = existing; i < NEWS_MAX_CUSTOM_TOPICS; i += 1) {
            await repository.createCustomTopic(db, {
              label: `Seeded topic ${i}`,
              guidance: null,
              validationFingerprint: "opaque-test-fingerprint"
            });
          }
        }
      );

      const { gateway, emitted, mint } = makeGateway();
      const token = mint(ids.userB, "news-chat-topic-limit");
      const pending = gateway.callTool(token, "news.addTopic", { label: "One too many" });
      const request = await waitForActionRequest(emitted, 0);
      await gateway.resolveActionRequest(ids.userB, request.actionRequestId, "confirmed");
      const result = await pending;

      // Benign failure: friendly data error, not a sanitized tool failure.
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).toMatch(/limit|at most/i);
      expect(JSON.stringify(result)).not.toContain("Tool news.addTopic failed");
      expect(await topicRowCount(ids.userB)).toBe(NEWS_MAX_CUSTOM_TOPICS);
    }, 30_000);

    it("removeTopic is confirm-gated and deletes the topic only after confirm", async () => {
      const runner = new DataContextRunner(appDb);
      const seeded = await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "seed-remove-topic" },
        (db) =>
          repository.createCustomTopic(db, {
            label: "Doomed topic",
            guidance: null,
            validationFingerprint: "opaque-test-fingerprint"
          })
      );
      const before = await topicRowCount(ids.userA);

      const { gateway, emitted, mint } = makeGateway();
      const token = mint(ids.userA, "news-chat-remove-topic");
      const pending = gateway.callTool(token, "news.removeTopic", { topicId: seeded.id });
      const request = await waitForActionRequest(emitted, 0);
      expect(await topicRowCount(ids.userA)).toBe(before);

      await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
      const result = await pending;
      expect(result).toMatchObject({ ok: true });
      expect(parseToolText(result)).toMatchObject({ removed: true });
      expect(await topicRowCount(ids.userA)).toBe(before - 1);
      expect(
        await waitForAudit({ toolName: "news.removeTopic", outcome: "success" })
      ).toMatchObject({ owner_user_id: ids.userA, approval_mode: "confirmed" });
    }, 30_000);

    it("addExclusion is confirm-gated and stores the normalized domain", async () => {
      const { gateway, emitted, mint } = makeGateway();
      const token = mint(ids.userA, "news-chat-add-exclusion");

      // Mixed-case input proves the tool routes through normalizePublisherDomain.
      const pending = gateway.callTool(token, "news.addExclusion", {
        domain: "Blocked.Example.Com"
      });
      const request = await waitForActionRequest(emitted, 0);
      expect(await exclusionRows(ids.userA)).toHaveLength(0);

      await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
      const result = await pending;
      expect(result).toMatchObject({ ok: true });
      expect(parseToolText(result)).toMatchObject({
        exclusion: { domain: "blocked.example.com" }
      });
      expect(await exclusionRows(ids.userA)).toEqual([{ domain: "blocked.example.com" }]);
      expect(
        await waitForAudit({ toolName: "news.addExclusion", outcome: "success" })
      ).toMatchObject({ owner_user_id: ids.userA, approval_mode: "confirmed" });
    }, 30_000);

    it("removeSource treats a cross-owner id as not-found and removes own sources after confirm", async () => {
      // B follows example.com through the existing chat preview/confirm flow.
      const { gateway, emitted, mint } = makeGateway();
      const tokenB = mint(ids.userB, "news-chat-b-source");
      const preview = await previewExampleFeed(gateway, tokenB);
      const candidate = preview.candidates[0]!;
      let mark = emitted.length;
      const confirmPending = gateway.callTool(tokenB, "news.confirmSource", {
        confirmationId: preview.confirmationId,
        candidateId: candidate.candidateId,
        label: candidate.label,
        domain: candidate.domain
      });
      const confirmRequest = await waitForActionRequest(emitted, mark);
      await gateway.resolveActionRequest(ids.userB, confirmRequest.actionRequestId, "confirmed");
      await confirmPending;
      const bSources = await ownerSourceRows(ids.userB);
      expect(bSources).toHaveLength(1);
      const targetId = bSources[0]!.id;

      // Cross-owner attempt: A confirms removal of B's source id — RLS makes it
      // invisible, so the tool reports not-found and B's row is untouched.
      const tokenA = mint(ids.userA, "news-chat-a-remove-foreign");
      mark = emitted.length;
      const stealPending = gateway.callTool(tokenA, "news.removeSource", { sourceId: targetId });
      const stealRequest = await waitForActionRequest(emitted, mark);
      await gateway.resolveActionRequest(ids.userA, stealRequest.actionRequestId, "confirmed");
      const stealResult = await stealPending;
      expect(stealResult).toMatchObject({ ok: true });
      expect(JSON.stringify(stealResult)).toMatch(/not found/i);
      expect(await ownerSourceRows(ids.userB)).toHaveLength(1);

      // Positive control: the owner removes it, confirm-gated end to end.
      mark = emitted.length;
      const removePending = gateway.callTool(tokenB, "news.removeSource", { sourceId: targetId });
      const removeRequest = await waitForActionRequest(emitted, mark);
      expect(await ownerSourceRows(ids.userB)).toHaveLength(1);
      await gateway.resolveActionRequest(ids.userB, removeRequest.actionRequestId, "confirmed");
      const removeResult = await removePending;
      expect(removeResult).toMatchObject({ ok: true });
      expect(parseToolText(removeResult)).toMatchObject({ removed: true });
      expect(await ownerSourceRows(ids.userB)).toHaveLength(0);
      expect(
        await waitForAudit({
          toolName: "news.removeSource",
          outcome: "success",
          ownerUserId: ids.userB
        })
      ).toMatchObject({ owner_user_id: ids.userB, approval_mode: "confirmed" });
    }, 30_000);
  });
});
