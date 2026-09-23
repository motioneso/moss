import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import pg from "pg";

import { createMossAuthRuntime, type MossAuthRuntime } from "@moss/auth";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { sql, type Kysely } from "kysely";
import { createApiServer } from "../../apps/api/src/server.js";
import { SettingsRepository } from "../../packages/settings/src/repository.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

describe("multi-user isolation", () => {
  let appDb: Kysely<MossDatabase>;
  let authRuntime: MossAuthRuntime;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  async function signUp(name: string, email: string) {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "password12345" }
    });
    return {
      id: res.json<{ user: { id: string } }>().user.id,
      cookie: cookieHeader(res.headers)
    };
  }

  async function signIn(email: string) {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: { email, password: "password12345" }
    });
    return cookieHeader(res.headers);
  }

  async function disableApproval() {
    await setInstanceSetting("registration.requires_approval", { value: false });
  }

  async function seedAsBootstrap(text: string, params: unknown[] = []): Promise<string> {
    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const res = await client.query(text, params);
      return (res.rows[0]?.id as string) ?? "";
    } finally {
      await client.end();
    }
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

  it("a member cannot read another member's private task", async () => {
    const admin = await signUp("Admin", "admin@example.com");
    void admin;
    await disableApproval();

    const alice = await signUp("Alice", "alice@example.com");
    const bob = await signUp("Bob", "bob@example.com");

    const created = await server.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "content-type": "application/json", cookie: alice.cookie },
      payload: { title: "Alice private task" }
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json<{ task: { id: string } }>().task.id;

    const bobRead = await server.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: bob.cookie }
    });
    expect(bobRead.statusCode).toBe(404);
  });

  it("an instance admin CANNOT read a member's private task (no admin bypass of RLS)", async () => {
    const admin = await signUp("Admin", "admin@example.com");
    await disableApproval();
    const alice = await signUp("Alice", "alice@example.com");

    const created = await server.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "content-type": "application/json", cookie: alice.cookie },
      payload: { title: "Alice private task" }
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json<{ task: { id: string } }>().task.id;

    const adminRead = await server.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: admin.cookie }
    });
    expect(adminRead.statusCode).toBe(404);

    // Grant self read access via resource-grants — the admin cannot bootstrap their own access.
    await server.inject({
      method: "POST",
      url: "/api/admin/resource-grants",
      headers: { "content-type": "application/json", cookie: admin.cookie },
      payload: {
        resourceType: "task",
        resourceId: taskId,
        granteeUserId: admin.id,
        grantLevel: "view"
      }
    });

    const adminReadAfterGrant = await server.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: admin.cookie }
    });
    // A resource grant from the admin does NOT grant access to Alice's private task —
    // only Alice can share her own data.
    expect(adminReadAfterGrant.statusCode).toBe(404);
  });

  it("app_runtime cannot read another user's auth_accounts rows (FORCE RLS isolation)", async () => {
    await disableApproval();
    const alice = await signUp("Alice", "alice@example.com");

    // appDb runs as jarvis_app_runtime. Migration 0045 revoked its SELECT on auth_accounts +
    // better_auth_sessions entirely (FORCE RLS tables). A direct query must throw permission denied.
    await expect(
      appDb.selectFrom("app.auth_accounts").selectAll().where("user_id", "=", alice.id).execute()
    ).rejects.toThrow();
  });

  it("lifecycle: pending blocked → approved active → deactivated blocked + sessions revoked → reactivated active", async () => {
    const admin = await signUp("Admin", "admin@example.com");
    const member = await signUp("Member", "member@example.com"); // pending (approval on by default)

    // Pending → 403.
    expect(
      (await server.inject({ method: "GET", url: "/api/me", headers: { cookie: member.cookie } }))
        .statusCode
    ).toBe(403);

    // Approve → active.
    const approve = await server.inject({
      method: "POST",
      url: `/api/admin/users/${member.id}/approve`,
      headers: { cookie: admin.cookie }
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json<{ user: { status: string } }>().user.status).toBe("active");

    // Fresh sign-in to get an active session.
    const activeCookie = await signIn("member@example.com");
    expect(
      (await server.inject({ method: "GET", url: "/api/me", headers: { cookie: activeCookie } }))
        .statusCode
    ).toBe(200);

    // Deactivate → sessions revoked + blocked.
    const deactivate = await server.inject({
      method: "POST",
      url: `/api/admin/users/${member.id}/deactivate`,
      headers: { cookie: admin.cookie }
    });
    expect(deactivate.statusCode).toBe(200);
    // Route revokes sessions; a second call should return 0.
    const remaining = await authRuntime.revokeUserSessions(member.id);
    expect(remaining).toBe(0);
    // Sessions are gone — old cookie returns 401 (unauthenticated), not 403.
    expect(
      (await server.inject({ method: "GET", url: "/api/me", headers: { cookie: activeCookie } }))
        .statusCode
    ).toBe(401);

    // Reactivate → active again.
    const reactivate = await server.inject({
      method: "POST",
      url: `/api/admin/users/${member.id}/reactivate`,
      headers: { cookie: admin.cookie }
    });
    expect(reactivate.statusCode).toBe(200);
    const freshCookie = await signIn("member@example.com");
    expect(
      (await server.inject({ method: "GET", url: "/api/me", headers: { cookie: freshCookie } }))
        .statusCode
    ).toBe(200);
  });

  it("guardrails: cannot demote or deactivate the last admin or the bootstrap owner", async () => {
    const admin = await signUp("Admin", "admin@example.com"); // bootstrap owner + only admin

    // Demote self (only admin) → 409.
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/admin/users/${admin.id}/demote`,
          headers: { cookie: admin.cookie }
        })
      ).statusCode
    ).toBe(409);

    // Deactivate self → 409 (bootstrap owner check fires before self-lockout check).
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/admin/users/${admin.id}/deactivate`,
          headers: { cookie: admin.cookie }
        })
      ).statusCode
    ).toBe(409);

    // Seed a second admin via bootstrap (superuser), then deactivate original admin via bootstrap —
    // now second admin is the last active admin. Demoting the last active admin should still 409.
    await disableApproval();
    const second = await signUp("Second", "second@example.com");

    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `UPDATE app.users SET is_instance_admin = true, updated_at = now() WHERE id = $1`,
      [second.id]
    );
    await client.query(
      `UPDATE app.users SET status = 'deactivated', updated_at = now() WHERE id = $1`,
      [admin.id]
    );
    await client.end();

    const secondCookie = await signIn("second@example.com");
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/admin/users/${second.id}/demote`,
          headers: { cookie: secondCookie }
        })
      ).statusCode
    ).toBe(409);
  });

  it("DELETE bootstrap owner by a second admin is rejected (409) and account still exists", async () => {
    const admin = await signUp("Admin", "admin@example.com"); // bootstrap owner
    await disableApproval();
    const second = await signUp("Second", "second@example.com");

    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    await client.query(
      `UPDATE app.users SET is_instance_admin = true, updated_at = now() WHERE id = $1`,
      [second.id]
    );
    await client.end();

    const secondCookie = await signIn("second@example.com");
    const del = await server.inject({
      method: "DELETE",
      url: `/api/admin/users/${admin.id}`,
      headers: { cookie: secondCookie }
    });
    expect(del.statusCode).toBe(409);

    // Bootstrap owner account must still exist in the users list.
    const listRes = await server.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: secondCookie }
    });
    expect(listRes.statusCode).toBe(200);
    const ids = listRes.json<{ users: { id: string }[] }>().users.map((u) => u.id);
    expect(ids).toContain(admin.id);
  });

  it("DELETE last active admin is rejected (409 from assertNotLastActiveAdmin)", async () => {
    const admin = await signUp("Admin", "admin@example.com"); // bootstrap owner + only admin
    await disableApproval();
    const second = await signUp("Second", "second@example.com");

    const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    // Promote second to admin and strip bootstrap owner's admin flag so second is
    // the SOLE active admin. This is the state the assertNotLastActiveAdmin guard
    // must protect — it cannot be triggered via HTTP (the caller must be an active
    // admin, which means the target has at least one peer), so verify at the repository
    // layer directly against the real database.
    await client.query(
      `UPDATE app.users SET is_instance_admin = true, updated_at = now() WHERE id = $1`,
      [second.id]
    );
    await client.query(
      `UPDATE app.users SET is_instance_admin = false, updated_at = now() WHERE id = $1`,
      [admin.id]
    );
    await client.end();

    // second is now the sole active admin. The repository guard must throw 409.
    const repo = new SettingsRepository();
    const dataCtx = new DataContextRunner(appDb);
    await expect(
      dataCtx.withDataContext({ actorUserId: second.id, requestId: "t1" }, (scopedDb) =>
        repo.assertNotLastActiveAdmin(scopedDb, second.id)
      )
    ).rejects.toMatchObject({ statusCode: 409 });

    // Sanity: with two active admins, the guard must NOT fire.
    const client2 = new pg.Client({ connectionString: connectionStrings.bootstrap });
    await client2.connect();
    await client2.query(
      `UPDATE app.users SET is_instance_admin = true, updated_at = now() WHERE id = $1`,
      [admin.id]
    );
    await client2.end();
    await expect(
      dataCtx.withDataContext({ actorUserId: second.id, requestId: "t2" }, (scopedDb) =>
        repo.assertNotLastActiveAdmin(scopedDb, second.id)
      )
    ).resolves.toBeUndefined();
  });

  it("a member's onboarding state is invisible to the founder/admin and to another member", async () => {
    const admin = await signUp("Admin", "iso-admin@example.com"); // bootstrap owner + admin
    await disableApproval();
    const alice = await signUp("Alice", "iso-alice@example.com");
    const bob = await signUp("Bob", "iso-bob@example.com");

    // Alice completes her member onboarding (stamps her own app.member_onboarding row).
    const complete = await server.inject({
      method: "POST",
      url: "/api/onboarding/complete",
      headers: { cookie: alice.cookie }
    });
    expect(complete.statusCode).toBe(200);
    expect((complete.json() as { completed: boolean }).completed).toBe(true);

    // Alice sees her own completion.
    const aliceStatus = await server.inject({
      method: "GET",
      url: "/api/onboarding/status",
      headers: { cookie: alice.cookie }
    });
    expect((aliceStatus.json() as { completed: boolean }).completed).toBe(true);

    // Bob's own status is independent (still false) — per-user, not instance-global.
    const bobStatus = await server.inject({
      method: "GET",
      url: "/api/onboarding/status",
      headers: { cookie: bob.cookie }
    });
    expect((bobStatus.json() as { role: string; completed: boolean }).role).toBe("member");
    expect((bobStatus.json() as { completed: boolean }).completed).toBe(false);

    // Admin user list NEVER exposes onboarding state (it doesn't ride the user row at all).
    const list = await server.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { cookie: admin.cookie }
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toMatch(/onboarding/i);

    // CRITICAL no-admin-bypass backstop: under the ADMIN's GUC, a direct read of
    // app.member_onboarding for Alice's id returns NO row — the table has no admin SELECT
    // policy (unlike app.users after 0052), so Alice's stamped state is invisible to the admin.
    const dataCtx = new DataContextRunner(appDb);
    const adminSeesAlice = await dataCtx.withDataContext(
      { actorUserId: admin.id, requestId: "iso-1a" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.member_onboarding")
          .select("user_id")
          .where("user_id", "=", alice.id)
          .execute()
    );
    expect(adminSeesAlice).toEqual([]);

    // And under Bob's GUC, Alice's row is likewise invisible.
    const bobSeesAlice = await dataCtx.withDataContext(
      { actorUserId: bob.id, requestId: "iso-1b" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.member_onboarding")
          .select("user_id")
          .where("user_id", "=", alice.id)
          .execute()
    );
    expect(bobSeesAlice).toEqual([]);

    // SIDE-CHANNEL backstop: member completion must ALSO stay out of the admin audit log.
    // app.admin_audit_events SELECT is admin-wide (0059); an "onboarding.member_complete" row
    // keyed to Alice would re-leak her private completion fact + timestamp to the admin even
    // though the table read above is blocked. Assert the admin sees no member-onboarding action.
    const adminAudit = await server.inject({
      method: "GET",
      url: "/api/admin/audit-events",
      headers: { cookie: admin.cookie }
    });
    expect(adminAudit.statusCode).toBe(200);
    const auditActions = (
      adminAudit.json() as { auditEvents: { action: string }[] }
    ).auditEvents.map((e) => e.action);
    expect(auditActions).not.toContain("onboarding.member_complete");
    expect(JSON.stringify(adminAudit.json())).not.toMatch(/member.*onboard|onboard.*member/i);
  });

  it("lifecycle stitch: completing onboarding sets only the actor's own row", async () => {
    await disableApproval();
    const admin = await signUp("Admin", "iso2-admin@example.com");
    void admin;
    const a = await signUp("MemberA", "iso2-a@example.com");
    const b = await signUp("MemberB", "iso2-b@example.com");

    await server.inject({
      method: "POST",
      url: "/api/onboarding/complete",
      headers: { cookie: a.cookie }
    });

    const dataCtx = new DataContextRunner(appDb);
    const repo = new SettingsRepository();
    const aState = await dataCtx.withDataContext(
      { actorUserId: a.id, requestId: "iso-2a" },
      (scopedDb) => repo.getMemberOnboardingState(scopedDb)
    );
    const bState = await dataCtx.withDataContext(
      { actorUserId: b.id, requestId: "iso-2b" },
      (scopedDb) => repo.getMemberOnboardingState(scopedDb)
    );
    expect(aState.completedAt).toBeInstanceOf(Date); // A read under A's GUC → set
    expect(bState.completedAt).toBeNull(); // B read under B's GUC → still null
  });

  it("per-user connectors: a SEEDED Alice-owned account is invisible to member B and the admin (and no secrets leak)", async () => {
    const admin = await signUp("Admin", "iso3-admin@example.com");
    await disableApproval();
    const alice = await signUp("Alice", "iso3-alice@example.com");
    const bob = await signUp("Bob", "iso3-bob@example.com");

    // Seed an Alice-owned connector account directly (cross-RLS bootstrap write). Schema:
    // packages/connectors/sql/0009_connectors_module.sql — app.connector_accounts(id [no default],
    // provider_id [FK→connector_definitions.provider_id], owner_user_id, scopes, status,
    // encrypted_secret jsonb [must be a JSON object]). The connectors module seeds
    // 'google-calendar' at migrate time; reference an existing definition via subquery for
    // robustness. owner_user_id = alice.id is the load-bearing isolation column.
    const aliceAccountId = await seedAsBootstrap(
      `INSERT INTO app.connector_accounts (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
         SELECT gen_random_uuid(), d.provider_id, $1, ARRAY[]::text[], 'active', '{}'::jsonb
           FROM app.connector_definitions d
          ORDER BY d.provider_id LIMIT 1
         RETURNING id`,
      [alice.id]
    );
    expect(aliceAccountId).not.toBe("");

    // Bob's app_runtime read cannot see Alice's seeded account.
    const dataCtx = new DataContextRunner(appDb);
    const bobSees = await dataCtx.withDataContext(
      { actorUserId: bob.id, requestId: "iso-3a" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.connector_accounts")
          .select("id")
          .where("id", "=", aliceAccountId)
          .execute()
    );
    expect(bobSees).toEqual([]);
    const adminSees = await dataCtx.withDataContext(
      { actorUserId: admin.id, requestId: "iso-3b" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.connector_accounts")
          .select("id")
          .where("id", "=", aliceAccountId)
          .execute()
    );
    expect(adminSees).toEqual([]);

    // The public endpoint never carries secret-shaped fields for any actor.
    const adminAccounts = await server.inject({
      method: "GET",
      url: "/api/connectors/accounts",
      headers: { cookie: admin.cookie }
    });
    expect(adminAccounts.statusCode).toBe(200);
    expect(JSON.stringify(adminAccounts.json())).not.toMatch(
      /encrypted_secret|access_token|refresh_token|client_secret/i
    );
  });

  it("per-user AI keys: a SEEDED Alice-owned provider config is invisible to member B and the admin (and no secrets leak)", async () => {
    const admin = await signUp("Admin", "iso4-admin@example.com");
    await disableApproval();
    const alice = await signUp("Alice", "iso4-alice@example.com");
    const bob = await signUp("Bob", "iso4-bob@example.com");

    // Seed an Alice-owned AI provider config (cross-RLS bootstrap write). Schema:
    // packages/ai/sql/0013_ai_module.sql — app.ai_provider_configs(id [no default], owner_user_id,
    // provider_kind [enum app.ai_provider_kind: 'openai-compatible'|'anthropic'|'google'|'ollama'|
    // 'custom'|'system-one'], display_name [non-blank], status, encrypted_credential jsonb [must be an object]).
    // owner_user_id = alice.id is load-bearing.
    const aliceConfigId = await seedAsBootstrap(
      `INSERT INTO app.ai_provider_configs (id, owner_user_id, provider_kind, display_name, status, encrypted_credential)
         VALUES (gen_random_uuid(), $1, 'anthropic', 'Alice key', 'active', '{}'::jsonb)
         RETURNING id`,
      [alice.id]
    );
    expect(aliceConfigId).not.toBe("");

    const dataCtx = new DataContextRunner(appDb);
    const bobSees = await dataCtx.withDataContext(
      { actorUserId: bob.id, requestId: "iso-4a" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.ai_provider_configs")
          .select("id")
          .where("id", "=", aliceConfigId)
          .execute()
    );
    expect(bobSees).toEqual([]);
    const adminSees = await dataCtx.withDataContext(
      { actorUserId: admin.id, requestId: "iso-4b" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.ai_provider_configs")
          .select("id")
          .where("id", "=", aliceConfigId)
          .execute()
    );
    expect(adminSees).toEqual([]);

    const adminProviders = await server.inject({
      method: "GET",
      url: "/api/ai/providers",
      headers: { cookie: admin.cookie }
    });
    expect(adminProviders.statusCode).toBe(200);
    expect(JSON.stringify(adminProviders.json())).not.toMatch(
      /encrypted_credential|api[_-]?key|secret/i
    );
  });

  it("per-user chat: a SEEDED Alice-owned thread is invisible to member B and the admin", async () => {
    const admin = await signUp("Admin", "iso5-admin@example.com");
    await disableApproval();
    const alice = await signUp("Alice", "iso5-alice@example.com");
    const bob = await signUp("Bob", "iso5-bob@example.com");

    // Seed an Alice-owned chat thread (cross-RLS bootstrap write). Schema:
    // packages/chat/sql/0014_chat_module.sql — app.chat_threads(id [no default], owner_user_id,
    // title [non-blank]). owner_user_id = alice.id is load-bearing.
    const aliceThreadId = await seedAsBootstrap(
      `INSERT INTO app.chat_threads (id, owner_user_id, title)
         VALUES (gen_random_uuid(), $1, 'Alice private thread')
         RETURNING id`,
      [alice.id]
    );
    expect(aliceThreadId).not.toBe("");

    const dataCtx = new DataContextRunner(appDb);
    const bobSees = await dataCtx.withDataContext(
      { actorUserId: bob.id, requestId: "iso-5a" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.chat_threads")
          .select("id")
          .where("id", "=", aliceThreadId)
          .execute()
    );
    expect(bobSees).toEqual([]);
    const adminSees = await dataCtx.withDataContext(
      { actorUserId: admin.id, requestId: "iso-5b" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.chat_threads")
          .select("id")
          .where("id", "=", aliceThreadId)
          .execute()
    );
    expect(adminSees).toEqual([]);
  });

  it("per-user chat skill: a SEEDED Alice-owned skill cannot be selected, updated, toggled, or deleted by member B or the admin", async () => {
    const admin = await signUp("Admin", "iso5c-admin@example.com");
    await disableApproval();
    const alice = await signUp("Alice", "iso5c-alice@example.com");
    const bob = await signUp("Bob", "iso5c-bob@example.com");

    // Seed an Alice-owned skill (cross-RLS bootstrap write). Schema:
    // packages/chat/sql/0149_chat_skills.sql — app.chat_skills(id default, owner_user_id, name,
    // description, frontmatter, body, enabled, source). owner_user_id = alice.id is load-bearing.
    const aliceSkillId = await seedAsBootstrap(
      `INSERT INTO app.chat_skills (owner_user_id, name, body, source)
         VALUES ($1, 'Alice private skill', 'do the thing', 'authored')
         RETURNING id`,
      [alice.id]
    );
    expect(aliceSkillId).not.toBe("");

    const dataCtx = new DataContextRunner(appDb);

    for (const [label, actorId] of [
      ["bob", bob.id],
      ["admin", admin.id]
    ] as const) {
      const sees = await dataCtx.withDataContext(
        { actorUserId: actorId, requestId: `iso-5c-select-${label}` },
        (scopedDb) =>
          scopedDb.db
            .selectFrom("app.chat_skills")
            .select("id")
            .where("id", "=", aliceSkillId)
            .execute()
      );
      expect(sees).toEqual([]);

      const updateResult = await dataCtx.withDataContext(
        { actorUserId: actorId, requestId: `iso-5c-update-${label}` },
        (scopedDb) =>
          scopedDb.db
            .updateTable("app.chat_skills")
            .set({ enabled: false })
            .where("id", "=", aliceSkillId)
            .executeTakeFirst()
      );
      expect(Number(updateResult.numUpdatedRows)).toBe(0);

      const deleteResult = await dataCtx.withDataContext(
        { actorUserId: actorId, requestId: `iso-5c-delete-${label}` },
        (scopedDb) =>
          scopedDb.db
            .deleteFrom("app.chat_skills")
            .where("id", "=", aliceSkillId)
            .executeTakeFirst()
      );
      expect(Number(deleteResult.numDeletedRows)).toBe(0);
    }

    const aliceSees = await dataCtx.withDataContext(
      { actorUserId: alice.id, requestId: "iso-5c-select-alice" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.chat_skills")
          .select("id")
          .where("id", "=", aliceSkillId)
          .execute()
    );
    expect(aliceSees).toEqual([{ id: aliceSkillId }]);
  });

  it("per-user memory: SEEDED Alice-owned memory_chunks AND chat_memory_facts are invisible to member B and the admin", async () => {
    const admin = await signUp("Admin", "iso6-admin@example.com");
    await disableApproval();
    const alice = await signUp("Alice", "iso6-alice@example.com");
    const bob = await signUp("Bob", "iso6-bob@example.com");

    // Seed BOTH memory tables for Alice (two separate RLS-protected surfaces).
    // app.memory_chunks (packages/memory/sql/0030_memory_index.sql): id [DEFAULT gen_random_uuid()],
    // owner_user_id, source_kind ['vault'|'connector'], source_path, line_start>=0,
    // line_end>=line_start, content_hash, text [NOT NULL]; embedding nullable (leave NULL).
    // app.chat_memory_facts (packages/memory/sql/0041_memory_facts.sql): id [DEFAULT
    // gen_random_uuid()], owner_user_id, category ['preference'|'fact'|'profile'|'goal'], content.
    // owner_user_id = alice.id is load-bearing in each.
    const aliceChunkId = await seedAsBootstrap(
      `INSERT INTO app.memory_chunks
           (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
         VALUES ($1, 'vault', 'iso6/alice.md', 0, 1, 'iso6hash', 'alice secret chunk')
         RETURNING id`,
      [alice.id]
    );
    const aliceFactId = await seedAsBootstrap(
      `INSERT INTO app.chat_memory_facts (owner_user_id, category, content)
         VALUES ($1, 'fact', 'alice secret fact')
         RETURNING id`,
      [alice.id]
    );
    expect(aliceChunkId).not.toBe("");
    expect(aliceFactId).not.toBe("");

    const dataCtx = new DataContextRunner(appDb);

    // memory_chunks is registered on MossDatabase → typed select.
    for (const actor of [bob.id, admin.id]) {
      const seen = await dataCtx.withDataContext(
        { actorUserId: actor, requestId: `iso-6-chunks-${actor}` },
        (scopedDb) =>
          scopedDb.db
            .selectFrom("app.memory_chunks")
            .select("id")
            .where("id", "=", aliceChunkId)
            .execute()
      );
      expect(seen).toEqual([]);
    }

    // chat_memory_facts is NOT in MossDatabase → assert via raw SQL under each actor's GUC.
    for (const actor of [bob.id, admin.id]) {
      const seen = await dataCtx.withDataContext(
        { actorUserId: actor, requestId: `iso-6-facts-${actor}` },
        (scopedDb) =>
          sql<{
            id: string;
          }>`SELECT id FROM app.chat_memory_facts WHERE id = ${aliceFactId}`.execute(scopedDb.db)
      );
      expect(seen.rows).toEqual([]);
    }
  });

  // DEFERRED (spec §Open risks "Wellness surface assumption"): there is no wellness module/
  // owner-scoped wellness table in the codebase as of this slice, so the per-user wellness
  // isolation case is intentionally NOT asserted here. When a wellness module ships with real
  // owner-scoped tables, add a case mirroring the per-user memory test above against those
  // tables. Do NOT assert against a non-existent table.
  it.skip("per-user wellness: member B cannot read member A's wellness data (deferred — no wellness module yet)", () => {
    // Intentionally skipped; see comment above.
  });

  // Per-user vault: vault I/O goes through VaultContext (filesystem), not a DB table, and is
  // owner-scoped by path. The vault.test.ts suite already proves VaultContext containment;
  // cross-user vault isolation is covered there. (Spec §Testing lists vault among the surfaces;
  // it is gated by the existing vault suite rather than duplicated here.)
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
