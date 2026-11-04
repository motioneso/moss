import { randomUUID } from "node:crypto";

import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiServer } from "../../apps/api/src/server.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Goes through the production composition (createApiServer and the real tool route), so a
// reader that is missing from the host wiring shows up here as a redacted admin section.

// An existing production queue, so the job row satisfies the queue foreign key.
const QUEUE = "connectors.google-sync";
const MARKER = "COMPOSITION-SECRET-MARKER";

async function bootstrap(text: string, values: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(text, values);
  } finally {
    await client.end();
  }
}

describe("platform diagnostics through the production composition", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await bootstrap(`UPDATE app.users SET is_instance_admin = true WHERE id = $1`, [ids.userA]);
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    await bootstrap(
      `INSERT INTO pgboss.job (id, name, data, state, output, started_on, completed_on)
       VALUES ($1, $2, $3::jsonb, 'failed', $4::jsonb, now(), now())`,
      [
        randomUUID(),
        QUEUE,
        JSON.stringify({ actorUserId: ids.userA, kind: "composition-kind", note: MARKER }),
        JSON.stringify({ message: MARKER })
      ]
    );
  }, 120_000);

  afterAll(async () => {
    await bootstrap(
      "DELETE FROM pgboss.job WHERE name = $1 AND data->>'kind' = 'composition-kind'",
      [QUEUE]
    ).catch(() => undefined);
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  function invoke(session: string) {
    return server.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/settings.platformDiagnostics/invoke",
      headers: { authorization: `Bearer ${session}` },
      payload: { input: { include: ["jobs", "connections"] } }
    });
  }

  it("returns job detail to an admin, with no payload or failure text", async () => {
    const response = await invoke(ids.sessionA);
    expect(response.statusCode).toBe(200);
    const body = response.body;
    const result = response.json().invocation.result as {
      jobs: { recent: { queue: string; state: string; kind: string | null }[] };
      redactions: string[];
    };
    expect(result.redactions).not.toContain("jobs");
    expect(result.redactions).not.toContain("connections");
    const row = result.jobs.recent.find((entry) => entry.queue === QUEUE);
    expect(row).toMatchObject({ state: "failed", kind: "composition-kind" });
    expect(body).not.toContain(MARKER);
  });

  it("redacts both sections for a non-admin and returns no job data", async () => {
    const response = await invoke(ids.sessionB);
    expect(response.statusCode).toBe(200);
    const result = response.json().invocation.result as {
      jobs: { recent: unknown[] };
      redactions: string[];
    };
    expect(result.redactions).toEqual(expect.arrayContaining(["jobs", "connections"]));
    expect(result.jobs.recent).toEqual([]);
    expect(response.body).not.toContain(QUEUE);
  });
});
