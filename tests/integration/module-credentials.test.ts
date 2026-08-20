import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutgoingHttpHeaders } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { Client } from "pg";

import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

// #918 Task 25: exercise the six module-credential routes end-to-end via app.inject.
// Mirrors external-modules-routes.test.ts's harness (real server, temp modules dir,
// better-auth sign-up cookie pattern) — do not invent a new path. The fixture manifest
// declares one instance-scope and one user-scope credential slot so both the admin and
// /me surfaces (and their cross-scope isolation) are exercised.

const PLAINTEXT = "super-secret-plaintext-123";

let root: string;
let appDb: Kysely<MossDatabase>;
let boss: PgBoss;
let server: ReturnType<typeof createApiServer>;
let adminCookie: string;
let memberCookie: string;
let member2Cookie: string;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  // Only the bootstrap sign-up is auto-active; every later sign-up defaults to
  // status:'pending' (registration.requires_approval defaults true) and
  // resolveAccessContext 403s pending users on EVERY route. This suite signs up
  // non-admin members and exercises their /me routes directly, so approval gating
  // must be off — mirrors multi-user-isolation.test.ts's arrange step.
  await setInstanceSetting("registration.requires_approval", { value: false });

  root = mkdtempSync(join(tmpdir(), "creds-routes-"));
  const modulesDir = join(root, "modules");
  const dir = join(modulesDir, "creds-fixture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "jarvis.module.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "creds-fixture",
      name: "Creds Fixture",
      version: "0.1.0",
      publisher: "Test Publisher",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.1.0" },
      auth: [
        {
          id: "creds-fixture.api",
          displayName: "API key",
          kind: "api-key",
          scope: "instance"
        },
        {
          id: "creds-fixture.user-token",
          displayName: "User token",
          kind: "api-key",
          scope: "user"
        }
      ]
    })
  );

  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
  // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
  // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
  // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
  // Test-only — production callers of createApiServer() are unaffected.
  boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  server = createApiServer({
    appDb,
    boss,
    logger: false,
    apiServerConfig: {
      host: "0.0.0.0",
      port: 0,
      mcpServerUrl: "http://127.0.0.1:0/api/mcp",
      externalModulesDir: modulesDir
    }
  });
  await server.ready();

  // First sign-up bootstraps the instance owner (admin); the rest are plain members.
  adminCookie = (await signUp(server, "owner@creds.test", "Owner")).cookie;
  memberCookie = (await signUp(server, "member@creds.test", "Member")).cookie;
  member2Cookie = (await signUp(server, "member2@creds.test", "Member Two")).cookie;

  // Enable the module so it's active for reconciliation-dependent surfaces used
  // elsewhere in this slice; credential routes themselves don't require enable.
  await server.inject({
    method: "POST",
    url: "/api/admin/external-modules/creds-fixture",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    payload: { enabled: true }
  });
});

afterAll(async () => {
  await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  rmSync(root, { recursive: true, force: true });
});

describe("module credential routes (#918)", () => {
  it("1. admin lists the instance-scope slot as not-configured", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/modules/creds-fixture/credentials",
      headers: { cookie: adminCookie }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.moduleId).toBe("creds-fixture");
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]).toMatchObject({
      credentialId: "creds-fixture.api",
      displayName: "API key",
      scope: "instance",
      configured: false,
      updatedAt: null
    });
  });

  it("2. admin sets the instance-scope slot; plaintext never appears in the response", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/admin/modules/creds-fixture/credentials/creds-fixture.api",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { value: PLAINTEXT }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectNoPlaintext(body);
    expect(body.credential).toMatchObject({
      credentialId: "creds-fixture.api",
      scope: "instance",
      configured: true
    });
    expect(typeof body.credential.updatedAt).toBe("string");
  });

  it("3. the stored row holds an AES-256-GCM envelope, never plaintext", async () => {
    const row = await readCredentialRow("creds-fixture", "creds-fixture.api", "instance");
    expect(row).not.toBeNull();
    expect(row!.revoked_at).toBeNull();
    const envelope = row!.encrypted_secret as Record<string, unknown>;
    expect(envelope).toBeTruthy();
    expectNoPlaintext(envelope);
    // Envelope shape sanity: ciphertext/iv/authTag-ish fields, never a bare "value".
    expect(JSON.stringify(envelope)).not.toContain(PLAINTEXT);
  });

  it("4. a non-admin member gets 403 on the admin credential surface", async () => {
    const getRes = await server.inject({
      method: "GET",
      url: "/api/admin/modules/creds-fixture/credentials",
      headers: { cookie: memberCookie }
    });
    expect(getRes.statusCode).toBe(403);

    const putRes = await server.inject({
      method: "PUT",
      url: "/api/admin/modules/creds-fixture/credentials/creds-fixture.api",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { value: PLAINTEXT }
    });
    expect(putRes.statusCode).toBe(403);

    const deleteRes = await server.inject({
      method: "DELETE",
      url: "/api/admin/modules/creds-fixture/credentials/creds-fixture.api",
      headers: { cookie: memberCookie }
    });
    expect(deleteRes.statusCode).toBe(403);
  });

  it("5. /me flow: a member sets their own user-scope slot, isolated from another member", async () => {
    const setRes = await server.inject({
      method: "PUT",
      url: "/api/me/modules/creds-fixture/credentials/creds-fixture.user-token",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { value: PLAINTEXT }
    });
    expect(setRes.statusCode).toBe(200);
    expectNoPlaintext(setRes.json());

    const ownRes = await server.inject({
      method: "GET",
      url: "/api/me/modules/creds-fixture/credentials",
      headers: { cookie: memberCookie }
    });
    expect(ownRes.json().credentials[0]).toMatchObject({
      credentialId: "creds-fixture.user-token",
      scope: "user",
      configured: true
    });

    // A second member's own slot is untouched — no cross-user leak.
    const otherRes = await server.inject({
      method: "GET",
      url: "/api/me/modules/creds-fixture/credentials",
      headers: { cookie: member2Cookie }
    });
    expect(otherRes.json().credentials[0]).toMatchObject({
      credentialId: "creds-fixture.user-token",
      scope: "user",
      configured: false
    });

    // And the admin's own /me state (admin is also a user) is independently unconfigured.
    const adminOwnRes = await server.inject({
      method: "GET",
      url: "/api/me/modules/creds-fixture/credentials",
      headers: { cookie: adminCookie }
    });
    expect(adminOwnRes.json().credentials[0]).toMatchObject({
      credentialId: "creds-fixture.user-token",
      scope: "user",
      configured: false
    });
  });

  it("9. the user surface reports that an admin owns the instance-scope half (#1759)", async () => {
    // Read from the manifest, not from stored secrets: the flag must be true even when nobody
    // has filled the instance slot, and it must never imply anything about its value.
    const meRes = await server.inject({
      method: "GET",
      url: "/api/me/modules/creds-fixture/credentials",
      headers: { cookie: memberCookie }
    });
    expect(meRes.json().instanceManaged).toBe(true);
    // Every returned slot is still user-scope only — the flag adds a fact, not an instance row.
    for (const credential of meRes.json().credentials as { scope: string }[]) {
      expect(credential.scope).toBe("user");
    }

    // The admin surface omits the flag entirely; it is meaningless there.
    const adminRes = await server.inject({
      method: "GET",
      url: "/api/admin/modules/creds-fixture/credentials",
      headers: { cookie: adminCookie }
    });
    expect(adminRes.json().instanceManaged).toBeUndefined();
  });

  it("6. unknown credential id 404s on both surfaces", async () => {
    const adminRes = await server.inject({
      method: "PUT",
      url: "/api/admin/modules/creds-fixture/credentials/creds-fixture.ghost",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { value: PLAINTEXT }
    });
    expect(adminRes.statusCode).toBe(404);

    const meRes = await server.inject({
      method: "PUT",
      url: "/api/me/modules/creds-fixture/credentials/creds-fixture.ghost",
      headers: { cookie: memberCookie, "content-type": "application/json" },
      payload: { value: PLAINTEXT }
    });
    expect(meRes.statusCode).toBe(404);
  });

  it("7. revoke scrubs the envelope (not a row delete); a second revoke 404s", async () => {
    const revokeRes = await server.inject({
      method: "DELETE",
      url: "/api/me/modules/creds-fixture/credentials/creds-fixture.user-token",
      headers: { cookie: memberCookie }
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().credential).toMatchObject({ configured: false });

    const row = await readCredentialRow("creds-fixture", "creds-fixture.user-token", "user");
    expect(row).not.toBeNull();
    expect(row!.encrypted_secret).toBeNull();
    expect(row!.revoked_at).not.toBeNull();

    const secondRevokeRes = await server.inject({
      method: "DELETE",
      url: "/api/me/modules/creds-fixture/credentials/creds-fixture.user-token",
      headers: { cookie: memberCookie }
    });
    expect(secondRevokeRes.statusCode).toBe(404);
  });

  it("8. anonymous requests get 401 on all six routes", async () => {
    const requests: Array<{ method: "GET" | "PUT" | "DELETE"; url: string }> = [
      { method: "GET", url: "/api/admin/modules/creds-fixture/credentials" },
      { method: "PUT", url: "/api/admin/modules/creds-fixture/credentials/creds-fixture.api" },
      { method: "DELETE", url: "/api/admin/modules/creds-fixture/credentials/creds-fixture.api" },
      { method: "GET", url: "/api/me/modules/creds-fixture/credentials" },
      {
        method: "PUT",
        url: "/api/me/modules/creds-fixture/credentials/creds-fixture.user-token"
      },
      {
        method: "DELETE",
        url: "/api/me/modules/creds-fixture/credentials/creds-fixture.user-token"
      }
    ];
    for (const { method, url } of requests) {
      const res = await server.inject({
        method,
        url,
        // Only set a JSON content-type when there's actually a body — Fastify's
        // JSON body parser 400s on an empty body with `content-type:
        // application/json` set, which would mask the 401 this test is checking.
        headers: method === "PUT" ? { "content-type": "application/json" } : {},
        payload: method === "PUT" ? { value: PLAINTEXT } : undefined
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

function expectNoPlaintext(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(PLAINTEXT);
}

// FORCE RLS on app.module_credentials means `appDb` (no actor GUCs set) always
// sees zero rows here — it's the app_runtime pool, not a per-actor DataContext.
// Read through the bootstrap superuser connection instead, mirroring
// web-search-key.test.ts's readStoredSetting.
async function readCredentialRow(
  moduleId: string,
  credentialId: string,
  scope: "instance" | "user"
): Promise<{ encrypted_secret: unknown; revoked_at: string | null } | null> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT encrypted_secret, revoked_at FROM app.module_credentials
       WHERE module_id = $1 AND credential_id = $2 AND scope = $3`,
      [moduleId, credentialId, scope]
    );
    return (result.rows[0] as { encrypted_secret: unknown; revoked_at: string | null }) ?? null;
  } finally {
    await client.end();
  }
}

async function signUp(
  target: ReturnType<typeof createApiServer>,
  email: string,
  name: string
): Promise<{ cookie: string; userId: string }> {
  const res = await target.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { "content-type": "application/json" },
    payload: { name, email, password: "correct horse battery staple" }
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-up for ${email} failed (${res.statusCode}): ${res.body}`);
  }
  return {
    cookie: cookieHeader(res.headers),
    userId: res.json<{ user: { id: string } }>().user.id
  };
}

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}
