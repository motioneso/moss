import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import {
  WorkshopProjectsRepository,
  WorkshopProjectConflictError,
  collectWorkshopProjects,
  WorkshopProjectFeed,
  WorkshopMessageConflictError,
  collectWorkshopProjectFeed
} from "@moss/workshop";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let app: Kysely<MossDatabase>;
let worker: Kysely<MossDatabase>;
let bootstrap: Kysely<MossDatabase>;
let context: DataContextRunner;
let workerContext: DataContextRunner;
const repo = new WorkshopProjectsRepository();
const actor = ids.adminUser;
const other = ids.userB;
const input = () => ({
  requestKey: randomUUID(),
  title: "Private project",
  initialRequest: "Build a saved-word module",
  context: "Use private host storage"
});

beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 3 });
  worker = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  await bootstrap
    .updateTable("app.users")
    .set({ is_instance_admin: true })
    .where("id", "=", other)
    .execute();
  context = new DataContextRunner(app);
  workerContext = new DataContextRunner(worker);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), worker?.destroy(), bootstrap?.destroy()]);
});

describe("Workshop private projects", () => {
  it("concurrent replay creates one durable project and rejects changed input", async () => {
    const request = input();
    const results = await Promise.all(
      [1, 2].map(() =>
        context.withDataContext({ actorUserId: actor }, (db) => repo.create(db, request))
      )
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0]!.project).toEqual(results[1]!.project);
    await expect(
      context.withDataContext({ actorUserId: actor }, (db) =>
        repo.create(db, { ...request, context: "Different requirements" })
      )
    ).rejects.toBeInstanceOf(WorkshopProjectConflictError);
    expect(
      await context.withDataContext({ actorUserId: actor }, (db) =>
        repo.get(db, results[0]!.project.id)
      )
    ).toEqual(results[0]!.project);
  });

  it("isolates both admin owners, including direct table access and forged inserts", async () => {
    const request = input();
    const mine = await context.withDataContext({ actorUserId: actor }, (db) =>
      repo.create(db, request)
    );
    const theirs = await context.withDataContext({ actorUserId: other }, (db) =>
      repo.create(db, request)
    );
    expect(theirs.created).toBe(true);
    expect(theirs.project.id).not.toBe(mine.project.id);
    await context.withDataContext({ actorUserId: other }, async (db) => {
      expect(await repo.get(db, mine.project.id)).toBeNull();
      expect(
        await db.db
          .selectFrom("app.workshop_projects")
          .select("id")
          .where("id", "=", mine.project.id)
          .execute()
      ).toEqual([]);
      expect((await repo.list(db)).some((item) => item.id === mine.project.id)).toBe(false);
      expect((await collectWorkshopProjects(db)).projects.map((item) => item.id)).not.toContain(
        mine.project.id
      );
    });
    await expect(
      context.withDataContext({ actorUserId: other }, (db) =>
        db.db
          .insertInto("app.workshop_projects")
          .values({
            owner_user_id: actor,
            request_key: randomUUID(),
            title: "Forged",
            initial_request: "No",
            context: ""
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("permits only owner-scoped worker reads and cannot create execution records", async () => {
    const created = await context.withDataContext({ actorUserId: actor }, async (db) => {
      const before = await db.db.selectFrom("app.module_builds").select("id").execute();
      const result = await repo.create(db, input());
      expect(await db.db.selectFrom("app.module_builds").select("id").execute()).toEqual(before);
      return result;
    });
    expect(
      await workerContext.withDataContext({ actorUserId: actor }, (db) =>
        repo.get(db, created.project.id)
      )
    ).toEqual(created.project);
    expect(
      await workerContext.withDataContext({ actorUserId: other }, (db) =>
        repo.get(db, created.project.id)
      )
    ).toBeNull();
    await expect(
      workerContext.withDataContext({ actorUserId: actor }, (db) => repo.create(db, input()))
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("paginates equal timestamps without duplicates or omissions", async () => {
    await context.withDataContext({ actorUserId: actor }, async (db) => {
      for (let i = 0; i < 4; i++) await repo.create(db, input());
    });
    await context.withDataContext({ actorUserId: actor }, async (db) => {
      const all = await repo.list(db, { limit: 100 });
      const seen: string[] = [];
      let before: { id: string; createdAt: string } | undefined;
      for (let page = 0; page < 10; page++) {
        const rows = await repo.list(db, { limit: 2, before });
        if (!rows.length) break;
        seen.push(...rows.map((row) => row.id));
        before = rows.at(-1)!;
      }
      expect(seen).toEqual(all.map((row) => row.id));
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  it("bounds bytes at both the repository and database boundaries", async () => {
    for (const bad of [
      { title: " " },
      { title: "é".repeat(81) },
      { initialRequest: "x".repeat(16385) },
      { context: "\0" }
    ]) {
      await expect(
        context.withDataContext({ actorUserId: actor }, (db) =>
          repo.create(db, { ...input(), ...bad })
        )
      ).rejects.toThrow("Invalid project");
    }
    await expect(
      context.withDataContext({ actorUserId: actor }, (db) =>
        db.db
          .insertInto("app.workshop_projects")
          .values({
            request_key: randomUUID(),
            title: "é".repeat(81),
            initial_request: "request",
            context: ""
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      context.withDataContext({ actorUserId: actor }, (db) => repo.list(db, { limit: 101 }))
    ).rejects.toThrow("page size");
    await expect(
      context.withDataContext({ actorUserId: actor }, (db) =>
        repo.list(db, { before: { id: randomUUID(), createdAt: "invalid" } })
      )
    ).rejects.toThrow("timestamp");
  });

  it("declares enforced RLS and cascades only the deleted owner's projects", async () => {
    const flags = await sql<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'app.workshop_projects'::regclass`.execute(
      bootstrap
    );
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const owner = await bootstrap
      .selectFrom("app.users")
      .selectAll()
      .where("id", "=", actor)
      .executeTakeFirstOrThrow();
    const disposable = randomUUID();
    await bootstrap
      .insertInto("app.users")
      .values({ ...owner, id: disposable, email: `${disposable}@example.invalid` })
      .execute();
    const created = await context.withDataContext({ actorUserId: disposable }, (db) =>
      repo.create(db, input())
    );
    await bootstrap.deleteFrom("app.users").where("id", "=", disposable).execute();
    expect(
      await bootstrap
        .selectFrom("app.workshop_projects")
        .select("id")
        .where("id", "=", created.project.id)
        .execute()
    ).toEqual([]);
    expect(
      (await context.withDataContext({ actorUserId: actor }, (db) => repo.list(db))).length
    ).toBeGreaterThan(0);
  });
});

const feed = new WorkshopProjectFeed();
const message = () => ({ messageId: randomUUID(), text: "Keep this requirement" });
const createProject = async () =>
  (await context.withDataContext({ actorUserId: actor }, (db) => repo.create(db, input()))).project
    .id;

describe("Workshop durable message feed", () => {
  it("deduplicates concurrent acceptance and reports pending, never delivered", async () => {
    const id = await createProject();
    const request = message();
    const saved = await Promise.all(
      [1, 2].map(() =>
        context.withDataContext({ actorUserId: actor }, (db) => feed.append(db, id, request))
      )
    );
    expect(saved.filter((item) => item?.created)).toHaveLength(1);
    expect(saved[0]?.entry).toEqual(saved[1]?.entry);
    expect(saved[0]?.entry).toMatchObject({
      sequence: "1",
      kind: "user_message",
      delivery: "pending"
    });
    await expect(
      context.withDataContext({ actorUserId: actor }, (db) =>
        feed.append(db, id, { ...request, text: "Changed" })
      )
    ).rejects.toBeInstanceOf(WorkshopMessageConflictError);
  });

  it("reconnects through ordered concurrent appends and rolls back cursor allocation", async () => {
    const id = await createProject();
    await expect(
      context.withDataContext({ actorUserId: actor }, async (db) => {
        await feed.append(db, id, message());
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        context.withDataContext({ actorUserId: actor }, (db) => feed.append(db, id, message()))
      )
    );
    const first = await context.withDataContext({ actorUserId: actor }, (db) =>
      feed.list(db, id, { limit: 2 })
    );
    expect(first?.entries.map((item) => item.sequence)).toEqual(["1", "2"]);
    const next = await context.withDataContext({ actorUserId: actor }, (db) =>
      feed.list(db, id, { after: first!.nextCursor })
    );
    expect(next?.entries.map((item) => item.sequence)).toEqual(["3", "4"]);
    const empty = await context.withDataContext({ actorUserId: actor }, (db) =>
      feed.list(db, id, { after: next!.nextCursor })
    );
    expect(empty).toEqual({ entries: [], nextCursor: "4" });
    const exported = await context.withDataContext(
      { actorUserId: actor },
      collectWorkshopProjectFeed
    );
    expect(exported.entries.filter((item) => item.projectId === id)).toHaveLength(4);
  });

  it("keeps uncommitted messages behind the cursor until commit", async () => {
    const id = await createProject();
    let release!: () => void;
    let signal!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const writing = context.withDataContext({ actorUserId: actor }, async (db) => {
      await feed.append(db, id, message());
      signal();
      await held;
    });
    // Propagate a failed writer instead of leaving the test waiting for its signal.
    await Promise.race([inserted, writing]);
    try {
      const page = await context.withDataContext({ actorUserId: actor }, (db) => feed.list(db, id));
      expect(page).toEqual({ entries: [], nextCursor: "0" });
    } finally {
      release();
      await writing;
    }
    const page = await context.withDataContext({ actorUserId: actor }, (db) =>
      feed.list(db, id, { after: "0" })
    );
    expect(page?.entries.map((item) => item.sequence)).toEqual(["1"]);
  });

  it("denies foreign projects, forged parent ownership and worker writes", async () => {
    const id = await createProject();
    await context.withDataContext({ actorUserId: actor }, (db) => feed.append(db, id, message()));
    await context.withDataContext({ actorUserId: other }, async (db) => {
      expect(await feed.append(db, id, message())).toBeNull();
      expect(await feed.list(db, id)).toBeNull();
      expect(await feed.list(db, randomUUID())).toBeNull();
      expect(
        (await collectWorkshopProjectFeed(db)).entries.some((item) => item.projectId === id)
      ).toBe(false);
      expect(
        await db.db
          .selectFrom("app.workshop_project_feed")
          .select("message_id")
          .where("project_id", "=", id)
          .execute()
      ).toEqual([]);
    });
    await expect(
      context.withDataContext({ actorUserId: other }, (db) =>
        db.db
          .insertInto("app.workshop_project_feed")
          .values({
            project_id: id,
            message_id: randomUUID(),
            sequence: "2",
            text: "Forged parent"
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      (await workerContext.withDataContext({ actorUserId: actor }, (db) => feed.list(db, id)))
        ?.entries
    ).toHaveLength(1);
    expect(
      await workerContext.withDataContext({ actorUserId: other }, (db) => feed.list(db, id))
    ).toBeNull();
    await expect(
      workerContext.withDataContext({ actorUserId: actor }, (db) =>
        db.db
          .insertInto("app.workshop_project_feed")
          .values({ project_id: id, message_id: randomUUID(), sequence: "2", text: "Worker" })
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
    await bootstrap.deleteFrom("app.workshop_projects").where("id", "=", id).execute();
    expect(
      await bootstrap
        .selectFrom("app.workshop_project_feed")
        .select("message_id")
        .where("project_id", "=", id)
        .execute()
    ).toEqual([]);
  });

  it("bounds text, cursors and page size at trust boundaries", async () => {
    const id = await createProject();
    for (const text of [" ", "é".repeat(8193), "bad\0text"]) {
      await expect(
        context.withDataContext({ actorUserId: actor }, (db) =>
          feed.append(db, id, { ...message(), text })
        )
      ).rejects.toThrow("Invalid project message");
    }
    for (const after of ["-1", "1.5", "01", "9223372036854775808", "1".repeat(100)]) {
      await expect(
        context.withDataContext({ actorUserId: actor }, (db) => feed.list(db, id, { after }))
      ).rejects.toThrow("cursor");
    }
    await expect(
      context.withDataContext({ actorUserId: actor }, (db) => feed.list(db, id, { limit: 101 }))
    ).rejects.toThrow("page size");
    await expect(
      context.withDataContext({ actorUserId: actor }, (db) =>
        db.db
          .insertInto("app.workshop_project_feed")
          .values({
            project_id: id,
            message_id: randomUUID(),
            sequence: "1",
            text: "é".repeat(8193)
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});
