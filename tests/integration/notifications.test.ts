// Split #1328: this file used to also carry the spec-verification-bullet tests and the
// Task 2b keyed-upsert tests; both moved to notifications-hardening.test.ts and
// notifications-keyed-upsert.test.ts respectively when this file grew past the 1000-line
// cap. Seed data and actor contexts shared across all three live in
// ./notifications-harness.ts. This file keeps the migration/manifest static checks and the
// core actor-scoped RLS/REST CRUD behavior — the tests most people mean by "notifications
// integration tests".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import Fastify from "fastify";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  AuthSessionResolver,
  DataContextRunner,
  createDatabase,
  type MossDatabase
} from "@moss/db";
import {
  getBuiltInModuleManifests,
  getBuiltInModuleRegistrations,
  getBuiltInSqlMigrationDirectories
} from "@moss/module-registry";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  NotificationsRepository,
  notificationsModuleManifest,
  registerNotificationsRoutes
} from "@moss/notifications";
import {
  connectionStrings,
  expectedBuiltInModuleIds,
  ids,
  resetFoundationDatabase
} from "./test-database.js";
import {
  notificationIds,
  seedNotificationData,
  userAContext,
  userBContext
} from "./notifications-harness.js";

const { Client } = pg;

// An id guaranteed not to exist as a notification row — used to assert the
// absent-vs-denied 404 indistinguishability (Verification bullet 6).
const nonexistentNotificationId = randomUUID();

describe("Notifications module M5", () => {
  let appDb: Kysely<MossDatabase>;
  let auth: AuthSessionResolver;
  let dataContext: DataContextRunner;
  let repository: NotificationsRepository;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await seedNotificationData();

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    auth = new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    repository = new NotificationsRepository();
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
  });

  it("applies Notifications migrations with forced RLS and a narrow worker SELECT/INSERT grant on notifications", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });

    await client.connect();
    try {
      const migrations = await client.query<{ version: string; name: string }>(
        `
          SELECT version, name
          FROM app.schema_migrations
          WHERE version IN ('0008', '0071', '0101', '0102', '0105', '0142', '0181')
          ORDER BY version
        `
      );
      const tables = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owner: string;
        worker_can_select: boolean;
        worker_can_insert: boolean;
        worker_can_update: boolean;
        worker_can_delete: boolean;
      }>(
        `
          SELECT
            c.relname,
            c.relrowsecurity,
            c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) AS owner,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'SELECT') AS worker_can_select,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'INSERT') AS worker_can_insert,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'UPDATE') AS worker_can_update,
            has_table_privilege('jarvis_worker_runtime', c.oid, 'DELETE') AS worker_can_delete
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app'
            AND c.relname IN ('notifications', 'notification_reads')
          ORDER BY c.relname
        `
      );

      // 0071 (real-briefings) added a worker-role SELECT/INSERT grant + policies on
      // app.notifications ONLY (so the briefings worker can deliver the "morning briefing
      // ready" notification); before 0181 the worker could never UPDATE/DELETE notifications.
      // 0101 adds the metadata size CHECK; 0102 adds the defense-in-depth SQL comments on the
      // notifications / notification_reads tables. 0166 (export gap) adds a worker-role
      // SELECT-only grant + policy on notification_reads so export.build can read a user's
      // notification read-state. 0181 (Task 2b, #1283 — renumbered because other migrations
      // landed first) adds the
      // ctx.notify keyed-upsert
      // columns/index and — for BOTH jarvis_app_runtime and jarvis_worker_runtime — the
      // UPDATE-on-notifications and DELETE-on-notification_reads grant/policy pairs the
      // keyed upsert's "update in place + clear read state on re-fire" needs. The real
      // crawl posts keyed notifications from the worker/queue lane, so the worker-role half
      // of this grant is load-bearing, not incidental.
      expect(migrations.rows).toEqual([
        { version: "0008", name: "0008_notifications_module.sql" },
        { version: "0071", name: "0071_notifications_worker_insert_grant.sql" },
        {
          version: "0101",
          name: "0101_notifications_metadata_size_check.sql"
        },
        {
          version: "0102",
          name: "0102_notifications_defense_in_depth_comments.sql"
        },
        {
          version: "0105",
          name: "0105_notifications_urgency_deferral.sql"
        },
        {
          version: "0142",
          name: "0142_notifications_module_id.sql"
        },
        {
          version: "0181",
          name: "0181_notification_event_keys.sql"
        }
      ]);
      expect(tables.rows).toEqual([
        {
          relname: "notification_reads",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner",
          worker_can_select: true,
          worker_can_insert: false,
          worker_can_update: false,
          // 0178: the keyed upsert's return-to-unread clear runs as a DELETE in the
          // SAME statement as the worker-role INSERT it already had.
          worker_can_delete: true
        },
        {
          relname: "notifications",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner",
          worker_can_select: true,
          worker_can_insert: true,
          // 0178: the keyed upsert's ON CONFLICT DO UPDATE needs UPDATE on the worker role
          // too — the real crawl only ever posts keyed notifications from the queue lane.
          worker_can_update: true,
          worker_can_delete: false
        }
      ]);
    } finally {
      await client.end();
    }
  });

  it("loads the built-in Notifications module manifest with the digest queue", () => {
    const manifests = getBuiltInModuleManifests();
    const registrations = getBuiltInModuleRegistrations();
    const registration = registrations.find(
      (item) => item.manifest.id === notificationsModuleManifest.id
    );
    const manifest = manifests.find((item) => item.id === notificationsModuleManifest.id);

    expect(manifests.map((item) => item.id)).toEqual(expectedBuiltInModuleIds);
    expect(registrations.map((item) => item.manifest.id)).toEqual(expectedBuiltInModuleIds);
    expect(manifest?.database?.ownedTables).toEqual([
      "app.notifications",
      "app.notification_reads"
    ]);
    // No sidebar nav entry: notifications are reached via the topbar bell (AppShell).
    // The route + APIs remain registered; only the module-nav link was retired.
    expect(manifest?.navigation).toEqual([]);
    expect(manifest?.settings ?? []).toEqual([]);
    expect(registration?.queueDefinitions).toEqual([
      { name: "notifications.digest.compose", options: { retryLimit: 0 } }
    ]);
    expect(getBuiltInSqlMigrationDirectories()).toContainEqual(
      expect.stringContaining("packages/notifications/sql")
    );
  });

  it("denies notification reads when no data context is set", async () => {
    await expect(appDb.selectFrom("app.notifications").select("id").execute()).resolves.toEqual([]);
  });

  it("forbids inserting a notification for another recipient with the current actor", async () => {
    await expect(
      dataContext.withDataContext(userBContext(), (scopedDb) =>
        scopedDb.db
          .insertInto("app.notifications")
          .values({
            id: notificationIds.forgedForUserA,
            actor_user_id: ids.userB,
            recipient_user_id: ids.userA,
            title: "Forged cross-recipient notification",
            body: "User B must not create this for User A",
            metadata: { source: "integration-test" }
          })
          .execute()
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("creates private notifications for the active actor by default", async () => {
    const created = (await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, {
        moduleId: "briefings",
        title: "Private default notification",
        body: "Only User A can read this",
        metadata: {
          source: "integration-test"
        }
      })
    ))!;
    const fetchedByOwner = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, created.id)
    );
    const fetchedByOtherUser = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.getById(scopedDb, created.id)
    );

    expect(created.actor_user_id).toBe(ids.userA);
    expect(created.recipient_user_id).toBe(ids.userA);
    expect(created.module_id).toBe("briefings");
    expect(created.read_at).toBeNull();
    expect(fetchedByOwner?.id).toBe(created.id);
    expect(fetchedByOtherUser).toBeUndefined();
  });

  it("does not let another user or admin role read private notifications", async () => {
    const userRead = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, notificationIds.bPrivate)
    );
    const adminContext = await auth.resolveAccessContext(
      ids.sessionAdmin,
      "request:admin-notifications"
    );
    const adminRead = await dataContext.withDataContext(adminContext, (scopedDb) =>
      repository.getById(scopedDb, notificationIds.bPrivate)
    );

    expect(userRead).toBeUndefined();
    expect(adminRead).toBeUndefined();
  });

  it("recipient-only access: notification is visible to its recipient, and invisible to non-recipients", async () => {
    // aSeed has recipient_user_id=userA. Under the recipient-only RLS policy,
    // only the recipient can see it.
    const visibleToRecipient = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, notificationIds.aSeed)
    );
    const nonRecipient = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.getById(scopedDb, notificationIds.aSeed)
    );

    expect(visibleToRecipient?.id).toBe(notificationIds.aSeed);
    // Non-recipient cannot see it
    expect(nonRecipient).toBeUndefined();
  });

  it("tracks read state per actor for visible notifications", async () => {
    // aSeed has recipient_user_id=userA; it is visible to userA under the recipient-only
    // policy regardless of any inert header — the personal-actor context is the only context.
    const beforeRead = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, notificationIds.aSeed)
    );
    const markedRead = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markRead(scopedDb, notificationIds.aSeed)
    );
    const afterRead = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, notificationIds.aSeed)
    );
    const hiddenMarkRead = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.markRead(scopedDb, notificationIds.bPrivate)
    );

    expect(beforeRead?.read_at).toBeNull();
    expect(markedRead?.read_at).toBeInstanceOf(Date);
    expect(afterRead?.read_at).toBeInstanceOf(Date);
    expect(hiddenMarkRead).toBeUndefined();
  });

  it("serves Notifications API list, mark read, and mark all read from session context", async () => {
    // The personal-actor context is the only context in V1. A second request that varies
    // an irrelevant header (x-request-id) must return the identical actor-scoped set.
    const listResponse = await server.inject({
      method: "GET",
      url: "/api/notifications",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const listWithIrrelevantHeaderResponse = await server.inject({
      method: "GET",
      url: "/api/notifications",
      headers: {
        authorization: `Bearer ${ids.sessionA}`,
        "x-request-id": "00000000-0000-4000-8000-000000000099"
      }
    });
    const deniedMarkReadResponse = await server.inject({
      method: "PATCH",
      url: `/api/notifications/${notificationIds.bPrivate}/read`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const nonexistentMarkReadResponse = await server.inject({
      method: "PATCH",
      url: `/api/notifications/${nonexistentNotificationId}/read`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const markReadResponse = await server.inject({
      method: "PATCH",
      url: `/api/notifications/${notificationIds.aPrivate}/read`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const markAllResponse = await server.inject({
      method: "PATCH",
      url: "/api/notifications/read-all",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const afterMarkAllResponse = await server.inject({
      method: "GET",
      url: "/api/notifications",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });

    // Under recipient-only policy, aSeed (recipient=userA) is visible to userA — the
    // personal-actor context is the only context, so the irrelevant header probe must
    // return the same actor-scoped set.
    expect(listResponse.statusCode).toBe(200);
    expect(
      listResponse
        .json<{ notifications: Array<{ id: string }> }>()
        .notifications.some((notification) => notification.id === notificationIds.aSeed)
    ).toBe(true);
    expect(listWithIrrelevantHeaderResponse.statusCode).toBe(200);
    expect(
      listWithIrrelevantHeaderResponse
        .json<{ notifications: Array<{ id: string }> }>()
        .notifications.some((notification) => notification.id === notificationIds.aSeed)
    ).toBe(true);
    // Absent-vs-denied indistinguishability: a nonexistent id (randomUUID) and an
    // RLS-invisible id (bPrivate for userA) both answer 404 with the identical body.
    expect(deniedMarkReadResponse.statusCode).toBe(404);
    expect(nonexistentMarkReadResponse.statusCode).toBe(404);
    expect(deniedMarkReadResponse.body).toBe(nonexistentMarkReadResponse.body);
    expect(markReadResponse.statusCode).toBe(200);
    expect(
      markReadResponse.json<{ notification: { id: string; readAt: string | null } }>().notification
    ).toMatchObject({
      id: notificationIds.aPrivate,
      readAt: expect.any(String)
    });
    expect(markAllResponse.statusCode).toBe(200);
    expect(markAllResponse.json<{ unreadCount: number }>().unreadCount).toBe(0);
    expect(afterMarkAllResponse.json<{ unreadCount: number }>().unreadCount).toBe(0);
  });

  it("fails loudly when the Notifications repository is called without withDataContext", async () => {
    await expect(repository.listVisible({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
  });

  it("returns 401 for no auth header and for a wrong-scheme authorization header", async () => {
    const noAuthResponse = await server.inject({
      method: "GET",
      url: "/api/notifications"
    });

    // Wrong scheme ("Basic") → readBearerToken returns undefined → cookie auth finds no session → 401
    const wrongSchemeResponse = await server.inject({
      method: "GET",
      url: "/api/notifications",
      headers: { authorization: "Basic dXNlcjpwYXNz" }
    });

    expect(noAuthResponse.statusCode).toBe(401);
    expect(wrongSchemeResponse.statusCode).toBe(401);
    expect(noAuthResponse.json<{ error: string }>().error).toBe("Session is missing or expired");
  });

  it("returns 500 (not 401) when an unexpected error escapes a notification route", async () => {
    const probe = Fastify({ logger: false });
    registerNotificationsRoutes(probe, {
      resolveAccessContext: async () => ({
        actorUserId: ids.userA,
        requestId: "request:err-probe"
      }),
      dataContext,
      repository: {
        listVisible: async () => {
          throw new Error("boom-stack-details");
        }
      } as unknown as NotificationsRepository
    });
    await probe.ready();

    try {
      const res = await probe.inject({ method: "GET", url: "/api/notifications" });

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain("boom-stack-details");
    } finally {
      await probe.close();
    }
  });
});
