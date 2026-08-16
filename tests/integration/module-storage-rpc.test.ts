import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  DataContextRunner,
  createDatabase,
  createModuleStorageRpc,
  ensureModuleRoles,
  generateModuleTableRlsSql,
  ModuleQueryError,
  moduleRuntimeRoleName,
  type MossDatabase
} from "@moss/db";
import {
  connectionStrings,
  dropModuleRolesAtTeardown,
  grantModuleMembershipAtSetup,
  resetEmptyFoundationDatabase,
  revokeModuleMembershipAtTeardown
} from "./test-database.js";

const moduleId = "storage-rpc-fixture";

describe("createModuleStorageRpc", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    await ensureModuleRoles(connectionStrings.bootstrap, moduleId);

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        "CREATE TABLE IF NOT EXISTS app.storage_rpc_fixture_items " +
          "(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid NOT NULL, label text)"
      );
      for (const statement of generateModuleTableRlsSql(moduleId, [
        "app.storage_rpc_fixture_items"
      ])) {
        await client.query(statement);
      }
    } finally {
      await client.end();
    }

    // Membership writes pg_auth_members, which is cluster-global — locked (#1013).
    await grantModuleMembershipAtSetup([
      "GRANT jarvis_mod_storage_rpc_fixture_runtime TO jarvis_app_runtime WITH INHERIT FALSE"
    ]);

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb.destroy();

    // Cluster-global, and it must precede the per-database revokes below: Postgres refuses to
    // revoke a grant-option privilege while a dependent downstream grant still exists (#1013).
    await revokeModuleMembershipAtTeardown([
      "REVOKE jarvis_mod_storage_rpc_fixture_runtime FROM jarvis_app_runtime"
    ]);

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query("DROP TABLE IF EXISTS app.storage_rpc_fixture_items");
      // Revoke the runtime role's grants (sourced from the install role's WITH GRANT OPTION)
      // BEFORE revoking the install role's own — Postgres refuses to revoke a grant-option
      // privilege while a dependent downstream grant still exists.
      await client.query(
        "REVOKE ALL PRIVILEGES ON SCHEMA app FROM jarvis_mod_storage_rpc_fixture_runtime"
      );
      await client.query(
        "REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM jarvis_mod_storage_rpc_fixture_runtime"
      );
      await client.query(
        "REVOKE ALL PRIVILEGES ON SCHEMA app FROM jarvis_mod_storage_rpc_fixture_install"
      );
      await client.query(
        "REVOKE ALL PRIVILEGES ON app.users FROM jarvis_mod_storage_rpc_fixture_install"
      );
      await client.query(
        "REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM jarvis_mod_storage_rpc_fixture_install"
      );
      await dropModuleRolesAtTeardown([
        "jarvis_mod_storage_rpc_fixture_install",
        "jarvis_mod_storage_rpc_fixture_runtime"
      ]);
    } finally {
      await client.end();
    }
  });

  it("scopes queries to the calling module's runtime role under RLS", async () => {
    const owner = randomUUID();

    await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      await rpc.query(
        "INSERT INTO app.storage_rpc_fixture_items (owner_user_id, label) VALUES ($1, $2)",
        [owner, "mine"]
      );
      const result = await rpc.query<{ label: string }>(
        "SELECT label FROM app.storage_rpc_fixture_items WHERE owner_user_id = $1",
        [owner]
      );
      expect(result.rows).toEqual([{ label: "mine" }]);
    });

    const other = randomUUID();
    await dataContext.withDataContext({ actorUserId: other }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      const result = await rpc.query("SELECT label FROM app.storage_rpc_fixture_items");
      expect(result.rows).toEqual([]); // RLS hides the other actor's row
    });
  });

  it("binds the runtime role during the call and resets it after", async () => {
    const owner = randomUUID();
    await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      const bound = await rpc.query<{ current_user: string }>("SELECT current_user");
      expect(bound.rows[0]?.current_user).toBe(moduleRuntimeRoleName(moduleId));

      const after = await sql<{ current_user: string }>`select current_user`.execute(scopedDb.db);
      expect(after.rows[0]?.current_user).toBe("jarvis_app_runtime");
    });
  });

  // ---- #1167 D5 bounds ---------------------------------------------------------------

  it("rejects non-allowlisted statements before they reach Postgres", async () => {
    const owner = randomUUID();
    await expect(
      dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId);
        await rpc.query("TRUNCATE app.storage_rpc_fixture_items");
      })
    ).rejects.toMatchObject({ name: "ModuleQueryError", code: "forbidden_statement" });
  });

  it("rejects set_config even wrapped in an allowed SELECT (RLS GUC spoofing)", async () => {
    const owner = randomUUID();
    await expect(
      dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId);
        await rpc.query("SELECT set_config('app.actor_user_id', $1, true)", [randomUUID()]);
      })
    ).rejects.toMatchObject({ code: "forbidden_statement" });
    await expect(
      dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId);
        await rpc.query("WITH s AS (SELECT set_config('role', 'postgres', true)) SELECT 1");
      })
    ).rejects.toMatchObject({ code: "forbidden_statement" });
  });

  it("readOnly blocks plain mutations AND data-modifying CTEs", async () => {
    const owner = randomUUID();
    // Plant one row through the write path first.
    await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      await rpc.query(
        "INSERT INTO app.storage_rpc_fixture_items (owner_user_id, label) VALUES ($1, $2)",
        [owner, "survives-readonly"]
      );
    });
    await expect(
      dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId, { readOnly: true });
        await rpc.query(
          "INSERT INTO app.storage_rpc_fixture_items (owner_user_id, label) VALUES ($1, $2)",
          [owner, "blocked"]
        );
      })
    ).rejects.toMatchObject({ name: "ModuleQueryError", code: "forbidden_mutation" });
    await expect(
      dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId, { readOnly: true });
        await rpc.query(
          "WITH d AS (DELETE FROM app.storage_rpc_fixture_items RETURNING id) SELECT * FROM d"
        );
      })
    ).rejects.toMatchObject({ code: "forbidden_mutation" });
    // The CTE delete really did not run.
    await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId, { readOnly: true });
      const rows = await rpc.query(
        "SELECT label FROM app.storage_rpc_fixture_items WHERE owner_user_id = $1",
        [owner]
      );
      expect(rows.rows).toEqual([{ label: "survives-readonly" }]);
    });
  });

  it("enforces statement_timeout as db_query_failed with SQLSTATE 57014", async () => {
    const owner = randomUUID();
    await expect(
      dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId, { statementTimeoutMs: 200 });
        await rpc.query("SELECT pg_sleep(1)");
      })
    ).rejects.toMatchObject({
      name: "ModuleQueryError",
      code: "db_query_failed",
      sqlstate: "57014"
    });
  });

  it("enforces rowCap (error, not truncation) and resultByteCap", async () => {
    const owner = randomUUID();
    await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      await rpc.query(
        "INSERT INTO app.storage_rpc_fixture_items (owner_user_id, label) SELECT $1, 'row-' || n FROM generate_series(1, 3) AS n",
        [owner]
      );
    });
    await expect(
      dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId, { rowCap: 2 });
        await rpc.query("SELECT * FROM app.storage_rpc_fixture_items WHERE owner_user_id = $1", [
          owner
        ]);
      })
    ).rejects.toMatchObject({ code: "row_cap_exceeded" });
    await expect(
      dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId, { resultByteCap: 1024 });
        await rpc.query("SELECT repeat('x', 5000) AS blob");
      })
    ).rejects.toMatchObject({ code: "result_byte_cap_exceeded" });
  });

  it("null bounds disable every cap (export escape hatch)", async () => {
    const owner = randomUUID();
    await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId, {
        statementTimeoutMs: null,
        rowCap: null,
        resultByteCap: null
      });
      // Would trip a rowCap of 2 and a small byteCap; must pass with nulls.
      const rows = await rpc.query<{ blob: string }>(
        "SELECT repeat('x', 5000) AS blob FROM generate_series(1, 3)"
      );
      expect(rows.rows).toHaveLength(3);
    });
  });

  it("redacts driver errors: keeps SQLSTATE + primary message, drops pg detail", async () => {
    const owner = randomUUID();
    const marker = randomUUID();
    await dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
      const rpc = createModuleStorageRpc(scopedDb, moduleId);
      await rpc.query(
        "INSERT INTO app.storage_rpc_fixture_items (id, owner_user_id, label) VALUES ($1, $2, $3)",
        [marker, owner, "first"]
      );
    });
    let caught: ModuleQueryError | undefined;
    await dataContext
      .withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId);
        await rpc.query(
          "INSERT INTO app.storage_rpc_fixture_items (id, owner_user_id, label) VALUES ($1, $2, $3)",
          [marker, owner, "duplicate"]
        );
      })
      .catch((error: ModuleQueryError) => {
        caught = error;
      });
    expect(caught).toBeInstanceOf(ModuleQueryError);
    expect(caught?.code).toBe("db_query_failed");
    expect(caught?.sqlstate).toBe("23505");
    // pg's DETAIL line ("Key (id)=(<uuid>) already exists.") carries row data —
    // the redaction contract is that it never reaches the error message.
    expect(caught?.message).not.toContain(marker);
  });

  it("rejects multi-statement input at the classifier (simple-protocol guard)", async () => {
    const owner = randomUUID();
    await expect(
      dataContext.withDataContext({ actorUserId: owner }, async (scopedDb) => {
        const rpc = createModuleStorageRpc(scopedDb, moduleId);
        await rpc.query("SELECT 1; DELETE FROM app.storage_rpc_fixture_items");
      })
    ).rejects.toMatchObject({ code: "forbidden_statement" });
  });
});
