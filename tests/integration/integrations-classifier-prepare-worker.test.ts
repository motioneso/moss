import { sql, type Kysely } from "kysely";
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
  effectiveClassifierTools,
  IntegrationsRepository,
  runClassifierPreparationJob,
  toolRiskInputs,
  toolSortFingerprint,
  type ClassifierPreparationPort,
  type ConnectionRow,
  type DiscoveredTool
} from "@moss/integrations";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const repository = new IntegrationsRepository();
const cipher = createIntegrationsCipher();
const CREDENTIAL = "prepare-worker-credential-9X";

function tool(name: string): DiscoveredTool {
  return {
    name,
    description: `Does ${name}`,
    group: "Home",
    inputSchema: { type: "object", properties: { id: { type: "string" } } }
  };
}

function context(actorUserId: string): AccessContext {
  return { actorUserId, requestId: `req:classifier-prepare-worker:${actorUserId}` };
}

describe("integrations classifier preparation worker (#2984 R2.4)", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let app: DataContextRunner;
  let worker: DataContextRunner;
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
        object: { description: "Turn the lamp on", replyTemplate: "{summary}" },
        usage: { inputTokens: 1, outputTokens: 1 }
      };
    }
  };

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

  /** A connection with its classifier switch on and every tool sorted, ready to prepare. */
  async function sortedConnection(
    actorUserId: string,
    name: string,
    tools: readonly DiscoveredTool[]
  ): Promise<ConnectionRow> {
    const created = await as(app, actorUserId, async (scopedDb) => {
      const row = await repository.createConnection(scopedDb, {
        name,
        kind: "mcp",
        url: "https://mcp.example.com",
        baseUrl: null,
        specPasted: false,
        credentialEnvelope: cipher.encryptJson({ secret: CREDENTIAL }),
        credentialPlacement: { kind: "bearer" }
      });
      await repository.saveDiscovery(scopedDb, row.id, [...tools], null);
      await repository.updateConnection(scopedDb, row.id, { classifierEnabled: true });
      return row;
    });
    await as(worker, actorUserId, (scopedDb) =>
      repository.saveClassifierToolSorts(
        scopedDb,
        created.id,
        tools.map((t) => ({
          toolName: t.name,
          result: {
            status: "current" as const,
            risk: "write" as const,
            readableName: "Readable",
            sortFingerprint: toolSortFingerprint(toolRiskInputs(t)),
            sortedAt: new Date().toISOString()
          }
        }))
      )
    );
    return (await as(app, actorUserId, (scopedDb) =>
      repository.getConnection(scopedDb, created.id)
    ))!;
  }

  function prepare(actorUserId: string, connectionId: string) {
    return runClassifierPreparationJob(
      { dataContext: worker, port, cipherSources: { cipher } },
      context(actorUserId),
      connectionId,
      "prepare"
    );
  }

  it("prepares its owner's tools through the worker role and makes them eligible", async () => {
    const conn = await sortedConnection(ids.userA, "Prepare owner A", [tool("lamp_on")]);
    expect(effectiveClassifierTools(conn)).toEqual([]);

    expect(await prepare(ids.userA, conn.id)).toEqual({
      status: "prepared",
      prepared: 1,
      failed: 0
    });
    const after = await as(app, ids.userA, (scopedDb) =>
      repository.getConnection(scopedDb, conn.id)
    );
    expect(effectiveClassifierTools(after!).map((t) => t.tool.name)).toEqual(["lamp_on"]);
    for (const prompt of prompts) expect(prompt).not.toContain(CREDENTIAL);
  });

  it("never prepares or releases another owner's tool", async () => {
    const conn = await sortedConnection(ids.userB, "Prepare owner B", [tool("door_lock")]);
    const callsBefore = prompts.length;

    for (const other of [ids.userA, ids.adminUser]) {
      expect(await prepare(other, conn.id)).toEqual({ status: "switched_off" });
    }
    expect(prompts.length).toBe(callsBefore);

    // A worker in another owner's context cannot write the preparation column directly either.
    for (const other of [ids.userA, ids.adminUser]) {
      const updated = await as(worker, other, async (scopedDb) =>
        Number(
          (
            await sql`
              UPDATE app.integration_connections
              SET classifier_preparation = classifier_preparation
              WHERE id = ${conn.id}::uuid
            `.execute(scopedDb.db)
          ).numAffectedRows
        )
      );
      expect(updated).toBe(0);
    }

    const after = await as(app, ids.userB, (scopedDb) =>
      repository.getConnection(scopedDb, conn.id)
    );
    expect(after!.classifierPreparation.entries).toEqual({});
    expect(effectiveClassifierTools(after!)).toEqual([]);
  });

  it("gives the worker no write on columns other than sort and preparation", async () => {
    const conn = await sortedConnection(ids.userA, "Prepare column guard", [tool("fan_on")]);
    await expect(
      as(worker, ids.userA, (scopedDb) =>
        sql`
          UPDATE app.integration_connections
          SET classifier_kept_out_tools = '{}'::text[]
          WHERE id = ${conn.id}::uuid
        `.execute(scopedDb.db)
      )
    ).rejects.toThrow(/permission denied/);
  });
});
