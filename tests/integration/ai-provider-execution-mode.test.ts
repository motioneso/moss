import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { createDatabase, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("AI provider ACP identity", () => {
  let appDb: Kysely<MossDatabase>;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("persists the selected ACP agent and omits provider-level execution mode", async () => {
    const headers = { authorization: `Bearer ${ids.sessionAdmin}` };
    const createRes = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers,
      payload: {
        providerKind: "openai-compatible",
        displayName: "Codex",
        authMethod: "cli",
        acpAgentId: "codex-acp"
      }
    });

    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().provider;
    expect(created).toMatchObject({
      providerKind: "openai-compatible",
      authMethod: "cli",
      acpAgentId: "codex-acp"
    });
    expect(created).not.toHaveProperty("executionMode");

    const listRes = await server.inject({
      method: "GET",
      url: "/api/ai/providers",
      headers
    });
    expect(listRes.statusCode).toBe(200);
    const persisted = listRes
      .json()
      .providers.find((provider: { id: string }) => provider.id === created.id);
    expect(persisted?.acpAgentId).toBe("codex-acp");
    expect(persisted).not.toHaveProperty("executionMode");
  });

  it("rejects a CLI provider without a resolvable agent identity", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerKind: "custom",
        displayName: "Missing CLI identity",
        authMethod: "cli"
      }
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an ACP agent incompatible with the provider kind", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerKind: "openai-compatible",
        displayName: "Mismatched CLI identity",
        authMethod: "cli",
        acpAgentId: "claude-acp"
      }
    });

    expect(res.statusCode).toBe(400);
  });
});
