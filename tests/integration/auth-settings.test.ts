import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import { sql, type Kysely } from "kysely";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { ListAdminAuditEventsResponse, ListModulesResponse, MeResponse } from "@moss/shared";
import {
  connectionStrings,
  expectedBuiltInModuleIds,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";
import { createMossAuthRuntime, type MossAuthRuntime } from "@moss/auth";
import { SettingsRepository } from "../../packages/settings/src/repository.js";
import { deleteUserData, LastActiveAdminError } from "../../scripts/delete-user-data.js";

describe("M3 auth, users, settings", () => {
  const authEnvKeys = [
    "JARVIS_AUTH_GOOGLE_CLIENT_ID",
    "JARVIS_AUTH_GOOGLE_CLIENT_SECRET",
    "JARVIS_AUTH_OIDC_PROVIDER_ID",
    "JARVIS_AUTH_OIDC_DISPLAY_NAME",
    "JARVIS_AUTH_OIDC_CLIENT_ID",
    "JARVIS_AUTH_OIDC_CLIENT_SECRET",
    "JARVIS_AUTH_OIDC_DISCOVERY_URL"
  ] as const;
  let appDb: Kysely<MossDatabase>;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let originalAuthEnv: Record<(typeof authEnvKeys)[number], string | undefined>;
  let ownerCookie: string;
  let memberCookie: string;
  let ownerUserId: string;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    originalAuthEnv = readOriginalAuthEnv(authEnvKeys);
    process.env.JARVIS_AUTH_GOOGLE_CLIENT_ID = "google-client";
    process.env.JARVIS_AUTH_GOOGLE_CLIENT_SECRET = "google-secret";
    process.env.JARVIS_AUTH_OIDC_PROVIDER_ID = "acme";
    process.env.JARVIS_AUTH_OIDC_DISPLAY_NAME = "Acme OIDC";
    process.env.JARVIS_AUTH_OIDC_CLIENT_ID = "acme-client";
    process.env.JARVIS_AUTH_OIDC_CLIENT_SECRET = "acme-secret";
    process.env.JARVIS_AUTH_OIDC_DISCOVERY_URL =
      "https://idp.example.test/.well-known/openid-configuration";

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1,
      // #1122: createDatabase()'s default connectionTimeoutMillis (JARVIS_DB_CONNECT_TIMEOUT_MS
      // ?? 5000) applies to queued pool.connect() waiters too, not just new physical
      // connections. With maxConnections:1, any 2 overlapping queries during
      // createApiServer()'s server.ready() boot can hit that 5000ms ceiling on a loaded CI
      // runner, producing an error shape easily mistaken for pg-boss's own timeout. Same
      // longer-but-still-under-hookTimeout override pattern as the #1124 boss fix below.
      // Test-only — production callers of createDatabase() are unaffected.
      connectionTimeoutMillis: 25_000
    });
    // Disable requires_approval so subsequently-registered users in M3 tests get active status.
    // (Phase 2 Slice A approval-flow tests run in their own describe with a fresh DB per test.)
    await setInstanceSetting("registration.requires_approval", { value: false });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({
      appDb,
      boss,
      logger: false
    });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
    restoreAuthEnv(originalAuthEnv);
  });

  it("bootstraps the first Better Auth user as instance owner", async () => {
    const initialStatus = await server.inject({
      method: "GET",
      url: "/api/bootstrap/status"
    });
    const signUpResponse = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        name: "Owner User",
        email: "owner@example.test",
        password: "correct horse battery staple"
      }
    });
    const bootstrappedStatus = await server.inject({
      method: "GET",
      url: "/api/bootstrap/status"
    });

    ownerCookie = cookieHeader(signUpResponse.headers);
    ownerUserId = signUpResponse.json<{ user: { id: string } }>().user.id;

    expect(initialStatus.statusCode).toBe(200);
    expect(initialStatus.json()).toEqual({ needsBootstrap: true });
    expect(signUpResponse.statusCode).toBe(200);
    expect(ownerCookie).toContain("better-auth");
    expect(bootstrappedStatus.json()).toEqual({ needsBootstrap: false });

    const meResponse = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        cookie: ownerCookie
      }
    });
    const me = meResponse.json<MeResponse>();

    expect(meResponse.statusCode).toBe(200);
    expect(me.user).toMatchObject({
      id: ownerUserId,
      email: "owner@example.test",
      emailVerified: false,
      isInstanceAdmin: true
    });
  });

  it("bootstrap writes audit event with action bootstrap_owner_created", async () => {
    const auditResponse = await server.inject({
      method: "GET",
      url: "/api/admin/audit-events",
      headers: { cookie: ownerCookie }
    });
    const events = auditResponse.json<ListAdminAuditEventsResponse>().auditEvents;
    const actions = events.map((event) => event.action);
    expect(actions).toContain("bootstrap_owner_created");
    const bootstrapEvent = events.find((event) => event.action === "bootstrap_owner_created");
    expect(bootstrapEvent?.actorUserId).toBe(ownerUserId);
  });

  it("bootstrap audit event is written by the SECURITY DEFINER helper", async () => {
    if (!ownerUserId) {
      const signUpResponse = await server.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          name: "Owner User",
          email: "owner-helper@example.test",
          password: "correct horse battery staple"
        }
      });

      expect(signUpResponse.statusCode).toBe(200);
      ownerCookie = cookieHeader(signUpResponse.headers);
      ownerUserId = signUpResponse.json<{ user: { id: string } }>().user.id;
    }

    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });

    await client.connect();
    try {
      const helper = await client.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM app.admin_audit_events
          WHERE action = 'bootstrap_owner_created'
            AND metadata ? 'recordedBy'
            AND metadata->>'recordedBy' = 'record_bootstrap_owner_audit_event'
        `
      );

      expect(Number(helper.rows[0]?.count ?? 0)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("recordAuditEvent writes an audit row via the public settings API", async () => {
    // ownerUserId is set by the preceding bootstrap test — use it as the actor so
    // the GUC-scoped insert passes RLS on app.admin_audit_events.
    const { recordAuditEvent } = await import("@moss/settings");
    const runner = new DataContextRunner(appDb);
    await runner.withDataContext(
      { actorUserId: ownerUserId, requestId: "test:record-audit" },
      async (scopedDb) => {
        await recordAuditEvent(scopedDb, {
          actorUserId: ownerUserId,
          action: "test.record_audit_event",
          targetType: "user",
          targetId: ownerUserId,
          metadata: {},
          requestId: "test:record-audit"
        });
      }
    );

    // admin_audit_events SELECT is admin-gated by RLS (migration 0059); read back through
    // the owner's admin DataContext so the GUC-scoped policy admits the row.
    const rows = await runner.withDataContext(
      { actorUserId: ownerUserId, requestId: "test:record-audit-read" },
      (scopedDb) =>
        sql<{ action: string; actor_user_id: string }>`
          SELECT action, actor_user_id FROM app.admin_audit_events
          WHERE action = 'test.record_audit_event'
        `.execute(scopedDb.db)
    );
    expect(rows.rows[0]?.action).toBe("test.record_audit_event");
    expect(rows.rows[0]?.actor_user_id).toBe(ownerUserId);
  });

  it("exposes configured auth provider status without secrets", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/admin/auth/providers",
      headers: {
        cookie: ownerCookie
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providers: [
        {
          id: "email-password",
          displayName: "Email and password",
          providerType: "local",
          enabled: true
        },
        {
          id: "google",
          displayName: "Google",
          providerType: "oauth",
          enabled: true
        },
        {
          id: "github",
          displayName: "GitHub",
          providerType: "oauth",
          enabled: false
        },
        {
          id: "microsoft",
          displayName: "Microsoft",
          providerType: "oauth",
          enabled: false
        },
        {
          id: "acme",
          displayName: "Acme OIDC",
          providerType: "oidc",
          enabled: true
        }
      ]
    });
    expect(response.body).not.toContain("google-secret");
    expect(response.body).not.toContain("acme-secret");
  });

  it("exposes session-gated module metadata for the app shell", async () => {
    const deniedResponse = await server.inject({
      method: "GET",
      url: "/api/modules"
    });
    const allowedResponse = await server.inject({
      method: "GET",
      url: "/api/modules",
      headers: {
        cookie: ownerCookie
      }
    });
    const modules = allowedResponse.json<ListModulesResponse>().modules;

    expect(deniedResponse.statusCode).toBe(401);
    expect(allowedResponse.statusCode).toBe(200);
    expect(modules.map((module) => module.id)).toEqual(expectedBuiltInModuleIds);
    expect(modules.flatMap((module) => module.navigation).map((entry) => entry.path)).toEqual([
      "/settings",
      "/tasks",
      "/calendar",
      "/chat",
      "/briefings",
      "/wellness",
      "/sports",
      "/news",
      "/workshop"
    ]);
  });

  it("keeps later users non-admin and protects admin APIs", async () => {
    const signUpResponse = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        name: "Member User",
        email: "member@example.test",
        password: "correct horse battery staple"
      }
    });

    memberCookie = cookieHeader(signUpResponse.headers);

    const deniedResponse = await server.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: {
        cookie: memberCookie
      }
    });
    const allowedResponse = await server.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: {
        cookie: ownerCookie
      }
    });

    expect(signUpResponse.statusCode).toBe(200);
    expect(deniedResponse.statusCode).toBe(403);
    expect(allowedResponse.statusCode).toBe(200);
    expect(
      allowedResponse
        .json<{
          users: Array<{ email: string; emailVerified: boolean; isInstanceAdmin: boolean }>;
        }>()
        .users.map((user) => ({
          email: user.email,
          emailVerified: user.emailVerified,
          isInstanceAdmin: user.isInstanceAdmin
        }))
    ).toEqual([
      { email: "owner@example.test", emailVerified: false, isInstanceAdmin: true },
      { email: "member@example.test", emailVerified: false, isInstanceAdmin: false }
    ]);
  });

  it("lets admins patch instance settings (known key)", async () => {
    const settingResponse = await server.inject({
      method: "PATCH",
      url: "/api/admin/settings/registration.enabled",
      headers: {
        cookie: ownerCookie
      },
      payload: {
        value: { value: true }
      }
    });

    expect(settingResponse.statusCode).toBe(200);
    expect(settingResponse.json()).toMatchObject({
      setting: {
        key: "registration.enabled",
        value: { value: true },
        updatedByUserId: ownerUserId
      }
    });
  });

  it("rejects PATCH for unknown settings key with 400", async () => {
    const response = await server.inject({
      method: "PATCH",
      url: "/api/admin/settings/provider-policy",
      headers: {
        cookie: ownerCookie
      },
      payload: {
        value: { maxDataClass: "private" }
      }
    });

    expect(response.statusCode).toBe(400);
  });

  it("records audit events for bootstrap and settings actions", async () => {
    const auditResponse = await server.inject({
      method: "GET",
      url: "/api/admin/audit-events",
      headers: {
        cookie: ownerCookie
      }
    });
    const auditActions = auditResponse
      .json<ListAdminAuditEventsResponse>()
      .auditEvents.map((event) => event.action);

    expect(auditResponse.statusCode).toBe(200);
    expect(auditActions).toEqual(
      expect.arrayContaining(["bootstrap_owner_created", "instance_setting.upsert"])
    );
    expect(auditActions).not.toContain("workspace.create");
    expect(auditActions).not.toContain("resource_grant.upsert");
  });
});

describe("multi-user registration + lifecycle (Phase 2 Slice A)", () => {
  let appDb: Kysely<MossDatabase>;
  let authRuntime: MossAuthRuntime;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  async function signUp(opts: { name: string; email: string; password: string }) {
    return server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: opts
    });
  }

  const OWNER = { name: "Owner", email: "owner@example.com", password: "password12345" };
  const JOINER = { name: "Joiner", email: "joiner@example.com", password: "password12345" };

  async function signUpPendingJoiner() {
    await signUp(OWNER);
    const joinRes = await signUp(JOINER);
    expect(joinRes.statusCode).toBe(200);
    return joinRes;
  }

  // Active status requires requires_approval off; deactivate via the bootstrap
  // (superuser) connection below, which bypasses RLS; test-only.
  async function signUpDeactivatedJoiner() {
    await signUp(OWNER);
    await setInstanceSetting("registration.requires_approval", { value: false });
    const joinRes = await signUp(JOINER);
    expect(joinRes.statusCode).toBe(200);
    const joinerId = joinRes.json<{ user: { id: string } }>().user.id;
    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `UPDATE app.users SET status = 'deactivated', updated_at = now() WHERE id = $1`,
      [joinerId]
    );
    await client.end();
    return joinRes;
  }

  beforeEach(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    authRuntime = createMossAuthRuntime({ appDb, runner: new DataContextRunner(appDb) });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, authRuntime, boss, logger: false });
    await server.ready();
  });

  afterEach(async () => {
    await Promise.allSettled([
      server?.close(),
      authRuntime?.close(),
      appDb?.destroy(),
      boss?.stop({ graceful: false })
    ]);
  });

  it("rejects sign-up with 403 when registration.enabled is false (seeded directly)", async () => {
    await signUp({ name: "Admin", email: "admin@example.com", password: "password12345" });
    await setInstanceSetting("registration.enabled", { value: false });

    const blocked = await signUp({
      name: "Late",
      email: "late@example.com",
      password: "password12345"
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ code?: string }>().code).toBe("registration_disabled");
  });

  it("marks the first sign-up as bootstrap owner with active status", async () => {
    const signUpRes = await signUp({
      name: "First",
      email: "first@example.com",
      password: "password12345"
    });
    expect(signUpRes.statusCode).toBe(200);

    const cookie = cookieHeader(signUpRes.headers);
    const meRes = await server.inject({ method: "GET", url: "/api/me", headers: { cookie } });

    expect(meRes.statusCode).toBe(200);
    expect(meRes.json<MeResponse>().user).toMatchObject({
      isBootstrapOwner: true,
      status: "active"
    });
  });

  it("marks subsequent sign-up as pending when requires_approval is true", async () => {
    await signUp(OWNER);

    const joinRes = await signUp(JOINER);
    expect(joinRes.statusCode).toBe(200);
    const userId = joinRes.json<{ user: { id: string } }>().user.id;

    // Query via SECURITY DEFINER function (jarvis_auth_runtime USING(true)) so this
    // stays valid after Task 5 enforcement blocks pending users from /api/me.
    const rows = await sql<{
      is_bootstrap_owner: boolean;
      status: string;
    }>`SELECT is_bootstrap_owner, status FROM app.get_user_by_id(${userId}::uuid)`.execute(appDb);

    expect(rows.rows[0]).toMatchObject({ is_bootstrap_owner: false, status: "pending" });
  });

  it("blocks pending user from authenticated endpoint with 403 account_pending_approval", async () => {
    const joinRes = await signUpPendingJoiner();

    const meRes = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieHeader(joinRes.headers) }
    });

    expect(meRes.statusCode).toBe(403);
    expect(meRes.json<{ code?: string }>().code).toBe("account_pending_approval");
  });

  it("blocks deactivated user from authenticated endpoint with 403 account_deactivated", async () => {
    const joinRes = await signUpDeactivatedJoiner();

    const meRes = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieHeader(joinRes.headers) }
    });

    expect(meRes.statusCode).toBe(403);
    expect(meRes.json<{ code?: string }>().code).toBe("account_deactivated");
  });

  it("blocks pending user from /api/modules with the fixed 403 literal (#1528)", async () => {
    const joinRes = await signUpPendingJoiner();

    const modulesRes = await server.inject({
      method: "GET",
      url: "/api/modules",
      headers: { cookie: cookieHeader(joinRes.headers) }
    });

    expect(modulesRes.statusCode).toBe(403);
    expect(modulesRes.json<{ error?: string; code?: string }>()).toMatchObject({
      error: "Account is pending approval",
      code: "account_pending_approval"
    });
  });

  it("blocks deactivated user from /api/modules with the fixed 403 literal (#1528)", async () => {
    const joinRes = await signUpDeactivatedJoiner();

    const modulesRes = await server.inject({
      method: "GET",
      url: "/api/modules",
      headers: { cookie: cookieHeader(joinRes.headers) }
    });

    expect(modulesRes.statusCode).toBe(403);
    expect(modulesRes.json<{ error?: string; code?: string }>()).toMatchObject({
      error: "Account has been deactivated",
      code: "account_deactivated"
    });
  });

  it("keeps the generic scrubbed message for /api/modules with no session (#1528)", async () => {
    const modulesRes = await server.inject({
      method: "GET",
      url: "/api/modules"
    });

    expect(modulesRes.statusCode).toBe(401);
    expect(modulesRes.json<{ error?: string; code?: string }>()).toEqual({
      error: "Session is missing or expired"
    });
  });

  it("revokeUserSessions deletes all of a user's sessions", async () => {
    const member = await signUp({
      name: "Member",
      email: "member@example.com",
      password: "password12345"
    });
    const memberId = member.json<{ user: { id: string } }>().user.id;

    // Sign-up creates a session; first call should delete at least 1.
    const deleted = await authRuntime.revokeUserSessions(memberId);
    expect(deleted).toBeGreaterThan(0);

    // Second call finds nothing left — idempotent/safe.
    const remaining = await authRuntime.revokeUserSessions(memberId);
    expect(remaining).toBe(0);
  });

  it("admin approves a pending user, who can then access /api/me", async () => {
    const admin = await signUp({
      name: "Admin",
      email: "admin@example.com",
      password: "password12345"
    });
    const adminCookie = cookieHeader(admin.headers);
    const member = await signUp({
      name: "Member",
      email: "member@example.com",
      password: "password12345"
    });
    const memberId = member.json<{ user: { id: string } }>().user.id;
    const memberCookie = cookieHeader(member.headers);

    const approve = await server.inject({
      method: "POST",
      url: `/api/admin/users/${memberId}/approve`,
      headers: { cookie: adminCookie }
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json<{ user: { status: string } }>().user.status).toBe("active");

    const me = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: memberCookie }
    });
    expect(me.statusCode).toBe(200);
  });

  it("non-admin cannot call lifecycle routes (403)", async () => {
    const admin = await signUp({
      name: "Admin",
      email: "admin@example.com",
      password: "password12345"
    });
    const adminId = admin.json<{ user: { id: string } }>().user.id;
    const member = await signUp({
      name: "Member",
      email: "member@example.com",
      password: "password12345"
    });
    const memberId = member.json<{ user: { id: string } }>().user.id;
    const adminCookie = cookieHeader(admin.headers);
    // Approve member so they have an active session for subsequent calls.
    await server.inject({
      method: "POST",
      url: `/api/admin/users/${memberId}/approve`,
      headers: { cookie: adminCookie }
    });
    // Re-sign-in as member to get a fresh active session cookie.
    const memberSignIn = await server.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: { email: "member@example.com", password: "password12345" }
    });
    const memberCookie = cookieHeader(memberSignIn.headers);
    const res = await server.inject({
      method: "POST",
      url: `/api/admin/users/${adminId}/demote`,
      headers: { cookie: memberCookie }
    });
    expect(res.statusCode).toBe(403);
  });

  it("repository blocks demoting the last active admin", async () => {
    // Owner is bootstrap_owner; member is promoted to admin via bootstrap, then
    // owner is deactivated via bootstrap — leaving member as the last active admin.
    const ownerRes = await signUp({
      name: "Owner",
      email: "owner@example.com",
      password: "password12345"
    });
    const ownerId = ownerRes.json<{ user: { id: string } }>().user.id;

    await setInstanceSetting("registration.requires_approval", { value: false });
    const memberRes = await signUp({
      name: "Member",
      email: "member@example.com",
      password: "password12345"
    });
    const memberId = memberRes.json<{ user: { id: string } }>().user.id;

    // Use bootstrap (superuser) to promote member to admin and deactivate owner.
    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `UPDATE app.users SET is_instance_admin = true, updated_at = now() WHERE id = $1`,
      [memberId]
    );
    await client.query(
      `UPDATE app.users SET status = 'deactivated', updated_at = now() WHERE id = $1`,
      [ownerId]
    );
    await client.end();

    const repo = new SettingsRepository();
    const dataCtx = new DataContextRunner(appDb);
    await expect(
      dataCtx.withDataContext({ actorUserId: memberId, requestId: "r1" }, (scopedDb) =>
        repo.setUserAdmin(scopedDb, {
          targetUserId: memberId,
          isInstanceAdmin: false,
          actorUserId: memberId,
          requestId: "r1"
        })
      )
    ).rejects.toThrow(/last.*admin/i);
  });

  it("deleteUserData refuses to remove the last active admin (#94 TOCTOU re-check)", async () => {
    // The route's pre-check commits and releases its advisory lock before
    // deleteUserData runs on a fresh bootstrap connection, so deleteUserData
    // must re-assert the last-admin guard inside its own transaction. Drive it
    // directly (the sequential route path is caught earlier by the pre-check;
    // this guard only matters when a concurrent removal wins the race).
    const ownerRes = await signUp({
      name: "Owner",
      email: "owner@example.com",
      password: "password12345"
    });
    const ownerId = ownerRes.json<{ user: { id: string } }>().user.id;

    await setInstanceSetting("registration.requires_approval", { value: false });
    const memberRes = await signUp({
      name: "Member",
      email: "member@example.com",
      password: "password12345"
    });
    const memberId = memberRes.json<{ user: { id: string } }>().user.id;

    // Promote member to admin and deactivate owner → member is the sole active admin.
    const seed = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await seed.connect();
    await seed.query(
      `UPDATE app.users SET is_instance_admin = true, updated_at = now() WHERE id = $1`,
      [memberId]
    );
    await seed.query(
      `UPDATE app.users SET status = 'deactivated', updated_at = now() WHERE id = $1`,
      [ownerId]
    );
    await seed.end();

    await expect(
      deleteUserData({
        userId: memberId,
        confirmUserId: memberId,
        actorUserId: memberId,
        requestId: "del-last-admin",
        bootstrapConnectionString: connectionStrings.bootstrap,
        dryRun: false
      })
    ).rejects.toBeInstanceOf(LastActiveAdminError);

    // The transaction rolled back: the user row must still exist.
    const verify = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await verify.connect();
    const row = await verify.query(`SELECT id FROM app.users WHERE id = $1`, [memberId]);
    await verify.end();
    expect(row.rows.length).toBe(1);
  });

  it("setUserAdmin promote succeeds under withDataContext (0055 trigger passes)", async () => {
    // First sign-up is the bootstrap owner + active admin (the actor that performs the promote).
    const actorRes = await signUp({
      name: "Promote Actor",
      email: "promote-actor@example.com",
      password: "password12345"
    });
    const actorId = actorRes.json<{ user: { id: string } }>().user.id;

    // Disable approval so the second sign-up lands active, then create the non-admin target.
    await setInstanceSetting("registration.requires_approval", { value: false });
    const targetRes = await signUp({
      name: "Promote Target",
      email: "promote-target@example.com",
      password: "password12345"
    });
    const targetId = targetRes.json<{ user: { id: string } }>().user.id;

    // Ensure target is an active non-admin (actor is already an active admin as bootstrap owner).
    const seed = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await seed.connect();
    await seed.query(
      `UPDATE app.users SET is_instance_admin = false, status = 'active', updated_at = now() WHERE id = $1`,
      [targetId]
    );
    await seed.end();

    const repo = new SettingsRepository();
    const dataCtx = new DataContextRunner(appDb);
    const promoted = await dataCtx.withDataContext(
      { actorUserId: actorId, requestId: "promote-1" },
      (scopedDb) =>
        repo.setUserAdmin(scopedDb, {
          targetUserId: targetId,
          isInstanceAdmin: true,
          actorUserId: actorId,
          requestId: "promote-1"
        })
    );

    // The UPDATE must have passed the 0055 trigger under the GUC set by withDataContext.
    expect(promoted.is_instance_admin).toBe(true);
    expect(promoted.id).toBe(targetId);
    // Confirm the row was actually persisted (defends against a silent GUC fail-open regression).
    const verify = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await verify.connect();
    const row = await verify.query(`SELECT is_instance_admin FROM app.users WHERE id = $1`, [
      targetId
    ]);
    await verify.end();
    expect(row.rows[0]?.is_instance_admin).toBe(true);
  });

  it("setUserAdmin self-escalation rejected by 0055 trigger when actor is non-admin (deny path)", async () => {
    // First sign-up becomes the bootstrap owner and STAYS as the active admin.
    // This ensures app.any_admin_exists() returns TRUE so the trigger's bootstrap-recovery
    // exemption (which allows self-promotion when no admin exists) does NOT apply.
    await signUp({
      name: "Deny Path Owner",
      email: "deny-path-owner@example.com",
      password: "password12345"
    });
    // bootstrap owner is automatically active + admin — no seed needed.

    // Disable approval so the second sign-up lands as active.
    await setInstanceSetting("registration.requires_approval", { value: false });
    const nonAdminRes = await signUp({
      name: "Non-Admin Escalator",
      email: "deny-path-escalator@example.com",
      password: "password12345"
    });
    const nonAdminId = nonAdminRes.json<{ user: { id: string } }>().user.id;

    // Confirm the second user is active and non-admin.
    const seed = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await seed.connect();
    await seed.query(
      `UPDATE app.users SET is_instance_admin = false, status = 'active', updated_at = now() WHERE id = $1`,
      [nonAdminId]
    );
    await seed.end();

    const repo = new SettingsRepository();
    const dataCtx = new DataContextRunner(appDb);

    // Non-admin tries to promote themselves — 0055 trigger fires (any_admin_exists = TRUE)
    // and rejects with 42501. If GUC regresses to NULL, trigger fails open → promotion succeeds
    // → this assertion goes RED, catching the regression.
    await expect(
      dataCtx.withDataContext({ actorUserId: nonAdminId, requestId: "deny-1" }, (scopedDb) =>
        repo.setUserAdmin(scopedDb, {
          targetUserId: nonAdminId,
          isInstanceAdmin: true,
          actorUserId: nonAdminId,
          requestId: "deny-1"
        })
      )
    ).rejects.toThrow(/42501|permission denied/i);
  });

  it("POST /api/admin/users/:id/revoke-sessions revokes target sessions, count only, admin survives", async () => {
    const admin = await signUp({
      name: "Admin",
      email: "admin-revoke@example.com",
      password: "password12345"
    });
    const adminCookie = cookieHeader(admin.headers);

    // Disable approval so the member becomes active and gets a usable session.
    await setInstanceSetting("registration.requires_approval", { value: false });

    const member = await signUp({
      name: "Member",
      email: "member-revoke@example.com",
      password: "password12345"
    });
    const memberId = member.json<{ user: { id: string } }>().user.id;
    const memberCookie = cookieHeader(member.headers);

    // Sanity: the member's session is live before the revoke.
    const beforeRevoke = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: memberCookie }
    });
    expect(beforeRevoke.statusCode).toBe(200);

    const response = await server.inject({
      method: "POST",
      url: `/api/admin/users/${memberId}/revoke-sessions`,
      headers: { cookie: adminCookie }
    });

    // (1) Response shape: count only, no session identifiers.
    expect(response.statusCode).toBe(200);
    const body = response.json<{ success: boolean; count: number }>();
    expect(body.success).toBe(true);
    expect(typeof body.count).toBe("number");
    expect(body.count).toBeGreaterThanOrEqual(1); // sign-up created at least 1 session
    const raw = response.body;
    expect(raw).not.toContain("session_id");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("user_id");
    expect(raw).not.toContain("better_auth");

    // (2) Target sessions are actually dead — the member's cookie now fails auth.
    const afterRevoke = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: memberCookie }
    });
    expect(afterRevoke.statusCode).toBe(401);

    // (3) The admin's OWN session survives — revoke is scoped to the target user only.
    const adminStillValid = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: adminCookie }
    });
    expect(adminStillValid.statusCode).toBe(200);

    // (4) DB confirms zero session rows remain for the target user. Use the bootstrap
    // connection (superuser, bypasses RLS) — app_runtime's FORCE RLS would hide other
    // users' session rows from a plain appDb query and make this check meaningless.
    const seed = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await seed.connect();
    try {
      const memberRows = await seed.query(
        "SELECT count(*)::int AS count FROM app.better_auth_sessions WHERE user_id = $1",
        [memberId]
      );
      expect(memberRows.rows[0]?.count).toBe(0);
    } finally {
      await seed.end();
    }
  });
});

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];

  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function readOriginalAuthEnv<const TKeys extends readonly string[]>(
  keys: TKeys
): Record<TKeys[number], string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
    TKeys[number],
    string | undefined
  >;
}

function restoreAuthEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}
