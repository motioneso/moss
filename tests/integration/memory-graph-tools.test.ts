import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { memoryModuleManifest } from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { createCleanConversationFixture } from "./fixtures/clean-conversations.js";

const { Client } = pg;

const memoryGraphIds = {
  aSelf: "78000000-0000-4000-8000-000000000001",
  aFact: "78000000-0000-4000-8000-000000000002",
  aEpisode: "78000000-0000-4000-8000-000000000003",
  bSelf: "78000000-0000-4000-8000-000000000004",
  bFact: "78000000-0000-4000-8000-000000000005",
  bEpisode: "78000000-0000-4000-8000-000000000006"
} as const;

interface InvocationResponse {
  readonly invocation: {
    readonly moduleId: string;
    readonly name: string;
    readonly risk: "read" | "write" | "destructive";
    readonly status: "succeeded" | "blocked";
    readonly blockedReason: string | null;
    readonly actionRequestId: string | null;
    readonly result: Record<string, unknown> | null;
  };
}

describe("memory graph assistant tools", () => {
  let appDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let conversations: Awaited<ReturnType<typeof createCleanConversationFixture>>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let originalSecretKey: string | undefined;
  let originalEmbedProvider: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    originalEmbedProvider = process.env.JARVIS_EMBED_PROVIDER;
    process.env.JARVIS_AI_SECRET_KEY = "test-memory-graph-tools-secret-key";
    process.env.JARVIS_EMBED_PROVIDER = "stub";

    await resetFoundationDatabase();
    await seedMemoryGraphToolData();

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    runner = new DataContextRunner(appDb);
  });

  beforeEach(async () => {
    conversations = await createCleanConversationFixture(runner, [ids.userA, ids.userB]);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
    if (originalEmbedProvider === undefined) {
      delete process.env.JARVIS_EMBED_PROVIDER;
    } else {
      process.env.JARVIS_EMBED_PROVIDER = originalEmbedProvider;
    }
  });

  it("executes memory.recall through owner-scoped graph memory", async () => {
    const recall = await invokeReadTool("memory.recall", {
      query: "mobile responses"
    });

    expect(recall.result).toBeTruthy();
    expect(JSON.stringify(recall.result)).toContain("mobile responses");
    expect(JSON.stringify(recall.result)).not.toContain("User B graph memory");
  });

  it("requires confirmation for memory.remember and memory.forget", async () => {
    const rememberResponse = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/memory.remember/invoke",
      headers: userAHeaders(),
      payload: {
        input: {
          predicate: "prefers",
          objectText: "quiet confirmations",
          source: {
            sourceKind: "manual",
            sourceRef: "manual:tool-test",
            excerpt: "User asked for quiet confirmations."
          }
        }
      }
    });
    const forgetResponse = await server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/memory.forget/invoke",
      headers: userAHeaders(),
      payload: {
        input: { factId: memoryGraphIds.aFact }
      }
    });

    for (const response of [rememberResponse, forgetResponse]) {
      expect(response.statusCode).toBe(403);
      expect(response.json<InvocationResponse>().invocation).toMatchObject({
        moduleId: "memory",
        status: "blocked",
        blockedReason: "confirmation_required",
        result: null
      });
    }
    expect(rememberResponse.json<InvocationResponse>().invocation.risk).toBe("write");
    expect(forgetResponse.json<InvocationResponse>().invocation.risk).toBe("destructive");
  });

  it("gateway auto-runs memory.remember under trusted_auto but still confirms memory.forget (destructive floor)", async () => {
    const emitted: unknown[] = [];
    const { AiRepository, AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } =
      await import("@moss/ai");
    const repository = new AiRepository();
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [memoryModuleManifest],
      repository,
      ...conversations.gatewayDependencies,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 30_000,
      // memory_management promoted to trusted_auto: memory.remember (write, executionPolicy
      // "auto") must auto-run, but memory.forget's destructive risk always confirms regardless
      // of family tier — policy.ts checks risk === "destructive" before consulting the family at
      // all, so no family promotion can bypass it. This is the "existing destructive floor" the
      // task ruling preserves.
      actionPolicy: () => ({
        getFamilyTier: async () => "trusted_auto",
        getFamilyManifest: async () => memoryModuleManifest.assistantActionFamilies?.[0] ?? null
      })
    });
    const token = tokens.mint({
      ...conversations.bindingFor(ids.userA),
      chatSessionId: "memory-chat",
      allowedToolNames: null
    });

    const remembered = await gateway.callTool(token, "memory.remember", {
      predicate: "prefers",
      objectText: "trusted auto memory writes",
      source: {
        sourceKind: "manual",
        sourceRef: "manual:trusted-auto-test",
        excerpt: "User confirmed trusted auto memory writes."
      }
    });
    expect(remembered.ok).toBe(true);
    expect(emitted.some((r) => (r as { kind?: string }).kind === "action_request")).toBe(false);

    const forgotten = gateway.callTool(token, "memory.forget", {
      factId: memoryGraphIds.aFact
    });
    await vi.waitFor(() => {
      expect(emitted.some((r) => (r as { kind?: string }).kind === "action_request")).toBe(true);
    });
    const request = emitted.find((r) => (r as { kind?: string }).kind === "action_request") as {
      actionRequestId: string;
    };
    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    const forgetResult = await forgotten;
    expect(forgetResult.ok).toBe(true);
  });

  async function invokeReadTool(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<InvocationResponse["invocation"]> {
    const response = await server.inject({
      method: "POST",
      url: `/api/ai/assistant-tools/${toolName}/invoke`,
      headers: userAHeaders(),
      payload: { input }
    });

    expect(response.statusCode).toBe(200);

    const invocation = response.json<InvocationResponse>().invocation;

    expect(invocation).toMatchObject({
      name: toolName,
      risk: "read",
      status: "succeeded",
      blockedReason: null
    });

    return invocation;
  }
});

async function seedMemoryGraphToolData(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO app.memory_entities (id, owner_user_id, kind, name, summary)
        VALUES
          ($1, $2, 'self', 'Self', 'User A self'),
          ($3, $4, 'self', 'Self', 'User B self')
      `,
      [memoryGraphIds.aSelf, ids.userA, memoryGraphIds.bSelf, ids.userB]
    );
    await client.query(
      `
        INSERT INTO app.memory_facts (
          id,
          owner_user_id,
          subject_entity_id,
          predicate,
          object_text,
          confidence,
          provenance,
          importance,
          pinned
        )
        VALUES
          ($1, $2, $3, 'prefers', 'user A mobile responses', 0.95, 'confirmed', 0.90, true),
          ($4, $5, $6, 'related_to', 'User B graph memory', 0.95, 'confirmed', 0.90, true)
      `,
      [
        memoryGraphIds.aFact,
        ids.userA,
        memoryGraphIds.aSelf,
        memoryGraphIds.bFact,
        ids.userB,
        memoryGraphIds.bSelf
      ]
    );
    await client.query(
      `
        INSERT INTO app.memory_episodes (
          id,
          owner_user_id,
          source_kind,
          source_ref,
          source_label,
          excerpt
        )
        VALUES
          ($1, $2, 'manual', 'manual:tool-a', 'Tool seed', 'User A prefers mobile responses.'),
          ($3, $4, 'manual', 'manual:tool-b', 'Tool seed', 'User B private graph memory.')
      `,
      [memoryGraphIds.aEpisode, ids.userA, memoryGraphIds.bEpisode, ids.userB]
    );
    await client.query(
      `
        INSERT INTO app.memory_fact_sources (owner_user_id, fact_id, episode_id)
        VALUES
          ($1, $2, $3),
          ($4, $5, $6)
      `,
      [
        ids.userA,
        memoryGraphIds.aFact,
        memoryGraphIds.aEpisode,
        ids.userB,
        memoryGraphIds.bFact,
        memoryGraphIds.bEpisode
      ]
    );
    await client.query(
      `
        INSERT INTO app.memory_search_documents (owner_user_id, target_kind, target_id, search_text)
        VALUES
          ($1, 'fact', $2, 'prefers user A mobile responses'),
          ($3, 'fact', $4, 'related_to User B graph memory')
      `,
      [ids.userA, memoryGraphIds.aFact, ids.userB, memoryGraphIds.bFact]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

function userAHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ids.sessionA}`
  };
}
