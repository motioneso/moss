// #2159 diagnostic: proves whether the missing "Retry sports source" action card in live UAT is
// a tool-listing/discovery problem or a confirm/notify/DB-wiring problem. Follows the real-gateway
// pattern from mcp-gateway-self-operation.test.ts:295-376 plus the real MCP HTTP transport from
// chat-mcp-transport.test.ts. See docs/superpowers/plans/2026-08-31-2159-sports-retry-card.md.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";

import type { AccessContext } from "@moss/db";
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { createActiveModulesResolver } from "../../packages/module-registry/src/active-modules-resolver.js";
import {
  configureSportsChatTools,
  resetSportsChatToolsForTests,
  sportsModuleManifest,
  type SportsSourceService
} from "@moss/sports";
import type { SportsCustomSourceDto } from "@moss/shared";
import { registerMcpTransportRoute } from "../../packages/chat/src/mcp-transport.js";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const RETRY_SOURCE_ID = "22222222-2222-4222-8222-222222222222";

const retriedSource: SportsCustomSourceDto = {
  id: RETRY_SOURCE_ID,
  label: "Test Sports Source",
  canonicalDomain: "example.com",
  homepageUrl: "https://example.com",
  feedUrl: null,
  retrievalMethod: "scrape",
  enabled: true,
  healthState: "healthy",
  healthReasonCode: null,
  healthMessage: null,
  lastCheckedAt: "2026-08-31T00:00:00.000Z",
  lastSuccessAt: "2026-08-31T00:00:00.000Z",
  recipeStatus: "ready",
  assignedFollowIds: [],
  assignments: [],
  createdAt: "2026-08-31T00:00:00.000Z"
};

/** Mirrors the minimal resolve route from chat-mcp-transport.test.ts (registerChatRoutes' real shape). */
function registerResolveRoute(
  app: FastifyInstance,
  gateway: AssistantToolGateway,
  actorUserId: string
) {
  app.post<{ Params: { id: string }; Body: { status: string } }>(
    "/api/chat/action-requests/:id/resolve",
    async (request, reply) => {
      const rawStatus = (request.body as { status?: unknown }).status;
      if (rawStatus !== "confirmed" && rawStatus !== "rejected" && rawStatus !== "cancelled") {
        return reply.code(400).send({ error: "status must be confirmed, rejected, or cancelled" });
      }
      try {
        await gateway.resolveActionRequest(actorUserId, request.params.id, rawStatus);
        return reply.code(204).send();
      } catch {
        return reply.code(400).send({ error: "Could not resolve action request" });
      }
    }
  );
}

describe("sports.retrySource action card (#2159)", () => {
  let appDb: Kysely<MossDatabase>;
  let app: FastifyInstance;
  let runner: DataContextRunner;
  let repository: AiRepository;
  let tokens: SessionTokenRegistry;
  let gateway: AssistantToolGateway;
  let emitted: { chatSessionId: string; record: GatewaySessionRecord }[];

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    runner = new DataContextRunner(appDb);
    repository = new AiRepository();

    // Only retrySource is exercised here, so the fake implements just that one method — same
    // convention as fakeCalendarWrite/fakeWriter elsewhere in this suite. No default actionPolicy
    // override is needed: sports.retrySource is risk "write" with a declared actionFamilyId, and
    // the gateway's built-in default policy lookup (getFamilyManifest -> null) already resolves
    // that to "confirm" (packages/ai/src/gateway/policy.ts:47), matching what sports.sources'
    // manifest (defaultTier "ask_each_time", no trusted_auto) would resolve to anyway.
    const fakeSourceService = {
      retrySource: async (_ctx: AccessContext, sourceId: string) => {
        if (sourceId !== RETRY_SOURCE_ID) {
          throw new Error(`unexpected sourceId ${sourceId}`);
        }
        return retriedSource;
      }
    } as unknown as SportsSourceService;
    configureSportsChatTools({} as never, undefined, fakeSourceService);

    tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    emitted = [];

    gateway = new AssistantToolGateway({
      resolveActiveModules: createActiveModulesResolver({
        dataContext: runner,
        manifests: [sportsModuleManifest]
      }),
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 5_000
    });

    app = Fastify({ logger: false });
    registerMcpTransportRoute(app, { gateway, tokens });
    registerResolveRoute(app, gateway, ids.userA);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await appDb.destroy();
    resetSportsChatToolsForTests();
  });

  beforeEach(() => {
    emitted.length = 0;
  });

  // Branch 1 of the split: if this fails, tool availability/selection is the broken boundary.
  it("tools/list includes sports.retrySource with an inputSchema requiring sourceId", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: randomUUID(),
      allowedToolNames: null
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { authorization: `Bearer ${token}` },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      result: { tools: { name: string; inputSchema: { required?: string[] } }[] };
    }>();
    const tool = body.result.tools.find((t) => t.name === "sports.retrySource");
    expect(
      tool,
      "sports.retrySource missing from tools/list — tool availability is the broken boundary"
    ).toBeDefined();
    expect(tool!.inputSchema.required).toContain("sourceId");
  });

  // Branch 2 of the split: if branch 1 passes but this fails, the defect is in
  // confirmAndRun/notifier/stream delivery, not tool selection.
  it("tools/call for sports.retrySource emits action_request, creates a pending row, and confirming it executes and emits action_result", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: randomUUID(),
      allowedToolNames: null
    });

    const callPromise = app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { authorization: `Bearer ${token}` },
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sports.retrySource", arguments: { sourceId: RETRY_SOURCE_ID } }
      }
    });

    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 5_000 });
    const request = emitted[0]!.record;
    expect(request.kind).toBe("action_request");
    if (request.kind !== "action_request") throw new Error("unreachable");
    expect(request.toolName).toBe("sports.retrySource");
    expect(request.summary).toMatch(/^Retry sports source /);

    const pending = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-2159-pending-check" },
      (scopedDb) => repository.getAssistantAction(scopedDb, request.actionRequestId)
    );
    expect(pending?.status).toBe("pending");

    const resolveRes = await app.inject({
      method: "POST",
      url: `/api/chat/action-requests/${request.actionRequestId}/resolve`,
      payload: { status: "confirmed" }
    });
    expect(resolveRes.statusCode).toBe(204);

    const callRes = await callPromise;
    expect(callRes.statusCode).toBe(200);
    const callBody = callRes.json<{ result: { isError: boolean; content: { text: string }[] } }>();
    expect(callBody.result.isError).toBe(false);
    const data = JSON.parse(callBody.result.content[0]!.text) as { source: SportsCustomSourceDto };
    expect(data.source.id).toBe(RETRY_SOURCE_ID);

    expect(emitted).toHaveLength(2);
    const resultRecord = emitted[1]!.record;
    expect(resultRecord.kind).toBe("action_result");
    if (resultRecord.kind !== "action_result") throw new Error("unreachable");
    expect(resultRecord.outcome).toBe("executed");
  });
});
