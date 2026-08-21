import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import {
  AuthSessionResolver,
  DataContextRunner,
  assertUniqueMigrationVersions,
  createDatabase,
  type AccessContext,
  type MossDatabase,
  type MigrationFile
} from "@moss/db";
import { RlsProbeRepository } from "@moss/db/probes";
import {
  RLS_PROBE_QUEUE,
  createPgBossClient,
  registerDataContextWorker,
  sendJob,
  type ActorScopedJobPayload,
  type RlsProbeJobPayload
} from "@moss/jobs";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

async function selectVisibleProbeIds(rootDb: Kysely<MossDatabase>): Promise<string[]> {
  const rows = await rootDb.selectFrom("app.rls_probe_items").select("id").orderBy("id").execute();

  return rows.map((row) => row.id);
}

describe("MVP foundation scaffold", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let auth: AuthSessionResolver;
  let dataContext: DataContextRunner;
  let repository: RlsProbeRepository;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;

  beforeAll(async () => {
    await resetFoundationDatabase();

    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });

    workerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });

    auth = new AuthSessionResolver(appDb);
    dataContext = new DataContextRunner(appDb);
    repository = new RlsProbeRepository();

    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "setup:seed-share" },
      async (scopedDb) => {
        await sql`
          insert into app.shares
            (resource_type, resource_id, owner_user_id, grantee_user_id, level)
          values
            ('rls_probe_item', ${ids.itemBGrantedToA}::uuid, ${ids.userB}::uuid, ${ids.userA}::uuid, 'view')
          on conflict (resource_type, resource_id, grantee_user_id) do nothing
        `.execute(scopedDb.db);
      }
    );

    appBoss = createPgBossClient(connectionStrings.app);
    workerBoss = createPgBossClient(connectionStrings.worker);

    await appBoss.start();
    await workerBoss.start();
  });

  afterAll(async () => {
    await Promise.allSettled([
      appBoss?.stop({ graceful: false }),
      workerBoss?.stop({ graceful: false }),
      appDb?.destroy(),
      workerDb?.destroy()
    ]);
  });

  it("enumerates only active non-denied module users through a locked-down definer", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const security = await client.query<{
        owner_name: string;
        proconfig: string[];
        rolbypassrls: boolean;
        worker_execute: boolean;
        public_execute: boolean;
      }>(`
        SELECT owner.rolname AS owner_name,
               p.proconfig,
               owner.rolbypassrls,
               has_function_privilege(
                 'jarvis_worker_runtime', p.oid, 'EXECUTE'
               ) AS worker_execute,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
        FROM pg_proc p
        JOIN pg_roles owner ON owner.oid = p.proowner
        WHERE p.oid = 'app.list_active_external_module_users(text)'::regprocedure
      `);
      expect(security.rows).toEqual([
        {
          owner_name: "jarvis_migration_owner",
          proconfig: ["search_path=pg_catalog, app, pg_temp"],
          rolbypassrls: false,
          worker_execute: true,
          public_execute: false
        }
      ]);

      await client.query(
        `INSERT INTO app.external_modules
           (id, status, manifest_hash, package_hash)
         VALUES ('fixture', 'enabled', 'sha256:manifest', 'sha256:package')`
      );
      const before = await sql<{ user_id: string }>`
        SELECT user_id FROM app.list_active_external_module_users('fixture')
      `.execute(workerDb);
      expect(before.rows.map((row) => row.user_id)).toContain(ids.userA);
      expect(before.rows.map((row) => row.user_id)).toContain(ids.userB);

      await client.query(
        `INSERT INTO app.module_enablement (scope, module_id, user_id)
         VALUES ('user', 'fixture', $1::uuid)`,
        [ids.userA]
      );
      const after = await sql<{ user_id: string }>`
        SELECT user_id FROM app.list_active_external_module_users('fixture')
      `.execute(workerDb);
      expect(after.rows.map((row) => row.user_id)).not.toContain(ids.userA);
      expect(after.rows.map((row) => row.user_id)).toContain(ids.userB);
    } finally {
      await client.query(`DELETE FROM app.module_enablement WHERE module_id = 'fixture'`);
      await client.query(`DELETE FROM app.external_modules WHERE id = 'fixture'`);
      await client.end();
    }
  });

  it("fans a draft module out to its owner alone, not to every enabled-module user (#1753)", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.external_modules
           (id, status, manifest_hash, package_hash, owner_user_id)
         VALUES ('fixture-draft', 'draft', 'sha256:manifest', 'sha256:package', $1::uuid)`,
        [ids.userA]
      );

      const rows = await sql<{ user_id: string }>`
        SELECT user_id FROM app.list_active_external_module_users('fixture-draft')
      `.execute(workerDb);
      expect(rows.rows.map((row) => row.user_id)).toEqual([ids.userA]);
      expect(rows.rows.map((row) => row.user_id)).not.toContain(ids.userB);

      // The owner has no deny row and yet still sees only themselves — a draft's own
      // author cannot be excluded by the enabled-module deny list, because that list
      // never applies to drafts in the first place.
      await client.query(
        `INSERT INTO app.module_enablement (scope, module_id, user_id)
         VALUES ('user', 'fixture-draft', $1::uuid)`,
        [ids.userA]
      );
      const stillOwnerOnly = await sql<{ user_id: string }>`
        SELECT user_id FROM app.list_active_external_module_users('fixture-draft')
      `.execute(workerDb);
      expect(stillOwnerOnly.rows.map((row) => row.user_id)).toEqual([ids.userA]);
    } finally {
      await client.query(`DELETE FROM app.module_enablement WHERE module_id = 'fixture-draft'`);
      await client.query(`DELETE FROM app.external_modules WHERE id = 'fixture-draft'`);
      await client.end();
    }
  });

  it("keeps runtime roles from owning protected tables or bypassing RLS", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });

    await client.connect();
    try {
      const roles = await client.query<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        `
          SELECT rolname, rolsuper, rolbypassrls
          FROM pg_roles
          WHERE rolname IN ('jarvis_app_runtime', 'jarvis_worker_runtime')
          ORDER BY rolname
        `
      );

      const owner = await client.query<{ tableowner: string }>(
        `
          SELECT tableowner
          FROM pg_tables
          WHERE schemaname = 'app'
            AND tablename = 'rls_probe_items'
        `
      );

      expect(roles.rows).toEqual([
        { rolname: "jarvis_app_runtime", rolsuper: false, rolbypassrls: false },
        { rolname: "jarvis_worker_runtime", rolsuper: false, rolbypassrls: false }
      ]);
      expect(owner.rows[0]?.tableowner).toBe("jarvis_migration_owner");
    } finally {
      await client.end();
    }
  });

  it("denies protected rows when no app context is set", async () => {
    await expect(selectVisibleProbeIds(appDb)).resolves.toEqual([]);
    await expect(selectVisibleProbeIds(workerDb)).resolves.toEqual([]);
  });

  it("resolves a session to app authz context and lets a user read their own private row", async () => {
    const accessContext = await auth.resolveAccessContext(ids.sessionA, "request:user-a");

    const item = await dataContext.withDataContext(accessContext, (scopedDb) =>
      repository.getById(scopedDb, ids.itemAOwnPrivate)
    );

    expect(accessContext.actorUserId).toBe(ids.userA);
    expect(item?.id).toBe(ids.itemAOwnPrivate);
  });

  it("prevents a user from reading another user's unshared private row", async () => {
    const item = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, ids.itemBPrivate)
    );

    expect(item).toBeUndefined();
  });

  describe("transient view share (isolated)", () => {
    afterAll(async () => {
      // Delete only the specific share created by this test; the beforeAll-seeded
      // share for itemBGrantedToA (resource_id = ids.itemBGrantedToA) is untouched.
      await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "request:share-teardown" },
        async (scopedDb) => {
          await scopedDb.db
            .deleteFrom("app.shares")
            .where("resource_type", "=", "rls_probe_item")
            .where("resource_id", "=", ids.itemAOwnPrivate)
            .where("grantee_user_id", "=", ids.userB)
            .execute();
        }
      );
    });

    it("allows probe access through a view share", async () => {
      // userA owns a probe row; share 'view' to userB so the new owner-or-share
      // policy grants userB SELECT access.
      await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "request:share-setup" },
        async (scopedDb) => {
          await sql`
            insert into app.shares
              (resource_type, resource_id, owner_user_id, grantee_user_id, level)
            values
              ('rls_probe_item', ${ids.itemAOwnPrivate}::uuid, ${ids.userA}::uuid, ${ids.userB}::uuid, 'view')
          `.execute(scopedDb.db);
        }
      );

      const visibleToB = await dataContext.withDataContext(
        { actorUserId: ids.userB, requestId: "request:user-b" },
        (scopedDb) =>
          scopedDb.db
            .selectFrom("app.rls_probe_items")
            .selectAll()
            .where("id", "=", ids.itemAOwnPrivate)
            .executeTakeFirst()
      );

      expect(visibleToB?.id).toBe(ids.itemAOwnPrivate);
    });
  });

  it("share isolation: seeded itemBGrantedToA survives and transient itemAOwnPrivate share is gone", async () => {
    // (a) The teardown in the transient-share describe deletes only the itemAOwnPrivate
    // share — the beforeAll-seeded itemBGrantedToA share must remain, so userA still sees it.
    const seededStillVisible = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, ids.itemBGrantedToA)
    );
    expect(seededStillVisible?.id).toBe(ids.itemBGrantedToA);

    // (b) The transient share for itemAOwnPrivate was removed — userB must no longer see it.
    // If the targeted afterAll delete silently fails or its where-clause drifts, this fails.
    const transientGone = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "request:user-b-isolation" },
      (scopedDb) =>
        scopedDb.db
          .selectFrom("app.rls_probe_items")
          .selectAll()
          .where("id", "=", ids.itemAOwnPrivate)
          .executeTakeFirst()
    );
    expect(transientGone).toBeUndefined();
  });

  it("does not let an instance admin read another user's private row by role alone", async () => {
    const adminContext = await auth.resolveAccessContext(ids.sessionAdmin, "request:admin");

    const item = await dataContext.withDataContext(adminContext, (scopedDb) =>
      repository.getById(scopedDb, ids.itemBPrivate)
    );

    expect(item).toBeUndefined();
  });

  it("allows access through an app.shares view grant", async () => {
    // itemBGrantedToA is owned by userB; a view share to userA was seeded in
    // beforeAll — the new owner-or-share policy must honour it.
    const item = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, ids.itemBGrantedToA)
    );

    expect(item?.id).toBe(ids.itemBGrantedToA);
  });

  it("does not leak SET LOCAL identity across pooled requests", async () => {
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const visibleIds = (await repository.listVisible(scopedDb)).map((item) => item.id);
      expect(visibleIds).toContain(ids.itemAOwnPrivate);
    });

    await expect(selectVisibleProbeIds(appDb)).resolves.toEqual([]);
  });

  it("clears transaction-local context after rollback", async () => {
    await expect(
      dataContext.withDataContext(userAContext(), async (scopedDb) => {
        await expect(repository.getById(scopedDb, ids.itemAOwnPrivate)).resolves.toBeDefined();
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");

    await expect(selectVisibleProbeIds(appDb)).resolves.toEqual([]);
  });

  it("fails loudly when a repository is called without the data-context wrapper", async () => {
    await expect(repository.listVisible({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
  });

  it("runs pg-boss clients without runtime migration privileges", async () => {
    await expect(appBoss.schemaVersion()).resolves.toBeGreaterThan(0);
    await expect(workerBoss.schemaVersion()).resolves.toBeGreaterThan(0);

    await expect(appBoss.createQueue("runtime-created-queue")).rejects.toThrow(
      /permission denied/i
    );
  });

  it("processes a metadata-only job through stored actor context without bypassing RLS", async () => {
    const resultPromise = handleNextProbeJob(workerBoss, ids.itemBPrivate);

    const jobId = await appBoss.send(RLS_PROBE_QUEUE, {
      actorUserId: ids.userA,
      targetItemId: ids.itemBPrivate
    } satisfies RlsProbeJobPayload);

    const result = await resultPromise;

    expect(jobId).toBeTypeOf("string");
    expect(result.targetItemVisible).toBe(false);
    expect(result.ownItemVisible).toBe(true);
    // itemBGrantedToA is visible via an app.shares 'view' row seeded in beforeAll
    expect(result.grantedItemVisible).toBe(true);
    expect(result.secondPrivateItemVisible).toBe(false);
  });

  it("keeps pg-boss metadata outside protected app tables and payloads minimal", async () => {
    await appBoss.send(RLS_PROBE_QUEUE, {
      actorUserId: ids.userA,
      targetItemId: ids.itemBPrivate
    } satisfies RlsProbeJobPayload);

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const metadata = await client.query<{
        schema_name: string;
        table_name: string;
      }>(
        `
          SELECT table_schema AS schema_name, table_name
          FROM information_schema.tables
          WHERE table_schema IN ('app', 'pgboss')
            AND table_name IN ('rls_probe_items', 'job_common')
          ORDER BY table_schema, table_name
        `
      );

      const payloads = await client.query<{ data: Record<string, unknown> }>(
        `
          SELECT data
          FROM pgboss.job_common
          WHERE name = $1
          ORDER BY created_on DESC
          LIMIT 1
        `,
        [RLS_PROBE_QUEUE]
      );

      expect(metadata.rows).toEqual([
        { schema_name: "app", table_name: "rls_probe_items" },
        { schema_name: "pgboss", table_name: "job_common" }
      ]);
      expect(payloads.rows[0]?.data).toEqual({
        actorUserId: ids.userA,
        targetItemId: ids.itemBPrivate
      });
      expect(payloads.rows[0]?.data).not.toHaveProperty("body");
    } finally {
      await client.end();
    }
  });
});

describe("sendJob send-side guard (#157)", () => {
  it("throws when payload contains a forbidden key 'content'", async () => {
    const fakeBoss = { send: async () => "fake-id" } as unknown as PgBoss;
    await expect(
      sendJob(fakeBoss, "test-queue", {
        actorUserId: "00000000-0000-4000-8000-000000000001",
        content: "secret"
      } as unknown as ActorScopedJobPayload)
    ).rejects.toThrow("Job payload contains non-metadata keys: content");
  });

  it("does not throw for a valid metadata-only payload", async () => {
    let sent = false;
    const fakeBoss = {
      send: async () => {
        sent = true;
        return "fake-id";
      }
    } as unknown as PgBoss;
    await sendJob(fakeBoss, "test-queue", {
      actorUserId: "00000000-0000-4000-8000-000000000001",
      taskId: "some-task-id",
      requestedStatus: "done",
      idempotencyKey: "k1"
    } as unknown as ActorScopedJobPayload);
    expect(sent).toBe(true);
  });
});

describe("assertUniqueMigrationVersions (#124)", () => {
  it("throws when two migration files from different directories share the same version prefix", () => {
    const files: MigrationFile[] = [
      { version: "0055", name: "0055_foo.sql", checksum: "aaa", sql: "SELECT 1;" },
      { version: "0055", name: "0055_bar.sql", checksum: "bbb", sql: "SELECT 2;" }
    ];
    expect(() => assertUniqueMigrationVersions(files)).toThrow(
      "Duplicate migration version numbers across directories: 0055"
    );
  });

  it("does not throw when all version prefixes are unique", () => {
    const files: MigrationFile[] = [
      { version: "0054", name: "0054_a.sql", checksum: "aaa", sql: "SELECT 1;" },
      { version: "0055", name: "0055_b.sql", checksum: "bbb", sql: "SELECT 2;" }
    ];
    expect(() => assertUniqueMigrationVersions(files)).not.toThrow();
  });
});

describe("chat_threads incognito immutability trigger (#135)", () => {
  const threadId = "99000000-0000-4000-8000-000000000001";

  beforeAll(async () => {
    await resetFoundationDatabase();
    // Seed via bootstrap (superuser) to bypass FORCE RLS on chat_threads.
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.chat_threads (id, owner_user_id, title, incognito)
         VALUES ($1, $2, 'Test Thread', false)`,
        [threadId, ids.userA]
      );
    } finally {
      await client.end();
    }
  });

  it("raises 42501 when attempting to UPDATE incognito on an existing chat_thread", async () => {
    // Trigger fires for all roles including superuser.
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await expect(
        client.query(`UPDATE app.chat_threads SET incognito = true WHERE id = $1`, [threadId])
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.end();
    }
  });

  it("does NOT raise on UPDATE of a non-incognito column (title)", async () => {
    // Must set actor context so enforce_chat_thread_update_scope allows the owner to rename.
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.actor_user_id', $1, true)", [ids.userA]);
      const result = await client.query(
        `UPDATE app.chat_threads SET title = 'Renamed Thread' WHERE id = $1`,
        [threadId]
      );
      await client.query("COMMIT");
      expect(result.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});

interface ProbeJobResult {
  readonly targetItemVisible: boolean;
  readonly ownItemVisible: boolean;
  readonly grantedItemVisible: boolean;
  readonly secondPrivateItemVisible: boolean;
}

async function handleNextProbeJob(
  workerBoss: PgBoss,
  expectedTargetItemId: string
): Promise<ProbeJobResult> {
  const workerDb = createDatabase({
    connectionString: connectionStrings.worker,
    maxConnections: 1
  });
  const dataContext = new DataContextRunner(workerDb);
  const repository = new RlsProbeRepository();
  let workId: string | undefined;

  try {
    const resultPromise = new Promise<ProbeJobResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for pg-boss worker"));
      }, 10_000);

      registerDataContextWorker<RlsProbeJobPayload, ProbeJobResult>(
        workerBoss,
        RLS_PROBE_QUEUE,
        dataContext,
        async (job, scopedDb) => {
          try {
            expect(job.data.targetItemId).toBe(expectedTargetItemId);

            const [targetItem, ownItem, grantedItem, secondPrivateItem] = await Promise.all([
              repository.getById(scopedDb, job.data.targetItemId),
              repository.getById(scopedDb, ids.itemAOwnPrivate),
              repository.getById(scopedDb, ids.itemBGrantedToA),
              repository.getById(scopedDb, ids.itemBSecondPrivate)
            ]);

            const result = {
              targetItemVisible: targetItem !== undefined,
              ownItemVisible: ownItem !== undefined,
              grantedItemVisible: grantedItem !== undefined,
              secondPrivateItemVisible: secondPrivateItem !== undefined
            };

            clearTimeout(timeout);
            resolve(result);
            return result;
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
            throw error;
          }
        },
        { pollingIntervalSeconds: 0.5 }
      )
        .then((registeredWorkId) => {
          workId = registeredWorkId;
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });

    return await resultPromise;
  } finally {
    if (workId) {
      await workerBoss.offWork(RLS_PROBE_QUEUE, { id: workId, wait: true });
    }
    await workerDb.destroy();
  }
}

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a"
  };
}
