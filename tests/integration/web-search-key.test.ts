import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const BRAVE_KEY = "secret-brave-key-do-not-leak-1234567890";
const SETTING_KEY = "web.brave_search_api_key";

describe("admin web search key", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await setUserAInstanceAdmin();

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

  it("gates writes to admins, encrypts at rest, and never returns the key", async () => {
    // Non-admin (user B) is denied read and write.
    const nonAdminGet = await server.inject({
      method: "GET",
      url: "/api/admin/settings/web-search",
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });
    const nonAdminPut = await server.inject({
      method: "PUT",
      url: "/api/admin/settings/web-search",
      headers: { authorization: `Bearer ${ids.sessionB}` },
      payload: { apiKey: BRAVE_KEY }
    });

    // Admin sees an unconfigured instance before saving.
    const initial = await server.inject({
      method: "GET",
      url: "/api/admin/settings/web-search",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    // Admin saves the key.
    const saved = await server.inject({
      method: "PUT",
      url: "/api/admin/settings/web-search",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { apiKey: BRAVE_KEY }
    });

    // GET after save reports configured + instance source, and leaks nothing.
    const afterSave = await server.inject({
      method: "GET",
      url: "/api/admin/settings/web-search",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    // Empty key is rejected.
    const emptyPut = await server.inject({
      method: "PUT",
      url: "/api/admin/settings/web-search",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { apiKey: "   " }
    });

    // The generic instance-settings route must refuse the secret key.
    const genericPatch = await server.inject({
      method: "PATCH",
      url: `/api/admin/settings/${SETTING_KEY}`,
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { value: BRAVE_KEY }
    });

    // Inspect the row at rest with the superuser (bypasses RLS).
    const storedRow = await readStoredSetting();

    // Revoke and confirm it clears.
    const revoked = await server.inject({
      method: "DELETE",
      url: "/api/admin/settings/web-search",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    const afterRevoke = await server.inject({
      method: "GET",
      url: "/api/admin/settings/web-search",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(nonAdminGet.statusCode).toBe(403);
    expect(nonAdminPut.statusCode).toBe(403);

    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      status: { configured: false, source: null, nativeSearchEnabled: true }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      status: { configured: true, source: "instance", nativeSearchEnabled: true }
    });

    expect(afterSave.statusCode).toBe(200);
    expect(afterSave.json()).toEqual({
      status: { configured: true, source: "instance", nativeSearchEnabled: true }
    });
    // The plaintext key and ciphertext envelope never appear in any response.
    expect(afterSave.body).not.toContain(BRAVE_KEY);
    expect(afterSave.body).not.toContain("ciphertext");

    expect(emptyPut.statusCode).toBe(400);
    expect(genericPatch.statusCode).toBe(400);

    // At rest: an AES-256-GCM envelope, never the plaintext key.
    expect(storedRow).not.toBeNull();
    const envelope = (storedRow as { value: { value: Record<string, unknown> } }).value.value;
    expect(envelope).toMatchObject({ version: 1, algorithm: "aes-256-gcm" });
    expect(envelope.iv).toBeTypeOf("string");
    expect(envelope.tag).toBeTypeOf("string");
    expect(envelope.ciphertext).toBeTypeOf("string");
    expect(JSON.stringify(storedRow)).not.toContain(BRAVE_KEY);

    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({
      status: { configured: false, source: null, nativeSearchEnabled: true }
    });
    expect(afterRevoke.json()).toEqual({
      status: { configured: false, source: null, nativeSearchEnabled: true }
    });
  });
});

async function readStoredSetting(): Promise<unknown> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const result = await client.query(`SELECT value FROM app.instance_settings WHERE key = $1`, [
      SETTING_KEY
    ]);
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

async function setUserAInstanceAdmin(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(`UPDATE app.users SET is_instance_admin = true WHERE id = $1`, [ids.userA]);
  } finally {
    await client.end();
  }
}
