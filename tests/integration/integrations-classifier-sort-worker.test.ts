import pg from "pg";
import { sql, type Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  DataContextRunner,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import {
  createIntegrationsCipher,
  INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
  INTEGRATION_CLASSIFIER_SORT_QUEUE,
  IntegrationsRepository,
  registerClassifierSortWorkers,
  runClassifierSortJob,
  sortEntry,
  sweepClassifierSorts,
  toolRiskInputs,
  toolSortFingerprint,
  type ClassifierPreparationPort,
  type ClassifierSortResult,
  type ConnectionRow,
  type DiscoveredTool
} from "@moss/integrations";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const repository = new IntegrationsRepository();
const cipher = createIntegrationsCipher();
const CREDENTIAL = "worker-test-credential-7Q";

function tool(name: string, overrides: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name,
    description: `Does ${name}`,
    group: "Home",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    ...overrides
  };
}

function context(actorUserId: string): AccessContext {
  return { actorUserId, requestId: `req:classifier-sort-worker:${actorUserId}` };
}

function sortedAs(t: DiscoveredTool, risk: "read" | "write" = "write"): ClassifierSortResult {
  return {
    status: "current",
    risk,
    readableName: "Readable",
    sortFingerprint: toolSortFingerprint(toolRiskInputs(t)),
    sortedAt: new Date().toISOString()
  };
}

describe("integrations classifier sorting worker (#2984 R2.2)", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let app: DataContextRunner;
  let worker: DataContextRunner;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    app = new DataContextRunner(appDb);
    worker = new DataContextRunner(workerDb);
  });

  afterAll(async () => {
    await appDb.destroy();
    await workerDb.destroy();
  });

  function as<T>(
    runner: DataContextRunner,
    actorUserId: string,
    run: (scopedDb: DataContextDb) => Promise<T>
  ): Promise<T> {
    return runner.withDataContext(context(actorUserId), run);
  }

  async function createConnection(
    actorUserId: string,
    name: string,
    tools: readonly DiscoveredTool[],
    credential: string | null = null
  ): Promise<ConnectionRow> {
    return as(app, actorUserId, async (scopedDb) => {
      const created = await repository.createConnection(scopedDb, {
        name,
        kind: "mcp",
        url: "https://mcp.example.com",
        baseUrl: null,
        specPasted: false,
        credentialEnvelope: credential === null ? null : cipher.encryptJson({ secret: credential }),
        credentialPlacement: credential === null ? null : { kind: "bearer" }
      });
      await repository.saveDiscovery(scopedDb, created.id, [...tools], null);
      return (await repository.getConnection(scopedDb, created.id))!;
    });
  }

  it("lets the worker write its owner's sort and nothing else", async () => {
    const light = tool("light_on");
    const conn = await createConnection(ids.userA, "Worker owner A", [light]);

    const saved = await as(worker, ids.userA, (scopedDb) =>
      repository.saveClassifierToolSorts(scopedDb, conn.id, [
        { toolName: light.name, result: sortedAs(light) }
      ])
    );
    expect(sortEntry(saved!.classifierSort, light.name)).toMatchObject({ status: "current" });

    for (const other of [ids.userB, ids.adminUser]) {
      expect(
        await as(worker, other, (scopedDb) =>
          repository.saveClassifierToolSorts(scopedDb, conn.id, [
            { toolName: light.name, result: sortedAs(light, "read") }
          ])
        )
      ).toBeNull();
    }
    const after = await as(app, ids.userA, (scopedDb) =>
      repository.getConnection(scopedDb, conn.id)
    );
    expect(sortEntry(after!.classifierSort, light.name)).toMatchObject({ risk: "write" });

    await expect(
      as(worker, ids.userA, (scopedDb) =>
        sql`
          UPDATE app.integration_connections SET name = 'renamed by worker' WHERE id = ${conn.id}
        `.execute(scopedDb.db)
      )
    ).rejects.toThrow(/permission denied/);
  });

  it("limits the worker's write rule to the owner even where the read rule does not apply", async () => {
    await createConnection(ids.userA, "Write rule owner A", [tool("a")]);
    await createConnection(ids.userB, "Write rule owner B", [tool("b")]);
    const ownRows = await as(app, ids.userB, async (scopedDb) =>
      Number(
        (
          await sql<{ count: string }>`
            SELECT count(*) AS count FROM app.integration_connections
          `.execute(scopedDb.db)
        ).rows[0]!.count
      )
    );

    // No WHERE or RETURNING, so Postgres checks only the write rule, not the read rule.
    const updated = await as(worker, ids.userB, async (scopedDb) =>
      Number(
        (await sql`UPDATE app.integration_connections SET updated_at = now()`.execute(scopedDb.db))
          .numAffectedRows
      )
    );
    expect(updated).toBe(ownRows);
  });

  it("sorts an owner's connection end to end and holds back a tool carrying the credential", async () => {
    const leaky = tool("leaky", { description: `Uses ${CREDENTIAL} to sign in` });
    const conn = await createConnection(
      ids.userA,
      "Worker end to end",
      [tool("lamp"), leaky],
      CREDENTIAL
    );
    const prompts: string[] = [];
    const port: ClassifierPreparationPort = {
      selectDefaultChatModel: async () => ({
        model: { id: "m", providerConfigId: "p", providerKind: "k", providerModelId: "x" },
        structured: true
      }),
      runStructuredDraft: async (_db, input) => {
        prompts.push(input.prompt);
        return {
          ok: true,
          object: { tools: [{ id: "t1", group: "changes_things", name: "Turn the lamp on" }] },
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      }
    };

    const outcome = await runClassifierSortJob(
      { dataContext: worker, port, cipherSources: { cipher } },
      context(ids.userA),
      conn.id,
      "sort"
    );

    expect(outcome).toMatchObject({ status: "sorted", calls: 1, written: 2 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(CREDENTIAL);
    expect(prompts[0]).not.toContain("mcp.example.com");
    const row = await as(app, ids.userA, (scopedDb) => repository.getConnection(scopedDb, conn.id));
    expect(sortEntry(row!.classifierSort, "lamp")).toMatchObject({
      status: "current",
      risk: "write",
      readableName: "Turn the lamp on"
    });
    expect(sortEntry(row!.classifierSort, "leaky")).toMatchObject({
      status: "failed",
      failure: "unsafe"
    });

    // Another owner's job cannot reach this connection at all.
    expect(
      await runClassifierSortJob(
        { dataContext: worker, port, cipherSources: { cipher } },
        context(ids.userB),
        conn.id,
        "sort"
      )
    ).toEqual({ status: "nothing_to_sort" });
  });

  it("queues a preparation run for the same owner and connection after each sort", async () => {
    const lamp = tool("lamp");
    const conn = await createConnection(ids.userA, "Worker queues preparation", [lamp]);
    const port: ClassifierPreparationPort = {
      selectDefaultChatModel: async () => ({
        model: { id: "m", providerConfigId: "p", providerKind: "k", providerModelId: "x" },
        structured: true
      }),
      runStructuredDraft: async () => ({
        ok: true,
        object: { tools: [{ id: "t1", group: "changes_things", name: "Turn the lamp on" }] },
        usage: { inputTokens: 1, outputTokens: 1 }
      })
    };

    type Handler = (jobs: readonly unknown[]) => Promise<void>;
    const handlers = new Map<string, Handler>();
    const sent: { queue: string; data: unknown; options: unknown }[] = [];
    const boss = {
      work: async (queue: string, _options: unknown, handler: Handler) => {
        handlers.set(queue, handler);
        return `worker:${queue}`;
      },
      send: async (queue: string, data: unknown, options: unknown) => {
        sent.push({ queue, data, options });
        return "job";
      }
    } as unknown as PgBoss;

    await registerClassifierSortWorkers(boss, {
      dataContext: worker,
      port,
      cipherSources: { cipher },
      rootDb: workerDb
    });
    sent.length = 0;

    await handlers.get(INTEGRATION_CLASSIFIER_SORT_QUEUE)!([
      { id: "job-1", data: { actorUserId: ids.userA, resourceId: conn.id, op: "sort" } }
    ]);

    const row = await as(app, ids.userA, (scopedDb) => repository.getConnection(scopedDb, conn.id));
    expect(sortEntry(row!.classifierSort, "lamp")).toMatchObject({ status: "current" });
    expect(sent).toEqual([
      {
        queue: INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
        data: { actorUserId: ids.userA, resourceId: conn.id, op: "prepare" },
        options: { singletonKey: `classifier-prepare:${conn.id}` }
      }
    ]);
  });

  it("sweeps existing connections with unsorted tools, by id only, once each", async () => {
    const unsorted = await createConnection(ids.userB, "Sweep unsorted", [tool("a"), tool("b")]);
    const done = tool("done");
    const sorted = await createConnection(ids.userB, "Sweep sorted", [done]);
    await as(worker, ids.userB, (scopedDb) =>
      repository.saveClassifierToolSorts(scopedDb, sorted.id, [
        { toolName: done.name, result: sortedAs(done) }
      ])
    );

    const listed = (
      await sql<Record<string, string>>`
        SELECT * FROM app.list_integration_connections_needing_sort()
      `.execute(workerDb)
    ).rows;
    for (const row of listed) {
      expect(Object.keys(row).sort()).toEqual(["connection_id", "owner_user_id"]);
    }
    const listedIds = listed.map((row) => row.connection_id);
    expect(listedIds).toContain(unsorted.id);
    expect(listedIds).not.toContain(sorted.id);

    const sent: { data: Record<string, unknown>; options: { singletonKey: string } }[] = [];
    const boss = {
      send: async (
        _queue: string,
        data: Record<string, unknown>,
        options: { singletonKey: string }
      ) => {
        sent.push({ data, options });
        return "job";
      }
    } as unknown as PgBoss;
    const count = await sweepClassifierSorts(boss, workerDb);

    expect(count).toBe(listed.length);
    const keys = sent.map((s) => s.options.singletonKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sent).toContainEqual({
      data: { actorUserId: ids.userB, resourceId: unsorted.id, op: "sort" },
      options: { singletonKey: `classifier-sort:${unsorted.id}` }
    });
  });

  it("keeps the sweep listing away from the app runtime", async () => {
    const client = new Client({ connectionString: connectionStrings.app });
    await client.connect();
    try {
      await expect(
        client.query("SELECT * FROM app.list_integration_connections_needing_sort()")
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });
});
