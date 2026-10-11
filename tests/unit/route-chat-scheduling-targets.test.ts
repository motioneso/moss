import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Transaction
} from "kysely";
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb, type MossDatabase } from "@moss/db";
import { tasksModuleManifest } from "../../packages/tasks/src/manifest.js";

const id = "00000000-0000-4000-8000-000000000001";
const tagId = "00000000-0000-4000-8000-000000000002";
const targets = [
  ["/api/tasks/lists/:listId", { listId: id }],
  ["/api/tasks/lists/:listId/tags/:tagId", { listId: id, tagId }],
  ["/api/tasks/:id/tags/:tagId", { id, tagId }]
] as const;

function targetFor(path: string) {
  const target = tasksModuleManifest.routes?.find(
    (route) => route.method === "DELETE" && route.path === path
  )?.chat?.target;
  if (!target) throw new Error(`No destructive target for ${path}`);
  return target;
}

/** Real SQL compilation, an in-memory driver: no database or actor credential is opened. */
function harness(rows: readonly Record<string, unknown>[] = []) {
  const queries: CompiledQuery[] = [];
  const connection = {
    async executeQuery(query: CompiledQuery) {
      queries.push(query);
      return { rows };
    },
    streamQuery() {
      throw new Error("Target lookup does not stream");
    }
  } as unknown as DatabaseConnection;
  class TargetDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return connection;
    }
  }
  const db = new Kysely<MossDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new TargetDriver(),
      createIntrospector: (value) => new PostgresIntrospector(value),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
  const scopedDb: DataContextDb = {
    db: db as unknown as Transaction<MossDatabase>,
    [dataContextBrand]: true
  };
  return { db, scopedDb, queries };
}

describe("scheduling destructive target lookup", () => {
  it.each(targets)("requires actor-scoped data access for %s", async (path, params) => {
    const { db, queries } = harness([{ name: "Private label", title: "Private task" }]);
    try {
      await expect(targetFor(path)({ db }, params)).rejects.toThrow("withDataContext");
      expect(queries).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it.each(targets)("does not query missing or malformed ids for %s", async (path, params) => {
    const { db, scopedDb, queries } = harness();
    try {
      expect(await targetFor(path)(scopedDb, {})).toBeNull();
      for (const key of Object.keys(params)) {
        expect(await targetFor(path)(scopedDb, { ...params, [key]: "invalid" })).toBeNull();
      }
      expect(queries).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it.each(targets)("returns null when the scoped query cannot see %s", async (path, params) => {
    const { db, scopedDb } = harness();
    try {
      expect(await targetFor(path)(scopedDb, params)).toBeNull();
    } finally {
      await db.destroy();
    }
  });

  it("reads the list's name, constrained to the requested list", async () => {
    const { db, scopedDb, queries } = harness([{ name: "Personal" }]);
    try {
      expect(await targetFor(targets[0][0])(scopedDb, { listId: id })).toBe("Personal");
      expect(queries[0]?.sql).toBe('select "name" from "app"."task_lists" where "id" = $1');
      expect(queries[0]?.parameters).toEqual([id]);
    } finally {
      await db.destroy();
    }
  });

  it("constrains a deleted tag to both its id and the route's list", async () => {
    const { db, scopedDb, queries } = harness([{ name: "Urgent" }]);
    try {
      expect(await targetFor(targets[1][0])(scopedDb, { listId: id, tagId })).toBe("Urgent");
      expect(queries[0]?.sql).toBe(
        'select "name" from "app"."task_tags" where "id" = $1 and "list_id" = $2'
      );
      expect(queries[0]?.parameters).toEqual([tagId, id]);
    } finally {
      await db.destroy();
    }
  });

  it("labels an existing tag assignment and constrains both target ids", async () => {
    const { db, scopedDb, queries } = harness([{ name: "Urgent", title: "Prepare report" }]);
    try {
      expect(await targetFor(targets[2][0])(scopedDb, { id, tagId })).toBe(
        "Urgent on Prepare report"
      );
      expect(queries[0]?.sql).toBe(
        'select "g"."name", "t"."title" from "app"."task_tag_assignments" as "a" ' +
          'inner join "app"."tasks" as "t" on "t"."id" = "a"."task_id" ' +
          'inner join "app"."task_tags" as "g" on "g"."id" = "a"."tag_id" ' +
          'where "a"."task_id" = $1 and "a"."tag_id" = $2'
      );
      expect(queries[0]?.parameters).toEqual([id, tagId]);
    } finally {
      await db.destroy();
    }
  });
});
