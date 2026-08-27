import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  AuthSessionResolver,
  DataContextRunner,
  SharesRepository,
  createDatabase,
  type MossDatabase
} from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import {
  getBuiltInModuleManifests,
  getBuiltInModuleRegistrations,
  getBuiltInSqlMigrationDirectories
} from "@moss/module-registry";
import {
  TASKS_DEFERRED_STATUS_QUEUE,
  TASKS_RECURRENCE_QUEUE,
  type DeferredTaskStatusPayload,
  TaskBreakdownRepository,
  TaskListsRepository,
  TasksRepository,
  registerTasksJobWorkers,
  isTasksRecurrenceOccurrenceConflict,
  rollForwardRecurringSeries,
  generateNext
} from "@moss/tasks";
import type { TaskDto } from "@moss/shared";
import {
  connectionStrings,
  expectedBuiltInModuleIds,
  ids,
  resetFoundationDatabase
} from "./test-database.js";
import {
  handleNextTaskJob,
  seedTaskData,
  taskIds,
  userAContext,
  userBContext
} from "./tasks-helpers.js";

const { Client } = pg;

describe("Tasks module M1", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let auth: AuthSessionResolver;
  let dataContext: DataContextRunner;
  let repository: TasksRepository;
  let sharesRepository: SharesRepository;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    await seedTaskData();

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
    repository = new TasksRepository();
    sharesRepository = new SharesRepository();
    appBoss = createPgBossClient(connectionStrings.app);
    workerBoss = createPgBossClient(connectionStrings.worker);

    await appBoss.start();
    await workerBoss.start();

    server = createApiServer({
      appDb,
      boss: appBoss,
      logger: false
    });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([
      server?.close(),
      appBoss?.stop({ graceful: false }),
      workerBoss?.stop({ graceful: false }),
      appDb?.destroy(),
      workerDb?.destroy()
    ]);
  });

  it("applies Tasks migrations from an empty database with forced RLS", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });

    await client.connect();
    try {
      const migrations = await client.query<{ version: string; name: string }>(
        `
          SELECT version, name
          FROM app.schema_migrations
          WHERE version = '0003'
        `
      );
      const tables = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        owner: string;
      }>(
        `
          SELECT
            c.relname,
            c.relrowsecurity,
            c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) AS owner
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app'
            AND c.relname IN ('tasks', 'task_activity')
          ORDER BY c.relname
        `
      );

      expect(migrations.rows).toEqual([{ version: "0003", name: "0003_tasks_module.sql" }]);
      expect(tables.rows).toEqual([
        {
          relname: "task_activity",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner"
        },
        {
          relname: "tasks",
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: "jarvis_migration_owner"
        }
      ]);
    } finally {
      await client.end();
    }
  });

  it("loads the built-in Tasks module manifest", () => {
    const manifests = getBuiltInModuleManifests();
    const registrations = getBuiltInModuleRegistrations();
    const tasksManifest = manifests.find((manifest) => manifest.id === "tasks");

    expect(manifests.map((manifest) => manifest.id)).toEqual(expectedBuiltInModuleIds);
    expect(registrations.map((registration) => registration.manifest.id)).toEqual(
      expectedBuiltInModuleIds
    );
    expect(tasksManifest?.database?.ownedTables).toEqual(["app.tasks", "app.task_activity"]);
    expect(tasksManifest?.navigation?.[0]).toMatchObject({
      id: "tasks",
      path: "/tasks",
      permissionId: "tasks.view"
    });
    expect(tasksManifest?.permissions?.map((permission) => permission.id)).toContain(
      "tasks.update"
    );
    expect(tasksManifest?.jobs?.[0]).toMatchObject({
      queueName: TASKS_DEFERRED_STATUS_QUEUE,
      metadataOnly: true,
      permissionId: "tasks.update"
    });
    expect(tasksManifest?.assistantTools?.map((tool) => tool.name)).toEqual([
      "tasks.list",
      "tasks.get",
      "tasks.focus",
      "tasks.atRisk",
      "tasks.overdue",
      "tasks.listLists",
      "tasks.listTags",
      "tasks.activity",
      "tasks.create",
      "tasks.update",
      "tasks.updateStatus",
      "tasks.breakDown",
      "tasks.addActivity",
      "tasks.assignTag",
      "tasks.unassignTag",
      "tasks.createList",
      "tasks.renameList",
      "tasks.createTag",
      "tasks.renameTag",
      "tasks.deleteList",
      "tasks.deleteTag"
    ]);
    expect(getBuiltInSqlMigrationDirectories()).toContainEqual(
      expect.stringContaining("packages/tasks/sql")
    );
  });

  it("denies task reads when no data context is set", async () => {
    await expect(appDb.selectFrom("app.tasks").select("id").execute()).resolves.toEqual([]);
  });

  it("lets a user create and read their own private task", async () => {
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, {
        title: "User A private task",
        description: "private description"
      })
    );
    const fetched = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, created.id)
    );

    expect(created.owner_user_id).toBe(ids.userA);
    expect(fetched?.id).toBe(created.id);
  });

  it("prevents a user from reading another user's unshared private task", async () => {
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getById(scopedDb, taskIds.bPrivate)
    );

    expect(task).toBeUndefined();
  });

  it("does not let an instance admin read another user's private task by role alone", async () => {
    const adminContext = await auth.resolveAccessContext(ids.sessionAdmin, "request:admin-tasks");
    const task = await dataContext.withDataContext(adminContext, (scopedDb) =>
      repository.getById(scopedDb, taskIds.bPrivate)
    );

    expect(task).toBeUndefined();
  });

  it("allows task read through a view share", async () => {
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, { title: "Shared with B" })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      sharesRepository.grant(scopedDb, {
        resourceType: "task",
        resourceId: task.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      })
    );
    const visibleToB = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.getById(scopedDb, task.id)
    );

    expect(visibleToB?.id).toBe(task.id);
  });

  it("does not let a view-share grantee update the task", async () => {
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, { title: "View-only for B" })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      sharesRepository.grant(scopedDb, {
        resourceType: "task",
        resourceId: task.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      })
    );
    const updated = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.update(scopedDb, task.id, { title: "hijacked" })
    );

    expect(updated).toBeUndefined(); // RLS hides the row from UPDATE for a view-only grantee
  });

  it("lets a manage-share grantee update the task", async () => {
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, { title: "Managed by B" })
    );
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      sharesRepository.grant(scopedDb, {
        resourceType: "task",
        resourceId: task.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "manage"
      })
    );
    const updated = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.update(scopedDb, task.id, { title: "Managed title" })
    );

    expect(updated?.title).toBe("Managed title");
  });

  it("keeps task activity governed by parent task visibility via owner-or-share inheritance", async () => {
    // userA creates a task and adds activity to it
    const task = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.create(scopedDb, { title: "Activity inheritance test task" })
    );
    const activity = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.addActivity(scopedDb, task.id, {
        activityType: "comment",
        body: "Activity on shared task"
      })
    );

    // Share the task 'view' to userB
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      sharesRepository.grant(scopedDb, {
        resourceType: "task",
        resourceId: task.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      })
    );

    // userB can read the activity (inherits task visibility through task_activity_select EXISTS)
    const visibleToB = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.listActivity(scopedDb, task.id)
    );

    // adminUser has no share — cannot read the activity
    const adminContext = {
      actorUserId: ids.adminUser,
      requestId: "request:tasks-test"
    };
    const notVisibleToAdmin = await dataContext.withDataContext(adminContext, (scopedDb) =>
      repository.listActivity(scopedDb, task.id)
    );

    expect(activity.actor_user_id).toBe(ids.userA);
    expect(visibleToB).toHaveLength(1);
    expect(visibleToB[0]?.body).toBe("Activity on shared task");
    expect(notVisibleToAdmin).toEqual([]);
  });

  it("serves Tasks API routes from session-derived context without accepting client owner fields", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/tasks",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        title: "API-created task",
        ownerUserId: ids.userB,
        owner_user_id: ids.userB
      }
    });
    const created = createResponse.json<{
      task: { id: string; ownerUserId: string; title: string; status: string };
    }>().task;
    const getAsOwnerResponse = await server.inject({
      method: "GET",
      url: `/api/tasks/${created.id}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const titlePatchResponse = await server.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        title: "API-updated task"
      }
    });
    const patchResponse = await server.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        status: "in_progress"
      }
    });
    const listResponse = await server.inject({
      method: "GET",
      url: "/api/tasks",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });
    const getAsOtherUserResponse = await server.inject({
      method: "GET",
      url: `/api/tasks/${created.id}`,
      headers: {
        authorization: `Bearer ${ids.sessionB}`
      }
    });
    const getOtherPrivateResponse = await server.inject({
      method: "GET",
      url: `/api/tasks/${taskIds.bPrivate}`,
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(created.ownerUserId).toBe(ids.userA);
    expect(getAsOwnerResponse.statusCode).toBe(200);
    expect(titlePatchResponse.statusCode).toBe(200);
    expect(titlePatchResponse.json<{ task: { title: string } }>().task.title).toBe(
      "API-updated task"
    );
    expect(patchResponse.statusCode).toBe(400); // in_progress retired
    expect(
      listResponse.json<{ tasks: Array<{ id: string }> }>().tasks.map((task) => task.id)
    ).toContain(created.id);
    expect(getAsOtherUserResponse.statusCode).toBe(404);
    expect(getOtherPrivateResponse.statusCode).toBe(404);
  });

  it("rejects invalid recurrence specs at the route boundary", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/tasks",
      headers: {
        authorization: `Bearer ${ids.sessionA}`
      },
      payload: {
        title: "invalid recurrence",
        recurrence: { freq: "weekly", interval: 1, occurrence_date: "2026-02-30" }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("recurrence");
  });

  it("creates the tasks-recurrence-materialize queue", async () => {
    const queue = await workerBoss.getQueue("tasks-recurrence-materialize");
    expect(queue).not.toBeNull();
  });

  it("isRecurrenceMaterializePayloadMetadataOnly rejects extra keys", async () => {
    const { isRecurrenceMaterializePayloadMetadataOnly } = await import("@moss/tasks");
    expect(isRecurrenceMaterializePayloadMetadataOnly({ actorUserId: ids.userA })).toBe(true);
    expect(
      isRecurrenceMaterializePayloadMetadataOnly({ actorUserId: ids.userA, idempotencyKey: "k" })
    ).toBe(true);
    expect(
      isRecurrenceMaterializePayloadMetadataOnly({ actorUserId: ids.userA, seriesId: "x" })
    ).toBe(false);
  });

  it("a recurrence job with an extra payload key is rejected by the worker and never advances the series", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const past = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const made = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, {
        title: "malformed payload must not roll me",
        recurrence: { freq: "weekly", interval: 1, occurrence_date: past }
      })
    );

    const scopedWorkerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });
    const workerDataContext = new DataContextRunner(scopedWorkerDb);
    let workIds: string[] = [];
    let recurrenceResultFired = false;

    try {
      workIds = await registerTasksJobWorkers(workerBoss, workerDataContext, {
        workOptions: { pollingIntervalSeconds: 0.5 },
        onRecurrenceResult: () => {
          recurrenceResultFired = true;
        }
      });

      // Bypass sendJob's send-side metadata guard with a raw boss.send carrying an extra
      // (non-metadata) key, so the malformed payload reaches the worker handler. The handler's
      // isRecurrenceMaterializePayloadMetadataOnly guard must throw → the job fails, the result
      // callback never fires, and the stale series is NOT advanced.
      await appBoss.send(TASKS_RECURRENCE_QUEUE, {
        actorUserId: ids.userA,
        seriesId: made.recurrence_series_id
      } as unknown as Record<string, unknown>);

      // Give the worker time to pick up, attempt, and reject the malformed job.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } finally {
      await Promise.all(
        workIds.map((workId, index) =>
          workerBoss.offWork(index === 0 ? TASKS_DEFERRED_STATUS_QUEUE : TASKS_RECURRENCE_QUEUE, {
            id: workId,
            wait: true
          })
        )
      );
      await scopedWorkerDb.destroy();
    }

    expect(recurrenceResultFired).toBe(false);

    const live = await dataContext.withDataContext(userAContext(), (db) =>
      db.db
        .selectFrom("app.tasks")
        .selectAll()
        .where("recurrence_series_id", "=", made.recurrence_series_id!)
        .where("status", "=", "todo")
        .execute()
    );
    // Still exactly one live row, still stale (the malformed job rolled nothing forward).
    expect(live).toHaveLength(1);
    const occ = (live[0]!.recurrence as Record<string, unknown>)["occurrence_date"] as string;
    expect(occ).toBe(past);
    expect(occ < today).toBe(true);
  });

  it("rollForward survives a unique-occurrence collision (sibling already at the target date) — no 500, no-op", async () => {
    // A stale live (todo) instance plus a sibling row (e.g. a completed historical instance)
    // already sitting at the date roll-forward would advance to. The in-place UPDATE then trips
    // tasks_recurrence_occurrence_idx (23505). Before the guard this threw and 500'd the whole
    // list load; with the guard it is swallowed as a benign no-op (the series is already
    // represented at the target date) and the stale live row is left untouched.
    const today = new Date().toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Live (todo) instance at today-7; weekly/interval-1 means roll-forward computes exactly `today`.
    const live = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, {
        title: "collision-live",
        recurrence: { freq: "weekly", interval: 1, occurrence_date: sevenDaysAgo }
      })
    );
    const seriesId = live.recurrence_series_id!;

    await dataContext.withDataContext(userAContext(), (db) =>
      db.db
        .insertInto("app.tasks")
        .values({
          id: randomUUID(),
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          list_id: live.list_id,
          title: "collision-done-sibling",
          status: "done",
          position: 0,
          source: "recurrence",
          recurrence: { freq: "weekly", interval: 1, occurrence_date: today } as unknown as Record<
            string,
            unknown
          >,
          recurrence_series_id: seriesId,
          completed_at: new Date()
        })
        .execute()
    );

    const rolled = await dataContext.withDataContext(userAContext(), (db) =>
      rollForwardRecurringSeries(db, seriesId, today)
    );
    expect(rolled).toBe(false);

    const liveAfter = await dataContext.withDataContext(userAContext(), (db) =>
      db.db.selectFrom("app.tasks").selectAll().where("id", "=", live.id).executeTakeFirstOrThrow()
    );
    expect(liveAfter.status).toBe("todo");
    expect((liveAfter.recurrence as Record<string, unknown>)["occurrence_date"]).toBe(sevenDaysAgo);
  });

  it("treats a malformed persisted recurrence JSONB as a safe no-op (read boundary)", async () => {
    const seriesId = randomUUID();
    const anchor = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, { title: "malformed-anchor" })
    );

    const malformedId = randomUUID();
    await dataContext.withDataContext(userAContext(), (db) =>
      db.db
        .insertInto("app.tasks")
        .values({
          id: malformedId,
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          list_id: anchor.list_id,
          title: "malformed-recurrence",
          status: "todo",
          position: 0,
          source: "recurrence",
          recurrence: { freq: "weekly-ish", interval: "soon" } as unknown as Record<
            string,
            unknown
          >,
          recurrence_series_id: seriesId
        })
        .execute()
    );

    const rolled = await dataContext.withDataContext(userAContext(), (db) =>
      rollForwardRecurringSeries(db, seriesId, "2026-06-18")
    );
    expect(rolled).toBe(false);

    const malformedRow = await dataContext.withDataContext(userAContext(), (db) =>
      db.db
        .selectFrom("app.tasks")
        .selectAll()
        .where("id", "=", malformedId)
        .executeTakeFirstOrThrow()
    );
    const generated = await dataContext.withDataContext(userAContext(), (db) =>
      generateNext(db, malformedRow)
    );
    expect(generated).toBeNull();

    const after = await dataContext.withDataContext(userAContext(), (db) =>
      db.db
        .selectFrom("app.tasks")
        .selectAll()
        .where("id", "=", malformedId)
        .executeTakeFirstOrThrow()
    );
    expect(after.status).toBe("todo");
    expect(after.recurrence).toEqual({ freq: "weekly-ish", interval: "soon" });
  });

  it("recognizes only the recurrence occurrence unique constraint as an idempotent conflict", () => {
    expect(
      isTasksRecurrenceOccurrenceConflict({
        code: "23505",
        constraint: "tasks_recurrence_occurrence_idx",
        message: "duplicate key value violates unique constraint"
      })
    ).toBe(true);
    expect(
      isTasksRecurrenceOccurrenceConflict({
        code: "23505",
        constraint: "tasks_source_external_key_idx",
        message: "duplicate key value violates unique constraint"
      })
    ).toBe(false);
    expect(isTasksRecurrenceOccurrenceConflict(new Error("unique"))).toBe(false);
  });

  it("keeps Tasks worker payloads metadata-only", async () => {
    const resultPromise = handleNextTaskJob(workerBoss);
    await appBoss.send(TASKS_DEFERRED_STATUS_QUEUE, {
      actorUserId: ids.userA,
      taskId: taskIds.aPrivate,
      requestedStatus: "done",
      idempotencyKey: "tasks-test-metadata"
    } satisfies DeferredTaskStatusPayload);
    const result = await resultPromise;
    const client = new Client({ connectionString: connectionStrings.bootstrap });

    await client.connect();
    try {
      const payloads = await client.query<{ data: Record<string, unknown> }>(
        `
          SELECT data
          FROM pgboss.job_common
          WHERE name = $1
          ORDER BY created_on DESC
          LIMIT 1
        `,
        [TASKS_DEFERRED_STATUS_QUEUE]
      );
      const payload = payloads.rows[0]?.data;

      expect(result).toMatchObject({
        taskId: taskIds.aPrivate,
        updated: true,
        status: "done"
      });
      expect(payload).toEqual({
        actorUserId: ids.userA,
        taskId: taskIds.aPrivate,
        requestedStatus: "done",
        idempotencyKey: "tasks-test-metadata"
      });
      expect(payload).not.toHaveProperty("title");
      expect(payload).not.toHaveProperty("description");
      expect(payload).not.toHaveProperty("body");
    } finally {
      await client.end();
    }
  });

  it("does not let a User A worker job update User B's private task", async () => {
    const resultPromise = handleNextTaskJob(workerBoss);
    await appBoss.send(TASKS_DEFERRED_STATUS_QUEUE, {
      actorUserId: ids.userA,
      taskId: taskIds.bPrivate,
      requestedStatus: "done"
    } satisfies DeferredTaskStatusPayload);
    const result = await resultPromise;
    const userBTask = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.getById(scopedDb, taskIds.bPrivate)
    );

    expect(result).toEqual({
      taskId: taskIds.bPrivate,
      updated: false,
      status: null
    });
    expect(userBTask?.status).toBe("todo");
  });

  it("fails loudly when the Tasks repository is called without withDataContext", async () => {
    await expect(repository.listVisible({} as never)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
  });

  it("migration 0039: every task has a list, in_progress is retired, new columns exist", async () => {
    // Use the bootstrap (superuser) connection so RLS does not filter the counts.
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const orphans = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM app.tasks WHERE list_id IS NULL"
      );
      expect(Number(orphans.rows[0]?.n)).toBe(0);

      const seededInProgress = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app.tasks
         WHERE id = ANY($1::uuid[]) AND status = 'in_progress'`,
        [[taskIds.aPrivate, taskIds.bPrivate]]
      );
      expect(Number(seededInProgress.rows[0]?.n)).toBe(0);

      const lists = await client.query<{ owner_user_id: string; name: string }>(
        "SELECT owner_user_id, name FROM app.task_lists WHERE name = 'Personal'"
      );
      expect(lists.rows.length).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  it("db types: new task columns and tables are queryable", async () => {
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema='app' and table_name='tasks'
        and column_name in ('list_id','parent_task_id','do_at','effort','source','recurrence_series_id')
    `.execute(appDb);
    expect(cols.rows.length).toBe(6);
  });

  it("shared: Task DTO carries the new fields", () => {
    // compile-time guard: a TaskDto literal must accept the new fields
    const dto: Pick<TaskDto, "listId" | "doAt" | "effort" | "source"> = {
      listId: "x",
      doAt: null,
      effort: "quick",
      source: "manual"
    };
    expect(dto.source).toBe("manual");
  });

  it("create defaults to Personal list, accepts new fields, and is idempotent on (source, external_key)", async () => {
    const listsRepo = new TaskListsRepository();
    const made = await dataContext.withDataContext(userAContext(), async (db) => {
      const list = await listsRepo.getOrCreateDefault(db);
      return repository.create(db, {
        title: "ship the deck",
        priority: 4,
        effort: "medium",
        doAt: new Date("2026-06-10"),
        source: "chat",
        externalKey: "chat:42",
        listId: list.id
      });
    });
    expect(made.priority).toBe(4);
    expect(made.effort).toBe("medium");
    expect(made.source).toBe("chat");
    expect(made.external_key).toBe("chat:42");

    const second = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, { title: "dup", source: "chat", externalKey: "chat:42" })
    );
    expect(second.id).toBe(made.id);

    const defaultList = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.getOrCreateDefault(db)
    );
    const noListTask = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, { title: "auto-list task" })
    );
    expect(noListTask.list_id).toBe(defaultList.id);
    expect(noListTask.source).toBe("manual");
  });

  it("does not treat a cross-owner shared task as a duplicate on (source, external_key) collision", async () => {
    const ownedByA = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, {
        title: "A's synced item",
        source: "sync",
        externalKey: "sync:collide-1"
      })
    );
    await dataContext.withDataContext(userAContext(), (db) =>
      sharesRepository.grant(db, {
        resourceType: "task",
        resourceId: ownedByA.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      })
    );

    const createdByB = await dataContext.withDataContext(userBContext(), (db) =>
      repository.create(db, {
        title: "B's own item",
        source: "sync",
        externalKey: "sync:collide-1"
      })
    );

    expect(createdByB.id).not.toBe(ownedByA.id);
    expect(createdByB.owner_user_id).toBe(ids.userB);
    expect(createdByB.title).toBe("B's own item");
  });

  it("breakdown augments into a parent; all children done auto-closes parent; grandchild rejected", async () => {
    const breakdown = new TaskBreakdownRepository();
    const { parent, children } = await dataContext.withDataContext(userAContext(), async (db) => {
      const p = await repository.create(db, { title: "clean kitchen" });
      const kids = await breakdown.breakDown(db, p.id, ["unload dishwasher", "wipe counters"]);
      return { parent: p, children: kids };
    });

    expect(children).toHaveLength(2);
    expect(children[0]?.parent_task_id).toBe(parent.id);
    expect(children[0]?.list_id).toBe(parent.list_id);
    expect(children[0]?.position).toBe(0);
    expect(children[1]?.position).toBe(1);

    await expect(
      dataContext.withDataContext(userAContext(), (db) =>
        breakdown.breakDown(db, children[0]!.id, ["nope"])
      )
    ).rejects.toThrow(/one-level hierarchy/);

    await dataContext.withDataContext(userAContext(), async (db) => {
      for (const c of children) await repository.updateStatus(db, c.id, "done");
    });
    const reloaded = await dataContext.withDataContext(userAContext(), (db) =>
      repository.getById(db, parent.id)
    );
    expect(reloaded?.status).toBe("done");
  });

  it("breakdown rejects a view-shared task from another owner as a parent (#1489)", async () => {
    const breakdown = new TaskBreakdownRepository();

    const ownedByA = await dataContext.withDataContext(userAContext(), (db) =>
      repository.create(db, { title: "A's task" })
    );
    await dataContext.withDataContext(userAContext(), (db) =>
      sharesRepository.grant(db, {
        resourceType: "task",
        resourceId: ownedByA.id,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      })
    );

    await expect(
      dataContext.withDataContext(userBContext(), (db) =>
        breakdown.breakDown(db, ownedByA.id, ["should not be created"])
      )
    ).rejects.toThrow(/not found or not accessible/);
  });

  it("lists: get-or-create Personal is idempotent; tags are list-scoped", async () => {
    const listsRepo = new TaskListsRepository();

    const a = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.getOrCreateDefault(db)
    );
    const b = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.getOrCreateDefault(db)
    );
    expect(a.id).toBe(b.id);
    expect(a.name).toBe("Personal");

    const tag = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.createTag(db, a.id, "Visa")
    );
    const tags = await dataContext.withDataContext(userAContext(), (db) =>
      listsRepo.listTags(db, a.id)
    );
    expect(tags.map((t) => t.name)).toContain("Visa");
    expect(tag.list_id).toBe(a.id);
    expect(tag.owner_user_id).toBe(ids.userA);
  });
});
