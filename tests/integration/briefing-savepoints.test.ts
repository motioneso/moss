import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

import { AiRepository } from "@moss/ai";
import { getConnectorSyncAt, ConnectorsRepository } from "@moss/connectors";
import type { DatasetClient } from "@moss/datasets";
import { DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import type { MossModuleManifest, ToolExecute } from "@moss/module-sdk";
import { configureNewsBriefingService, NewsPrefsRepository } from "@moss/news";

import { withToolSavepoint } from "../../packages/briefings/src/savepoint.js";
import { resolveChatFreshness } from "../../packages/chat/src/live/persistence.js";
import { NewsPersonalizationRepository } from "../../packages/news/src/personalization-repository.js";
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

  afterEach(() => {
    vi.restoreAllMocks();
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

  async function createDefinition(selectedToolNames: string[]): Promise<{ id: string }> {
    return harness.dataContext.withDataContext(userAContext(), (scopedDb) =>
      harness.repository.createDefinition(scopedDb, {
        title: "Savepoint morning briefing",
        scheduleMetadata: { targetTime: "07:00", timezone: "UTC" },
        selectedToolNames
      })
    );
  }

  async function readStoredRun(
    runId: string
  ): Promise<Array<{ status: string; source_metadata: unknown }>> {
    return workerContext.withDataContext(userAContext(), (scopedDb) =>
      scopedDb.db
        .selectFrom("app.briefing_runs")
        .select(["status", "source_metadata"])
        .where("id", "=", runId)
        .execute()
    );
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

  it("keeps the chat transaction usable after email and calendar freshness reads", async () => {
    const connectors = new ConnectorsRepository();
    await workerContext.withDataContext(userAContext(), async (scopedDb) => {
      const result = await resolveChatFreshness(
        scopedDb,
        new Set(["email.listVisibleMessages", "calendar.listVisibleEvents"]),
        new Date("2026-09-24T12:00:00.000Z"),
        { connectorSyncAt: (db, kind) => getConnectorSyncAt(connectors, db, kind) }
      );
      expect(result?.sources.map((source) => source.source)).toEqual(["email", "calendar"]);
      await setProbe(scopedDb, "chat-turn-saved");
      expect(await readProbe(scopedDb)).toBe("chat-turn-saved");
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

    const definition = await createDefinition([
      "tasks.list",
      "goals.list",
      "news.topHeadlinesToday"
    ]);

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
    const stored = await readStoredRun(outcome!.run.id);
    expect(stored.map((row) => row.status)).toEqual(["succeeded"]);
  });

  it("saves the plain-text fallback when the AI credential read is denied", async () => {
    const aiRepository = new AiRepository();
    // A configured model, so compose goes on to read its provider credential.
    vi.spyOn(aiRepository, "selectModelForCapability").mockResolvedValue({
      id: "savepoint-model",
      provider_config_id: "savepoint-provider",
      provider_kind: "openai-compatible",
      display_name: "Savepoint model",
      tier: "economy"
    } as unknown as Awaited<ReturnType<AiRepository["selectModelForCapability"]>>);
    vi.spyOn(aiRepository, "selectProviderWithCredential").mockImplementation(async (scopedDb) => {
      await DENIED_READ.execute(scopedDb.db);
      return undefined;
    });

    const definition = await createDefinition(["tasks.list"]);
    const outcome = await workerContext.withDataContext(userAContext(), (scopedDb) =>
      harness.repository.generateRun(scopedDb, definition.id, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "manual",
        composeDeps: { ...makeComposeDeps(), aiRepository }
      })
    );

    expect(outcome?.run.status).toBe("succeeded");
    const stored = await readStoredRun(outcome!.run.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe("succeeded");
    expect(stored[0]!.source_metadata).toMatchObject({ degradedReason: "credential_error" });
  });

  it("runs the real news tool's reads one at a time and survives a denied read", async () => {
    configureNewsBriefingService({
      async getDataset() {
        throw new Error("news feeds are not reached in this test");
      }
    } as DatasetClient);

    let inFlight = 0;
    let maxInFlight = 0;
    const reads: string[] = [];
    function track<P extends object>(proto: P, method: keyof P & string, deny = false): void {
      const original = proto[method] as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(proto, method as never).mockImplementation(async function (
        this: unknown,
        ...args: unknown[]
      ) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        reads.push(method);
        try {
          // Yield so any read started alongside this one is counted as in flight.
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (deny) await DENIED_READ.execute((args[0] as DataContextDb).db);
          return await original.apply(this, args);
        } finally {
          inFlight -= 1;
        }
      } as never);
    }
    track(NewsPrefsRepository.prototype, "list");
    track(NewsPersonalizationRepository.prototype, "listExclusions");
    track(NewsPersonalizationRepository.prototype, "listCustomSources");
    track(NewsPersonalizationRepository.prototype, "listCustomTopics");
    track(NewsPersonalizationRepository.prototype, "readLatestSnapshot", true);

    const definition = await createDefinition(["tasks.list", "news.topHeadlinesToday"]);
    const outcome = await workerContext.withDataContext(userAContext(), (scopedDb) =>
      harness.repository.generateRun(scopedDb, definition.id, {
        moduleManifests: getBuiltInModuleManifests(),
        runKind: "manual",
        composeDeps: makeComposeDeps()
      })
    );

    expect(reads).toEqual([
      "list",
      "listExclusions",
      "listCustomSources",
      "listCustomTopics",
      "readLatestSnapshot"
    ]);
    expect(maxInFlight).toBe(1);
    expect(outcome?.run.status).toBe("succeeded");
    const gaps = (outcome?.run.source_metadata as { gaps?: Array<Record<string, string>> }).gaps;
    expect(gaps).toContainEqual({ source: "news", reason: "tool_failed" });
    const stored = await readStoredRun(outcome!.run.id);
    expect(stored.map((row) => row.status)).toEqual(["succeeded"]);
  });
});
