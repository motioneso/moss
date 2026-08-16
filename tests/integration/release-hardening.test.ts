import { beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import pg from "pg";

import { AuthSessionResolver, createDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { createApiServer } from "../../apps/api/src/server.js";
import { createBackupPlan } from "../../scripts/backup-database.js";
import { auditReleaseHardening } from "../../scripts/audit-release-hardening.js";
import { deleteUserData } from "../../scripts/delete-user-data.js";
import { createComposeSmokePlan } from "../../scripts/smoke-compose.js";
import { exportUserData } from "../../scripts/export-user-data.js";
import { createRestorePlan } from "../../scripts/restore-database.js";
import { connectionStrings, ids, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const releaseIds = {
  userATask: "81000000-0000-4000-8000-000000000001",
  userBTask: "81000000-0000-4000-8000-000000000002",
  connectorAccount: "83000000-0000-4000-8000-000000000001",
  calendarEvent: "84000000-0000-4000-8000-000000000001",
  emailMessage: "85000000-0000-4000-8000-000000000001",
  aiProvider: "86000000-0000-4000-8000-000000000001",
  aiModel: "87000000-0000-4000-8000-000000000001"
} as const;

const staleSplitImages = ["jarv1s-api", "jarv1s-web", "moss-api", "moss-web"] as const;

describe("M7 release hardening lifecycle scripts", () => {
  beforeEach(async () => {
    await resetEmptyFoundationDatabase();
    await seedLifecycleData();
  });

  it("exports user-owned data through the app role without secret material or shared private rows", async () => {
    const userExport = await exportUserData({
      appConnectionString: connectionStrings.app,
      exportedAt: new Date("2026-06-06T12:00:00.000Z"),
      userId: ids.userA
    });
    const exportedJson = JSON.stringify(userExport);

    expect(userExport).toMatchObject({
      exportedAt: "2026-06-06T12:00:00.000Z",
      userId: ids.userA
    });
    expect(userExport.tables.users).toEqual([
      expect.objectContaining({
        email: "user-a@example.test",
        id: ids.userA
      })
    ]);
    expect(userExport.tables.tasks).toEqual([
      expect.objectContaining({
        id: releaseIds.userATask,
        title: "User A exportable task"
      })
    ]);
    expect(userExport.tables.connectorAccounts).toEqual([
      expect.objectContaining({
        hasSecret: true,
        id: releaseIds.connectorAccount,
        providerId: "google-calendar"
      })
    ]);
    expect(userExport.tables.aiProviderConfigs).toEqual([
      expect.objectContaining({
        hasCredential: true,
        id: releaseIds.aiProvider
      })
    ]);
    expect(exportedJson).not.toContain("connector-ciphertext-sentinel");
    expect(exportedJson).not.toContain("ai-ciphertext-sentinel");
    expect(exportedJson).not.toContain("auth-access-token-sentinel");
    expect(exportedJson).not.toContain("auth-refresh-token-sentinel");
    expect(exportedJson).not.toContain("auth-id-token-sentinel");
    expect(exportedJson).not.toContain("auth-password-sentinel");
    expect(exportedJson).not.toContain("better-auth-session-token-sentinel");
    expect(exportedJson).not.toContain("User B private task granted to A");
    expect(Object.keys(userExport.tables.connectorAccounts[0] ?? {})).not.toContain(
      "encryptedSecret"
    );
    expect(Object.keys(userExport.tables.aiProviderConfigs[0] ?? {})).not.toContain(
      "encryptedCredential"
    );

    expect(userExport.tables).toHaveProperty("memoryChunks");
    expect(userExport.tables).toHaveProperty("chatMemoryFacts");
    expect(userExport.tables).toHaveProperty("commitments");
    expect(userExport.tables).toHaveProperty("entities");
    expect(userExport.tables).toHaveProperty("preferences");

    expect(userExport.tables.emailMessages).toEqual([
      expect.objectContaining({
        id: releaseIds.emailMessage,
        summary: "email-summary-sentinel",
        signals: expect.objectContaining({ note: "email-signals-sentinel", importance: "high" })
      })
    ]);
    expect(exportedJson).toContain("email-summary-sentinel");
    expect(exportedJson).toContain("email-signals-sentinel");

    expect(exportedJson).not.toContain('"embedding"');
    expect(exportedJson).not.toContain('"content_hash"');
    expect(exportedJson).not.toContain('"file_hash"');
  });

  it("exports memory chunks, memory facts, commitments, entities, and preferences — redacts derived fields", async () => {
    await seedExportExtensionData();

    const userExport = await exportUserData({
      appConnectionString: connectionStrings.app,
      exportedAt: new Date("2026-06-12T10:00:00.000Z"),
      userId: ids.userA
    });
    const exportedJson = JSON.stringify(userExport);

    expect(userExport.tables.memoryChunks.length).toBeGreaterThan(0);
    expect(userExport.tables.memoryChunks[0]).toHaveProperty("id");
    expect(userExport.tables.memoryChunks[0]).toHaveProperty("sourceKind");
    expect(userExport.tables.memoryChunks[0]).toHaveProperty("sourcePath");
    expect(userExport.tables.memoryChunks[0]).toHaveProperty("lineStart");
    expect(userExport.tables.memoryChunks[0]).toHaveProperty("lineEnd");
    expect(userExport.tables.memoryChunks[0]).toHaveProperty("text");
    expect(Object.keys(userExport.tables.memoryChunks[0] ?? {})).not.toContain("embedding");
    expect(Object.keys(userExport.tables.memoryChunks[0] ?? {})).not.toContain("content_hash");
    expect(Object.keys(userExport.tables.memoryChunks[0] ?? {})).not.toContain("contentHash");

    expect(userExport.tables.chatMemoryFacts.length).toBeGreaterThan(0);
    expect(userExport.tables.chatMemoryFacts[0]).toHaveProperty("id");
    expect(userExport.tables.chatMemoryFacts[0]).toHaveProperty("category");
    expect(userExport.tables.chatMemoryFacts[0]).toHaveProperty("content");
    expect(Object.keys(userExport.tables.chatMemoryFacts[0] ?? {})).not.toContain("embedding");

    expect(userExport.tables.commitments.length).toBeGreaterThan(0);
    expect(userExport.tables.commitments[0]).toHaveProperty("id");
    expect(userExport.tables.commitments[0]).toHaveProperty("title");
    expect(userExport.tables.commitments[0]).toHaveProperty("status");

    expect(userExport.tables.entities.length).toBeGreaterThan(0);
    expect(userExport.tables.entities[0]).toHaveProperty("id");
    expect(userExport.tables.entities[0]).toHaveProperty("name");
    expect(userExport.tables.entities[0]).toHaveProperty("type");

    expect(userExport.tables.preferences.length).toBeGreaterThan(0);
    expect(userExport.tables.preferences[0]).toHaveProperty("id");
    expect(userExport.tables.preferences[0]).toHaveProperty("key");
    expect(userExport.tables.preferences[0]).toHaveProperty("valueJson");

    expect(exportedJson).not.toContain('"embedding"');
    expect(exportedJson).not.toContain('"content_hash"');
    expect(exportedJson).not.toContain('"file_hash"');
    expect(exportedJson).not.toContain("hash-sentinel");
  });

  it("deletes one user only after exact confirmation and records metadata-only audit", async () => {
    await seedExportExtensionData();
    const result = await deleteUserData({
      actorUserId: ids.userB,
      bootstrapConnectionString: connectionStrings.bootstrap,
      confirmUserId: ids.userA,
      dryRun: false,
      userId: ids.userA
    });
    const rows = await readLifecycleRows();
    const auditJson = JSON.stringify(rows.auditMetadata);

    expect(result.dryRun).toBe(false);
    expect(result.deleted).toBe(true);
    expect(result.vaultDeleted).toBe(true);
    expect(result.countsBeforeDelete["app.users"]).toBe(1);
    expect(rows.userAExists).toBe(false);
    expect(rows.userBExists).toBe(true);
    expect(rows.userBTaskExists).toBe(true);
    expect(rows.userAConnectorRows).toBe(0);
    expect(rows.userAAiProviderRows).toBe(0);
    expect(rows.auditAction).toBe("user.delete");
    expect(rows.auditTargetId).toBe(ids.userA);
    expect(auditJson).not.toContain("connector-ciphertext-sentinel");
    expect(auditJson).not.toContain("ai-ciphertext-sentinel");
    expect(auditJson).not.toContain("User A exportable task");
  });

  it("refuses destructive user deletion when the confirmation does not match", async () => {
    await expect(
      deleteUserData({
        actorUserId: ids.userB,
        bootstrapConnectionString: connectionStrings.bootstrap,
        confirmUserId: ids.userB,
        dryRun: false,
        userId: ids.userA
      })
    ).rejects.toThrow("Confirmation user id must match the target user id");
  });

  it("DELETE /api/admin/users/:id succeeds after workspace tables are dropped", async () => {
    const db2 = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    const boss2 = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 }); // #1124: CI PG connect can exceed pg-boss's 10s default even on success (test-only)
    const server2 = createApiServer({ appDb: db2, boss: boss2, logger: false });
    await server2.ready();
    const bootstrapClient = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrapClient.connect();
    try {
      // Disable approval so newly registered users are active, not pending. instance_settings
      // UPDATE is RLS-gated (migration 0059); write through the open bootstrap superuser client.
      await bootstrapClient.query(
        `UPDATE app.instance_settings SET value = '{"value": false}'::jsonb, updated_at = now() WHERE key = 'registration.requires_approval'`
      );

      // Sign up the owner. seedLifecycleData already inserted userA/userB, so this owner is
      // NOT the first user and is not auto-promoted — we promote it explicitly below.
      const ownerRes = await server2.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: { name: "Owner", email: "owner-del@example.test", password: "password12345" }
      });
      const ownerCookie = ownerRes.headers["set-cookie"] as string;
      const ownerId = ownerRes.json<{ user: { id: string } }>().user.id;

      // Promote the owner to an active instance admin so the DELETE is authorized.
      await bootstrapClient.query(
        `UPDATE app.users SET is_instance_admin = true, status = 'active' WHERE id = $1`,
        [ownerId]
      );

      // Sign up the deletion target.
      const targetRes = await server2.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: { name: "Target", email: "target-del@example.test", password: "password12345" }
      });
      const targetId = targetRes.json<{ user: { id: string } }>().user.id;

      const deleteRes = await server2.inject({
        method: "DELETE",
        url: `/api/admin/users/${targetId}`,
        headers: { cookie: ownerCookie }
      });
      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.json<{ deletedUserId: string }>().deletedUserId).toBe(targetId);
    } finally {
      await bootstrapClient.end();
      await Promise.allSettled([server2.close(), db2.destroy(), boss2.stop({ graceful: false })]);
    }
  });

  it("keeps runtime DELETE grants limited to audited protected-table exceptions", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });

    await client.connect();
    try {
      const privileges = await client.query<{
        app_can_delete: boolean;
        table_name: string;
        worker_can_delete: boolean;
      }>(
        `
          SELECT
            c.relname AS table_name,
            has_table_privilege('jarvis_app_runtime', c.oid, 'DELETE') AS app_can_delete,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'DELETE') AS worker_can_delete
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app'
            AND c.relname = ANY($1::text[])
          ORDER BY c.relname
        `,
        [
          [
            "ai_configured_models",
            "ai_provider_configs",
            "briefing_definitions",
            "briefing_runs",
            "calendar_events",
            "chat_messages",
            "chat_threads",
            "connector_accounts",
            "email_messages",
            "notifications",
            "tasks"
          ]
        ]
      );

      expect(privileges.rows).toHaveLength(11);
      expect(privileges.rows).toEqual(
        privileges.rows.map((row) => ({
          ...row,
          app_can_delete: row.table_name === "ai_configured_models",
          worker_can_delete: row.table_name === "calendar_events"
        }))
      );
    } finally {
      await client.end();
    }
  });

  it("audits runtime roles, forced RLS, protected DELETE grants, and admin audit privileges", async () => {
    const report = await auditReleaseHardening({
      bootstrapConnectionString: connectionStrings.bootstrap
    });

    expect(report.passed).toBe(true);
    expect(report.roles).toEqual([
      {
        bypassRls: false,
        canCreateDb: false,
        canCreateRole: false,
        isSuperuser: false,
        roleName: "jarvis_app_runtime"
      },
      {
        bypassRls: false,
        canCreateDb: false,
        canCreateRole: false,
        isSuperuser: false,
        roleName: "jarvis_auth_runtime"
      },
      {
        bypassRls: false,
        canCreateDb: false,
        canCreateRole: false,
        isSuperuser: false,
        roleName: "jarvis_migration_owner"
      },
      {
        bypassRls: false,
        canCreateDb: false,
        canCreateRole: false,
        isSuperuser: false,
        roleName: "jarvis_worker_runtime"
      }
    ]);
    expect(report.protectedTables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appCanDelete: false,
          forceRls: true,
          tableName: "tasks",
          workerCanDelete: false
        }),
        expect.objectContaining({
          appCanDelete: false,
          forceRls: true,
          tableName: "connector_accounts",
          workerCanDelete: false
        }),
        expect.objectContaining({
          appCanDelete: false,
          forceRls: true,
          tableName: "ai_provider_configs",
          workerCanDelete: false
        }),
        expect.objectContaining({
          appCanDelete: false,
          forceRls: true,
          tableName: "ai_assistant_action_requests",
          workerCanDelete: false
        })
      ])
    );
    expect(report.transientTables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forceRls: true,
          rlsEnabled: true,
          tableName: "connector_oauth_pending"
        })
      ])
    );
    expect(report.authSecretTables).toEqual(
      expect.arrayContaining([
        {
          appCanSelect: false,
          forceRls: true,
          rlsEnabled: true,
          tableName: "auth_accounts"
        },
        {
          appCanSelect: false,
          forceRls: true,
          rlsEnabled: true,
          tableName: "auth_sessions"
        },
        {
          appCanSelect: false,
          forceRls: true,
          rlsEnabled: true,
          tableName: "auth_verifications"
        },
        {
          appCanSelect: false,
          forceRls: true,
          rlsEnabled: true,
          tableName: "better_auth_sessions"
        }
      ])
    );
    // OTNR #168 LOW — FORCE-RLS regression: app.users must have RLS ENABLED
    // (relrowsecurity = true) but NOT FORCED (relforcerowsecurity = false).
    // Better-auth's SECURITY DEFINER functions run as jarvis_migration_owner (the
    // table owner), which bypasses RLS only when FORCE is absent.  Every other
    // product table in the app schema must have FORCE RLS — asserted above via
    // protectedTables (forceRls: true) and the dynamic coverage check in
    // collectFailures (scripts/audit-release-hardening.ts), which fails if any
    // new table lacks FORCE RLS without an explicit exemption entry.
    expect(report.authOwnerTable).toEqual(
      expect.arrayContaining([
        {
          appCanSelect: true,
          // ENABLE but not FORCE: owner (jarvis_migration_owner) must bypass for SECURITY DEFINER
          // functions that query users for admin checks (e.g. list_connector_account_safe_metadata).
          forceRls: false,
          rlsEnabled: true,
          tableName: "users"
        }
      ])
    );
    expect(report.adminAuditPrivileges).toEqual({
      appCanDelete: false,
      appCanInsert: true,
      appCanSelect: true,
      appCanUpdate: false,
      // #671: worker-run export jobs write an audit event via recordAuditEvent(); worker gets
      // exactly INSERT+SELECT (migration 0136), never UPDATE/DELETE.
      workerCanDelete: false,
      workerCanInsert: true,
      workerCanSelect: true,
      workerCanUpdate: false
    });
    expect(report.failures).toEqual([]);
  });

  it("builds backup, restore, and Docker Compose smoke plans without exposing database passwords", () => {
    const backupPlan = createBackupPlan({
      connectionString: "postgres://postgres:super-secret@db.example.test:5432/jarv1s",
      outputFile: "backups/jarv1s-test.dump"
    });
    const restorePlan = createRestorePlan({
      backupFile: "backups/jarv1s-test.dump",
      confirmDatabase: "jarv1s",
      confirmRestore: true,
      connectionString: "postgres://postgres:super-secret@db.example.test:5432/jarv1s",
      execute: true
    });
    const composePlan = createComposeSmokePlan({
      apiPort: "3900",
      composeFile: "infra/docker-compose.yml"
    });

    // Assert the command vectors that main() actually executes (docker exec), not a
    // legacy field, so a regression that leaked the password into argv would be caught.
    expect(backupPlan.dockerArgs).toContain("pg_dump");
    expect(backupPlan.dockerArgs).toContain("--no-owner");
    expect(backupPlan.dockerArgs).toContain("--no-privileges");
    expect(backupPlan.outputFile).toBe("backups/jarv1s-test.dump");
    expect(backupPlan.env.PGPASSWORD).toBe("super-secret");
    // The password travels only via env (docker --env PGPASSWORD), never the argv.
    expect(backupPlan.dockerArgs.join(" ")).not.toContain("super-secret");

    expect(restorePlan.restoreArgs).toContain("pg_restore");
    expect(restorePlan.restoreArgs).toContain("--clean");
    expect(restorePlan.restoreArgs).toContain("--if-exists");
    expect(restorePlan.restoreArgs).toContain("--no-owner");
    expect(restorePlan.restoreArgs).toContain("--no-privileges");
    // Dump is streamed over stdin — never staged as a plaintext file inside the container.
    expect(restorePlan.restoreArgs.join(" ")).not.toContain("/tmp/restore.dump");
    expect(restorePlan.backupFile).toBe("backups/jarv1s-test.dump");
    expect(restorePlan.env.PGPASSWORD).toBe("super-secret");
    expect(restorePlan.restoreArgs.join(" ")).not.toContain("super-secret");
    expect(composePlan.healthUrl).toBe("http://localhost:3900/health/ready");
    expect(JSON.stringify(composePlan.commands)).toContain("infra/docker-compose.yml");
    expect(JSON.stringify(composePlan.commands)).not.toContain("postgres://");
    expect(
      composePlan.commands.some((c) => c.args.includes("api") && c.args.includes("--wait"))
    ).toBe(true);
  });

  it("requires explicit restore confirmation before destructive execution", () => {
    expect(() =>
      createRestorePlan({
        backupFile: "backups/jarv1s-test.dump",
        confirmRestore: false,
        connectionString: "postgres://postgres:super-secret@db.example.test:5432/jarv1s",
        execute: true
      })
    ).toThrow("Restore execution requires --confirm-restore");
  });

  it("requires --confirm-database to match the target before destructive restore", () => {
    // The `--clean --if-exists` restore drops/recreates objects, so a mistargeted
    // connection string is destructive. The operator must name the exact database
    // back, mirroring the confirmUserId guard in delete-user-data.ts (#171).
    expect(() =>
      createRestorePlan({
        backupFile: "backups/jarv1s-test.dump",
        confirmRestore: true,
        connectionString: "postgres://postgres:super-secret@db.example.test:5432/jarv1s",
        execute: true
      })
    ).toThrow('--confirm-database to match the target database "jarv1s"');

    expect(() =>
      createRestorePlan({
        backupFile: "backups/jarv1s-test.dump",
        confirmDatabase: "wrong-db",
        confirmRestore: true,
        connectionString: "postgres://postgres:super-secret@db.example.test:5432/jarv1s",
        execute: true
      })
    ).toThrow('--confirm-database to match the target database "jarv1s"');

    // A drill plan (execute omitted) does not require the database confirmation.
    expect(() =>
      createRestorePlan({
        backupFile: "backups/jarv1s-test.dump",
        connectionString: "postgres://postgres:super-secret@db.example.test:5432/jarv1s"
      })
    ).not.toThrow();
  });

  it("rejects backup and restore connection strings missing a username", () => {
    // PGPASSWORD without a username silently falls back to the OS user, which can
    // hit an unintended role; require the URL to carry credentials explicitly (#171).
    expect(() =>
      createBackupPlan({
        connectionString: "postgres://:super-secret@db.example.test:5432/jarv1s",
        outputFile: "backups/jarv1s-test.dump"
      })
    ).toThrow("Backup database URL must include a username");

    expect(() =>
      createRestorePlan({
        backupFile: "backups/jarv1s-test.dump",
        connectionString: "postgres://:super-secret@db.example.test:5432/jarv1s"
      })
    ).toThrow("Restore database URL must include a username");
  });

  it("rejects backup and restore connection strings missing a password", () => {
    // An empty password silently forwards an empty PGPASSWORD, which can fall through to
    // trust/peer auth on a misconfigured host; require the URL to carry a password (#299).
    expect(() =>
      createBackupPlan({
        connectionString: "postgres://jarv1s@db.example.test:5432/jarv1s",
        outputFile: "backups/jarv1s-test.dump"
      })
    ).toThrow("Backup database URL must include a password");

    expect(() =>
      createRestorePlan({
        backupFile: "backups/jarv1s-test.dump",
        connectionString: "postgres://jarv1s@db.example.test:5432/jarv1s"
      })
    ).toThrow("Restore database URL must include a password");
  });

  it("keeps Docker Compose node installs isolated from host node_modules", async () => {
    const composeFile = await readFile("infra/docker-compose.yml", "utf8");

    expect(composeFile).toContain("- /workspace/node_modules");
    expect(composeFile).toContain("- /workspace/apps/api/node_modules");
    expect(composeFile).toContain("- /workspace/apps/web/node_modules");
    expect(composeFile).toContain("- /workspace/apps/worker/node_modules");
    expect(composeFile).toContain("- /workspace/packages/ai/node_modules");
    expect(composeFile).toContain('CI: "true"');
    expect(composeFile).toContain("--store-dir /tmp/pnpm-store");
  });

  it("documents production environment variables without development secrets", async () => {
    const envExample = await readFile("infra/env.production.example", "utf8");
    const operationsDoc = await readFile("docs/operations/release-hardening.md", "utf8");

    for (const variable of [
      "NODE_ENV=production",
      "JARVIS_BOOTSTRAP_DATABASE_URL=",
      "JARVIS_MIGRATION_DATABASE_URL=",
      "JARVIS_APP_DATABASE_URL=",
      "JARVIS_AUTH_DATABASE_URL=",
      "JARVIS_WORKER_DATABASE_URL=",
      "BETTER_AUTH_SECRET=",
      "JARVIS_AUTH_BASE_URL=",
      "JARVIS_AUTH_TRUSTED_ORIGINS=",
      "JARVIS_CONNECTOR_SECRET_KEY=",
      "JARVIS_AI_SECRET_KEY=",
      "JARVIS_API_PORT=",
      "JARVIS_WEB_PORT=",
      "JARVIS_DOCKER_SUBNET=",
      "JARVIS_AUTH_GOOGLE_CLIENT_ID=",
      "JARVIS_AUTH_GITHUB_CLIENT_ID=",
      "JARVIS_AUTH_MICROSOFT_CLIENT_ID=",
      "JARVIS_AUTH_OIDC_DISCOVERY_URL="
    ]) {
      expect(envExample).toContain(variable);
    }

    expect(envExample).not.toContain("postgres:postgres");
    expect(envExample).not.toContain("migration_password");
    expect(envExample).not.toContain("app_password");
    expect(envExample).not.toContain("worker_password");
    expect(envExample).not.toContain("dev-only");
    expect(operationsDoc).toContain("infra/env.production.example");
    expect(operationsDoc).toContain("BETTER_AUTH_SECRET");
    expect(operationsDoc).toContain("JARVIS_CONNECTOR_SECRET_KEY");
    expect(operationsDoc).toContain("JARVIS_AI_SECRET_KEY");
  });

  it("denies app_runtime and worker_runtime direct SELECT on auth_sessions and auth_verifications", async () => {
    const appClient = new pg.Client({ connectionString: connectionStrings.app });
    const workerClient = new pg.Client({ connectionString: connectionStrings.worker });

    await Promise.all([appClient.connect(), workerClient.connect()]);
    try {
      await expect(appClient.query("SELECT id FROM app.auth_sessions LIMIT 1")).rejects.toThrow();
      await expect(
        workerClient.query("SELECT id FROM app.auth_sessions LIMIT 1")
      ).rejects.toThrow();
      await expect(
        appClient.query("SELECT id FROM app.auth_verifications LIMIT 1")
      ).rejects.toThrow();
      await expect(
        workerClient.query("SELECT id FROM app.auth_verifications LIMIT 1")
      ).rejects.toThrow();
    } finally {
      await Promise.all([appClient.end(), workerClient.end()]);
    }
  });

  it("enforces self-row restriction on users SELECT for jarvis_app_runtime (GUC set = own row only)", async () => {
    // users userA and userB are already seeded by beforeEach (seedLifecycleData).
    // Connect as jarvis_app_runtime, set GUC to userA (session-level).
    // self-row policy: only userA visible → count of {userA, userB} = 1.
    // On origin/main: USING(true) → both visible → count = 2 → test FAILS (RED).
    // After migration 0047: self-row → count = 1 → test PASSES (GREEN).
    const appClient = new Client({ connectionString: connectionStrings.app });

    await appClient.connect();
    try {
      await appClient.query("SELECT set_config('app.actor_user_id', $1, false)", [ids.userA]);
      const result = await appClient.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app.users WHERE id IN ($1::uuid, $2::uuid)",
        [ids.userA, ids.userB]
      );
      expect(result.rows[0]?.count).toBe("1");
    } finally {
      await appClient.end();
    }
  });

  it("AuthSessionResolver resolves bearer tokens via the security definer function", async () => {
    const testSessionId = "40000000-ffff-4000-8000-999999999999";
    const bootstrapClient = new pg.Client({ connectionString: connectionStrings.bootstrap });

    await bootstrapClient.connect();
    try {
      await bootstrapClient.query(
        "INSERT INTO app.auth_sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [testSessionId, ids.userA]
      );
    } finally {
      await bootstrapClient.end();
    }

    const appDb = createDatabase({ connectionString: connectionStrings.app });
    try {
      const resolver = new AuthSessionResolver(appDb);
      const context = await resolver.resolveAccessContext(testSessionId, "request:test");

      expect(context.actorUserId).toBe(ids.userA);
      expect(context.requestId).toBe("request:test");
    } finally {
      await appDb.destroy();
    }
  });

  it("defines CI automation for foundation, release hardening, audit, web, and Compose smoke", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("pnpm verify:foundation");
    expect(workflow).toContain("pnpm test:release-hardening");
    expect(workflow).toContain("pnpm audit:release-hardening");
    expect(workflow).toContain("pnpm build:web");
    expect(workflow).toContain("pnpm test:e2e");
    expect(workflow).toContain("pnpm smoke:compose -- --api-port 3099");
    expect(workflow).toContain("pnpm smoke:compose:prod");
    expect(workflow).toContain('JARVIS_API_PORT: "3099"');
    expect(workflow).toContain('JARVIS_WEB_PORT: "5180"');
    expect(workflow).toContain("ghcr.io/motioneso/moss:");
    expect(staleSplitImages.filter((name) => workflow.includes(`${name}:`))).toEqual([]);
    expect(workflow).toContain("docker compose -f infra/docker-compose.yml down -v");
  });

  it("does not document stale split production image names", async () => {
    for (const rel of [
      "README.md",
      "docs/operations/release-hardening.md",
      "infra/docker-compose.prod.yml"
    ]) {
      const text = await readFile(rel, "utf8");
      expect(staleSplitImages.filter((n) => text.includes(`ghcr.io/motioneso/${n}`))).toEqual([]);
    }
  });
});

async function seedLifecycleData(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO app.users (id, email, name, is_instance_admin)
        VALUES
          ($1, 'user-a@example.test', 'User A', false),
          ($2, 'user-b@example.test', 'User B', false)
      `,
      [ids.userA, ids.userB]
    );
    await client.query(
      `
        INSERT INTO app.auth_accounts (
          account_id,
          provider_id,
          user_id,
          access_token,
          refresh_token,
          id_token,
          password,
          scope
        )
        VALUES (
          'account-a',
          'credential',
          $1,
          'auth-access-token-sentinel',
          'auth-refresh-token-sentinel',
          'auth-id-token-sentinel',
          'auth-password-sentinel',
          'openid email'
        )
      `,
      [ids.userA]
    );
    await client.query(
      `
        INSERT INTO app.better_auth_sessions (expires_at, token, user_id)
        VALUES (now() + interval '1 hour', 'better-auth-session-token-sentinel', $1)
      `,
      [ids.userA]
    );
    await client.query(
      `
        INSERT INTO app.task_lists (owner_user_id, name)
        VALUES ($1, 'Personal'), ($2, 'Personal')
        ON CONFLICT DO NOTHING
      `,
      [ids.userA, ids.userB]
    );
    await client.query(
      `
        INSERT INTO app.tasks (id, owner_user_id, title, description, list_id)
        VALUES
          ($1, $2, 'User A exportable task', 'User A private task body',
            (SELECT id FROM app.task_lists WHERE owner_user_id = $2 AND name = 'Personal' LIMIT 1)),
          ($3, $4, 'User B private task granted to A', 'User B private task body',
            (SELECT id FROM app.task_lists WHERE owner_user_id = $4 AND name = 'Personal' LIMIT 1))
      `,
      [releaseIds.userATask, ids.userA, releaseIds.userBTask, ids.userB]
    );
    await client.query(
      `
        INSERT INTO app.connector_accounts (
          id,
          provider_id,
          owner_user_id,
          scopes,
          encrypted_secret
        )
        VALUES ($1, 'google-calendar', $2, ARRAY['calendar.readonly'], $3::jsonb)
      `,
      [
        releaseIds.connectorAccount,
        ids.userA,
        JSON.stringify({
          ciphertext: "connector-ciphertext-sentinel",
          iv: "iv",
          tag: "tag",
          version: 1
        })
      ]
    );
    await client.query(
      `
        INSERT INTO app.calendar_events (
          id,
          connector_account_id,
          owner_user_id,
          title,
          starts_at,
          ends_at,
          external_id
        )
        VALUES ($1, $2, $3, 'Calendar item', now(), now() + interval '1 hour', 'event-a')
      `,
      [releaseIds.calendarEvent, releaseIds.connectorAccount, ids.userA]
    );
    await client.query(
      `
        INSERT INTO app.email_messages (
          id,
          connector_account_id,
          owner_user_id,
          sender,
          subject,
          received_at,
          external_id,
          summary,
          signals
        )
        VALUES (
          $1, $2, $3, 'sender@example.test', 'Email item', now(), 'message-a',
          'email-summary-sentinel', $4::jsonb
        )
      `,
      [
        releaseIds.emailMessage,
        releaseIds.connectorAccount,
        ids.userA,
        JSON.stringify({ importance: "high", note: "email-signals-sentinel" })
      ]
    );
    await client.query(
      `
        INSERT INTO app.ai_provider_configs (
          id,
          owner_user_id,
          provider_kind,
          display_name,
          encrypted_credential
        )
        VALUES ($1, $2, 'custom', 'Test AI', $3::jsonb)
      `,
      [
        releaseIds.aiProvider,
        ids.userA,
        JSON.stringify({
          ciphertext: "ai-ciphertext-sentinel",
          iv: "iv",
          tag: "tag",
          version: 1
        })
      ]
    );
    await client.query(
      `
        INSERT INTO app.ai_configured_models (
          id,
          provider_config_id,
          owner_user_id,
          provider_model_id,
          display_name,
          capabilities
        )
        VALUES ($1, $2, $3, 'test-model', 'Test Model', ARRAY['chat'])
      `,
      [releaseIds.aiModel, releaseIds.aiProvider, ids.userA]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function seedExportExtensionData(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO app.memory_chunks
         (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
       VALUES ($1, 'vault', 'notes/test.md', 0, 10, 'hash-sentinel', 'chunk text sentinel')`,
      [ids.userA]
    );
    await client.query(
      `INSERT INTO app.chat_memory_facts
         (owner_user_id, category, content, importance)
       VALUES ($1, 'fact', 'user likes coffee', 0.80)`,
      [ids.userA]
    );
    await client.query(
      `INSERT INTO app.commitments
         (owner_user_id, title, status, provenance, source_kind)
       VALUES ($1, 'send the report', 'open', 'inferred', 'email')`,
      [ids.userA]
    );
    await client.query(
      `INSERT INTO app.entities
         (owner_user_id, type, name, attributes, provenance)
       VALUES ($1, 'person', 'Alice Smith', '{}', 'volunteered')`,
      [ids.userA]
    );
    await client.query(
      `INSERT INTO app.preferences
         (owner_user_id, key, value_json)
       VALUES ($1, 'persona.tone', '"concise"')`,
      [ids.userA]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function readLifecycleRows(): Promise<{
  readonly auditAction: string | null;
  readonly auditMetadata: Record<string, unknown>;
  readonly auditTargetId: string | null;
  readonly userAAiProviderRows: number;
  readonly userAConnectorRows: number;
  readonly userAExists: boolean;
  readonly userBExists: boolean;
  readonly userBTaskExists: boolean;
}> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });

  await client.connect();
  try {
    const result = await client.query<{
      audit_action: string | null;
      audit_metadata: Record<string, unknown> | null;
      audit_target_id: string | null;
      user_a_ai_provider_rows: string;
      user_a_connector_rows: string;
      user_a_exists: boolean;
      user_b_exists: boolean;
      user_b_task_exists: boolean;
    }>(
      `
        SELECT
          EXISTS (SELECT 1 FROM app.users WHERE id = $1) AS user_a_exists,
          EXISTS (SELECT 1 FROM app.users WHERE id = $2) AS user_b_exists,
          EXISTS (SELECT 1 FROM app.tasks WHERE id = $3) AS user_b_task_exists,
          (SELECT count(*) FROM app.connector_accounts WHERE owner_user_id = $1) AS user_a_connector_rows,
          (SELECT count(*) FROM app.ai_provider_configs WHERE owner_user_id = $1) AS user_a_ai_provider_rows,
          (
            SELECT action
            FROM app.admin_audit_events
            WHERE action = 'user.delete'
            ORDER BY created_at DESC
            LIMIT 1
          ) AS audit_action,
          (
            SELECT target_id
            FROM app.admin_audit_events
            WHERE action = 'user.delete'
            ORDER BY created_at DESC
            LIMIT 1
          ) AS audit_target_id,
          (
            SELECT metadata
            FROM app.admin_audit_events
            WHERE action = 'user.delete'
            ORDER BY created_at DESC
            LIMIT 1
          ) AS audit_metadata
      `,
      [ids.userA, ids.userB, releaseIds.userBTask]
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error("Lifecycle row read returned no result");
    }

    return {
      auditAction: row.audit_action,
      auditMetadata: row.audit_metadata ?? {},
      auditTargetId: row.audit_target_id,
      userAAiProviderRows: Number(row.user_a_ai_provider_rows),
      userAConnectorRows: Number(row.user_a_connector_rows),
      userAExists: row.user_a_exists,
      userBExists: row.user_b_exists,
      userBTaskExists: row.user_b_task_exists
    };
  } finally {
    await client.end();
  }
}
