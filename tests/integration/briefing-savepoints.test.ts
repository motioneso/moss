import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

import { DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import type { MossModuleManifest, ToolExecute } from "@moss/module-sdk";

import { withToolSavepoint } from "../../packages/briefings/src/savepoint.js";
import { connectionStrings } from "./test-database.js";
import {
  makeComposeDeps,
  setupBriefingsHarness,
  teardownBriefingsHarness,
  userAContext,
  type BriefingsTestHarness
} from "./briefings.helpers.js";

// Briefing compose shares the worker job's single transaction. These tests run as
// jarvis_worker_runtime against real Postgres, where a swallowed database error aborts
// every later statement unless its step was wrapped in a savepoint.

// app.auth_sessions has no jarvis_worker_runtime grant, so this read is always denied.
const DENIED_READ = sql`select 1 from app.auth_sessions limit 1`;

const PROBE = "app.briefing_savepoint_probe";

function replaceTool(
  manifests: readonly MossModuleManifest[],
  toolName: string,
  execute: ToolExecute
): MossModuleManifest[] {
  return manifests.map((manifest) => ({
    ...manifest,
    assistantTools: manifest.assistantTools?.map((tool) =>
      tool.name === toolName ? { ...tool, execute } : tool
    )
  }));
}

describe("briefing savepoints on the worker transaction", () => {
  let harness: BriefingsTestHarness;
  let loggedDb: Kysely<MossDatabase>;
  let workerContext: DataContextRunner;
  const statements: string[] = [];

  beforeAll(async () => {
    harness = await setupBriefingsHarness();
    loggedDb = new Kysely<MossDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: connectionStrings.worker, max: 1 })
      }),
      log: (event) => {
        statements.push(event.query.sql);
      }
    });
    workerContext = new DataContextRunner(loggedDb);
  });

  afterAll(async () => {
    await loggedDb?.destroy();
    await teardownBriefingsHarness(harness ?? {});
  });

  async function readProbe(scopedDb: DataContextDb): Promise<string | null> {
    const result = await sql<{
      value: string | null;
    }>`select nullif(current_setting(${PROBE}, true), '') as value`.execute(scopedDb.db);
    return result.rows[0]?.value ?? null;
  }

  async function setProbe(scopedDb: DataContextDb, value: string): Promise<void> {
    await sql`select set_config(${PROBE}, ${value}, true)`.execute(scopedDb.db);
  }

  /** The savepoint name the helper used, read from the statements it issued. */
  function lastSavepointName(from: number): string {
    const opened = statements.slice(from).find((stmt) => stmt.startsWith("SAVEPOINT "));
    expect(opened).toBeDefined();
    return opened!.replace("SAVEPOINT ", "");
  }

  /** True once `name` no longer exists on the transaction (3B001 on rollback to it). */
  async function savepointGone(scopedDb: DataContextDb, name: string): Promise<boolean> {
    await sql.raw("SAVEPOINT cleanup_probe").execute(scopedDb.db);
    try {
      await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(scopedDb.db);
      return false;
    } catch (error) {
      await sql.raw("ROLLBACK TO SAVEPOINT cleanup_probe").execute(scopedDb.db);
      return (error as { code?: string }).code === "3B001";
    }
  }

  it("releases the savepoint and keeps the work on success", async () => {
    await workerContext.withDataContext(userAContext(), async (scopedDb) => {
      const from = statements.length;
      const result = await withToolSavepoint(scopedDb, async () => {
        await setProbe(scopedDb, "kept");
        return "ok";
      });
      const name = lastSavepointName(from);

      expect(result).toBe("ok");
      expect(statements.slice(from)).toContain(`RELEASE SAVEPOINT ${name}`);
      expect(statements.slice(from)).not.toContain(`ROLLBACK TO SAVEPOINT ${name}`);
      expect(await readProbe(scopedDb)).toBe("kept");
      expect(await savepointGone(scopedDb, name)).toBe(true);
    });
  });

  it("undoes a denied query, cleans up, and leaves the transaction usable", async () => {
    await workerContext.withDataContext(userAContext(), async (scopedDb) => {
      const from = statements.length;
      await expect(
        withToolSavepoint(scopedDb, async () => {
          await setProbe(scopedDb, "undone");
          await DENIED_READ.execute(scopedDb.db);
        })
      ).rejects.toMatchObject({ code: "42501" });
      const name = lastSavepointName(from);

      expect(statements.slice(from)).toContain(`ROLLBACK TO SAVEPOINT ${name}`);
      expect(await readProbe(scopedDb)).toBeNull();
      expect(await savepointGone(scopedDb, name)).toBe(true);
    });
  });

  it("undoes the work and cleans up when the step throws an ordinary error", async () => {
    await workerContext.withDataContext(userAContext(), async (scopedDb) => {
      const from = statements.length;
      await expect(
        withToolSavepoint(scopedDb, async () => {
          await setProbe(scopedDb, "undone");
          throw new Error("not a database error");
        })
      ).rejects.toThrow("not a database error");
      const name = lastSavepointName(from);

      expect(statements.slice(from)).toContain(`ROLLBACK TO SAVEPOINT ${name}`);
      expect(await readProbe(scopedDb)).toBeNull();
      expect(await savepointGone(scopedDb, name)).toBe(true);
    });
  });

  it("saves the run when a step's query is denied partway through the briefing", async () => {
    let laterStepRan = false;
    const manifests = replaceTool(
      replaceTool(getBuiltInModuleManifests(), "goals.list", async (scopedDb) => {
        await DENIED_READ.execute((scopedDb as DataContextDb).db);
        return { data: { goals: [] } };
      }),
      "news.topHeadlinesToday",
      async (scopedDb) => {
        // A real statement on the same transaction: it fails with 25P02 if the denied
        // goals read above was not rolled back.
        await sql`select 1`.execute((scopedDb as DataContextDb).db);
        laterStepRan = true;
        return { data: { facts: [{ text: "Later step headline" }] } };
      }
    );

    const definition = await harness.dataContext.withDataContext(userAContext(), (scopedDb) =>
      harness.repository.createDefinition(scopedDb, {
        title: "Savepoint morning briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
        selectedToolNames: ["tasks.list", "goals.list", "news.topHeadlinesToday"]
      })
    );

    const outcome = await workerContext.withDataContext(userAContext(), (scopedDb) =>
      harness.repository.generateRun(scopedDb, definition.id, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: makeComposeDeps(undefined, manifests)
      })
    );

    expect(laterStepRan).toBe(true);
    expect(outcome?.run.status).toBe("succeeded");
    const gaps = (outcome?.run.source_metadata as { gaps?: Array<Record<string, string>> }).gaps;
    expect(gaps).toContainEqual({ source: "goals", reason: "tool_failed" });
    expect(gaps).not.toContainEqual({ source: "news", reason: "tool_failed" });

    // Read back in a fresh transaction: the row only exists if the run's transaction committed.
    const stored = await workerContext.withDataContext(userAContext(), (scopedDb) =>
      scopedDb.db
        .selectFrom("app.briefing_runs")
        .select("status")
        .where("id", "=", outcome!.run.id)
        .execute()
    );
    expect(stored).toEqual([{ status: "succeeded" }]);
  });
});
