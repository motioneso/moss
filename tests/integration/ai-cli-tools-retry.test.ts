import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { createDatabase, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2689 slice 4: Retry on a tool update is an admin action and only applies to CLI providers.
describe("POST /api/ai/providers/:id/cli-check", () => {
  let appDb: Kysely<MossDatabase>;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let providerId: string;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    const created = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerKind: "openai-compatible",
        displayName: "Admin OpenAI",
        baseUrl: "https://api.openai.com/v1",
        authMethod: "api_key",
        credentialPayload: { apiKey: "sk-admin-test" }
      }
    });
    providerId = created.json().provider.id;
  }, 60_000);

  afterAll(async () => {
    await server.close();
    await boss.stop();
    await appDb.destroy();
  });

  it("refuses a non-admin", async () => {
    const response = await server.inject({
      method: "POST",
      url: `/api/ai/providers/${providerId}/cli-check`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a provider that is not a command-line tool", async () => {
    const response = await server.inject({
      method: "POST",
      url: `/api/ai/providers/${providerId}/cli-check`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect(response.statusCode).toBe(400);
  });
});
