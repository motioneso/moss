import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type CompiledQuery
} from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { MossDatabase } from "@moss/db";
import type { MossAuthRuntime } from "@moss/auth";
import type { PgBoss } from "@moss/jobs";
import type { RouteChatPolicy } from "@moss/module-sdk";
import type { AppMapArtifact } from "@moss/shared";
import type * as AppMapModule from "../../packages/settings/src/app-map.js";
import { createApiServer } from "../../apps/api/src/server.js";

// Fresh unit CI intentionally has no built dist/app-map.json. Only replace that unrelated
// artifact loader; all real route registration and onReady assertions remain in this probe.
vi.mock("../../packages/settings/src/app-map.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AppMapModule>();
  const artifact: AppMapArtifact = {
    schemaVersion: 1,
    build: { version: "test", buildId: "route-chat-boot" },
    screens: [],
    settings: [],
    features: [],
    errors: [],
    remediations: [],
    narrative: { authoritative: false, markdown: "" }
  };
  return { ...actual, loadAppMap: () => artifact };
});

/** Boot the real server with an in-memory driver; no database connection can be opened. */
async function bootProbe(chat?: RouteChatPolicy) {
  const queries: CompiledQuery[] = [];
  const connection = {
    async executeQuery(query: CompiledQuery) {
      queries.push(query);
      if (
        query.sql === 'select "value" from "app"."instance_settings" where "key" = $1' &&
        [
          "chat.multiplexer",
          "chat.persistent_runtime.enabled",
          "chat.persistent_pool_cap"
        ].includes(String(query.parameters[0]))
      )
        return { rows: [] };
      throw new Error("Unexpected SQL in the isolated boot probe");
    },
    streamQuery() {
      throw new Error("Boot probe must not stream");
    }
  } as unknown as DatabaseConnection;
  class BootDriver extends DummyDriver {
    override async acquireConnection() {
      return connection;
    }
  }
  const db = new Kysely<MossDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new BootDriver(),
      createIntrospector: (value) => new PostgresIntrospector(value),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
  const externalModulesDir = mkdtempSync(join(tmpdir(), "route-chat-boot-"));
  const authRuntime = {
    auth: { handler: vi.fn(async () => new Response(null, { status: 401 })) },
    resolveAccessContext: vi.fn(async () => ({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      requestId: "boot-probe"
    })),
    listConfiguredProviders: () => [],
    trustedOrigins: [],
    close: async () => undefined
  } as unknown as MossAuthRuntime;
  const server = createApiServer({
    appDb: db,
    workerDb: db,
    boss: {} as PgBoss,
    authRuntime,
    logger: false,
    apiServerConfig: { host: "127.0.0.1", port: 0, mcpServerUrl: "", externalModulesDir },
    __testExtraGuardedRoutes: {
      manifests: [
        {
          id: "__chat_policy_probe__",
          name: "Chat policy probe",
          version: "0.1.0",
          publisher: "test",
          lifecycle: "optional",
          compatibility: { jarv1s: ">=0.0.0" },
          routes: [{ method: "GET", path: "/api/__chat_policy_probe__", ...(chat ? { chat } : {}) }]
        }
      ],
      routes: [
        { method: "GET", url: "/api/__chat_policy_probe__" },
        // Chat engine plumbing is intentionally unwired without an MCP server URL. Inert
        // placeholders preserve the real route-coverage check, as in the integration probe.
        { method: "POST", url: "/api/chat/action-requests/:id/resolve" },
        { method: "POST", url: "/api/mcp" },
        { method: "POST", url: "/internal/permission" },
        { method: "POST", url: "/internal/vault-read-report" }
      ]
    }
  });
  return {
    server,
    queries,
    async close() {
      await server.close();
      await db.destroy();
      rmSync(externalModulesDir, { recursive: true, force: true });
    }
  };
}

describe("real API route-chat boot guard", () => {
  it("refuses an injected unclassified route in onReady", async () => {
    const probe = await bootProbe();
    try {
      await expect(probe.server.ready()).rejects.toThrow(
        /GET \/api\/__chat_policy_probe__.*no chat access/
      );
      expect(
        probe.queries.every((query) =>
          [
            "chat.multiplexer",
            "chat.persistent_runtime.enabled",
            "chat.persistent_pool_cap"
          ].includes(String(query.parameters[0]))
        )
      ).toBe(true);
    } finally {
      await probe.close();
    }
  });
  it("boots with the same route explicitly classified", async () => {
    const probe = await bootProbe({ access: "read", content: "user_authored" });
    try {
      await probe.server.ready();
      expect(
        probe.queries.every((query) =>
          [
            "chat.multiplexer",
            "chat.persistent_runtime.enabled",
            "chat.persistent_pool_cap"
          ].includes(String(query.parameters[0]))
        )
      ).toBe(true);
    } finally {
      await probe.close();
    }
  });
});
