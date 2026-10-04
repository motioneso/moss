import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  createDatabase,
  DataContextRunner,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import {
  IntegrationsRepository,
  toolRiskInputs,
  toolSortFingerprint,
  toolSortState,
  type ClassifierSortResult,
  type ConnectionRow,
  type DiscoveredTool
} from "@moss/integrations";
import type { IntegrationClassifierRisk } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const conversionSql = readFileSync(
  join(root, "packages/integrations/sql/0269_integration_classifier_sort_convert.sql"),
  "utf8"
);

const repository = new IntegrationsRepository();

const BROADCAST: DiscoveredTool = {
  name: "HassBroadcast",
  description: "Broadcast a message through the home.",
  group: "",
  inputSchema: { type: "object", properties: { message: { type: "string" } } }
};

function webTool(method: string): DiscoveredTool {
  return {
    name: "updateMovie",
    description: "Change a movie",
    group: "Movies",
    inputSchema: { type: "object", properties: { id: { type: "integer" } } },
    invoke: { method, path: "/api/v3/movie/{id}", params: [], hasBody: false }
  };
}

function context(actorUserId: string): AccessContext {
  return { actorUserId, requestId: `req:classifier-sort:${actorUserId}` };
}

function sortedAs(tool: DiscoveredTool, risk: IntegrationClassifierRisk): ClassifierSortResult {
  return {
    status: "current",
    risk,
    readableName: "Announce through the house",
    sortFingerprint: toolSortFingerprint(toolRiskInputs(tool)),
    sortedAt: new Date().toISOString()
  };
}

describe("integrations classifier sort storage and conversion (#2984 R2.1)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let seedClient: pg.Client;
  let migrationClient: pg.Client;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    seedClient = new Client({ connectionString: connectionStrings.bootstrap });
    await seedClient.connect();
    migrationClient = new Client({ connectionString: connectionStrings.migration });
    await migrationClient.connect();
  });

  afterAll(async () => {
    await seedClient.end();
    await migrationClient.end();
    await appDb.destroy();
  });

  function as<T>(actorUserId: string, run: (scopedDb: DataContextDb) => Promise<T>): Promise<T> {
    return dataContext.withDataContext(context(actorUserId), run);
  }

  async function createConnection(
    actorUserId: string,
    name: string,
    tools: readonly DiscoveredTool[]
  ): Promise<ConnectionRow> {
    return as(actorUserId, async (scopedDb) => {
      const created = await repository.createConnection(scopedDb, {
        name,
        kind: "mcp",
        url: "https://mcp.example.com",
        baseUrl: null,
        specPasted: false,
        credentialEnvelope: null,
        credentialPlacement: null
      });
      await repository.saveDiscovery(scopedDb, created.id, [...tools], null);
      return (await repository.getConnection(scopedDb, created.id))!;
    });
  }

  it("starts every tool never tried, with nothing kept out", async () => {
    const conn = await createConnection(ids.userA, "Sort defaults", [BROADCAST]);
    expect(conn.classifierSort.entries).toEqual({});
    expect(conn.classifierKeptOutTools).toEqual([]);
    expect(toolSortState(conn.classifierSort, BROADCAST)).toEqual({ status: "never_tried" });
  });

  it("keeps sort records owner-only: another owner and an admin can neither read nor write them", async () => {
    const conn = await createConnection(ids.userA, "Sort owner A", [BROADCAST]);
    const saved = await as(ids.userA, (scopedDb) =>
      repository.saveClassifierToolSorts(scopedDb, conn.id, [
        { toolName: BROADCAST.name, result: sortedAs(BROADCAST, "outbound") }
      ])
    );
    expect(toolSortState(saved!.classifierSort, BROADCAST)).toMatchObject({
      status: "current",
      risk: "outbound"
    });

    for (const other of [ids.userB, ids.adminUser]) {
      expect(await as(other, (scopedDb) => repository.getConnection(scopedDb, conn.id))).toBeNull();
      expect(
        await as(other, (scopedDb) =>
          repository.saveClassifierToolSorts(scopedDb, conn.id, [
            { toolName: BROADCAST.name, result: sortedAs(BROADCAST, "read") }
          ])
        )
      ).toBeNull();
      expect(
        await as(other, (scopedDb) =>
          repository.setClassifierSendWithoutAsking(scopedDb, conn.id, [BROADCAST.name], true)
        )
      ).toEqual({ status: "not_found" });
      expect(
        await as(other, (scopedDb) =>
          repository.setClassifierToolsKeptOut(scopedDb, conn.id, [BROADCAST.name], true)
        )
      ).toEqual({ status: "not_found" });
    }

    // Owner B's own sort records are equally invisible to owner A.
    const connB = await createConnection(ids.userB, "Sort owner B", [BROADCAST]);
    expect(
      await as(ids.userA, (scopedDb) => repository.getConnection(scopedDb, connB.id))
    ).toBeNull();

    const reread = await as(ids.userA, (scopedDb) => repository.getConnection(scopedDb, conn.id));
    expect(toolSortState(reread!.classifierSort, BROADCAST)).toEqual({
      status: "current",
      risk: "outbound",
      readableName: "Announce through the house",
      sendWithoutAsking: false,
      sortedAt: expect.any(String),
      sortedBy: null
    });
    expect(reread!.classifierKeptOutTools).toEqual([]);
  });

  it("stores keep-out and the send choice, and discovery clears a choice whose sort went stale", async () => {
    const put = webTool("PUT");
    const conn = await createConnection(ids.userA, "Sort send choice", [put]);
    await as(ids.userA, (scopedDb) =>
      repository.saveClassifierToolSorts(scopedDb, conn.id, [
        { toolName: put.name, result: sortedAs(put, "outbound") }
      ])
    );
    const allowed = await as(ids.userA, (scopedDb) =>
      repository.setClassifierSendWithoutAsking(scopedDb, conn.id, [put.name], true)
    );
    expect(allowed.status).toBe("saved");
    if (allowed.status !== "saved") return;
    expect(toolSortState(allowed.connection.classifierSort, put)).toMatchObject({
      sendWithoutAsking: true
    });

    const keptOut = await as(ids.userA, (scopedDb) =>
      repository.setClassifierToolsKeptOut(scopedDb, conn.id, [put.name], true)
    );
    expect(keptOut.status === "saved" && keptOut.connection.classifierKeptOutTools).toEqual([
      put.name
    ]);

    // The method changes to DELETE and back: the choice does not come back with it.
    for (const method of ["DELETE", "PUT"]) {
      await as(ids.userA, (scopedDb) =>
        repository.saveDiscovery(scopedDb, conn.id, [webTool(method)], null)
      );
    }
    const after = await as(ids.userA, (scopedDb) => repository.getConnection(scopedDb, conn.id));
    expect(toolSortState(after!.classifierSort, put)).toMatchObject({
      status: "current",
      sendWithoutAsking: false
    });
    expect(after!.classifierKeptOutTools).toEqual([put.name]);

    const sensitive = await as(ids.userA, async (scopedDb) => {
      await repository.saveClassifierToolSorts(scopedDb, conn.id, [
        { toolName: put.name, result: sortedAs(put, "destructive") }
      ]);
      return repository.setClassifierSendWithoutAsking(scopedDb, conn.id, [put.name], true);
    });
    expect(sensitive).toEqual({ status: "refused", toolName: put.name });
  });

  it("keeps the send choice in storage when an old reviewed risk raises the sort to outbound", async () => {
    const conn = await createConnection(ids.userA, "Sort floor send choice", [BROADCAST]);
    await seedClient.query(
      `UPDATE app.integration_connections SET classifier_sort = $2::jsonb WHERE id = $1`,
      [
        conn.id,
        JSON.stringify({
          version: 1,
          entries: { [BROADCAST.name]: { status: "never_tried", legacyRiskFloor: "outbound" } }
        })
      ]
    );

    const allowed = await as(ids.userA, async (scopedDb) => {
      await repository.saveClassifierToolSorts(scopedDb, conn.id, [
        { toolName: BROADCAST.name, result: sortedAs(BROADCAST, "write") }
      ]);
      return repository.setClassifierSendWithoutAsking(scopedDb, conn.id, [BROADCAST.name], true);
    });
    expect(allowed.status).toBe("saved");
    if (allowed.status !== "saved") return;
    expect(toolSortState(allowed.connection.classifierSort, BROADCAST)).toMatchObject({
      risk: "outbound",
      sendWithoutAsking: true
    });

    const reread = await as(ids.userA, (scopedDb) => repository.getConnection(scopedDb, conn.id));
    expect(toolSortState(reread!.classifierSort, BROADCAST)).toMatchObject({
      risk: "outbound",
      sendWithoutAsking: true
    });
  });

  it("converts old entries once: opt-in off becomes kept out, a reviewed risk only raises", async () => {
    const tools = [
      { ...BROADCAST, name: "opted_out" },
      { ...BROADCAST, name: "reviewed_high" },
      { ...BROADCAST, name: "reviewed_low" },
      { ...BROADCAST, name: "never_reviewed" }
    ];
    const entry = (optIn: boolean, reviewedRisk: string | null) => ({
      optIn,
      reviewedRisk,
      description: "Prepared",
      arguments: {},
      replyTemplate: "Done.",
      definitionFingerprint: "sha256:old",
      reviewedAt: "2026-10-01T00:00:00.000Z",
      preparationVersion: 1
    });
    const preparation = {
      version: 1,
      entries: {
        opted_out: entry(false, null),
        reviewed_high: entry(true, "destructive"),
        reviewed_low: entry(true, "read")
      }
    };
    const { rows } = await seedClient.query<{ id: string }>(
      `INSERT INTO app.integration_connections
         (owner_user_id, name, kind, url, discovered_tools, classifier_preparation)
       VALUES ($1, 'Sort conversion', 'mcp', 'https://mcp.example.com', $2::jsonb, $3::jsonb)
       RETURNING id`,
      [ids.userA, JSON.stringify(tools), JSON.stringify(preparation)]
    );
    const id = rows[0]!.id;
    const untouched = await createConnection(ids.userB, "Sort conversion untouched", [BROADCAST]);

    await migrationClient.query(conversionSql);
    // Running it again changes nothing.
    await migrationClient.query(conversionSql);

    const converted = await as(ids.userA, (scopedDb) => repository.getConnection(scopedDb, id));
    expect(converted!.classifierKeptOutTools).toEqual(["opted_out"]);
    for (const tool of tools) {
      expect(toolSortState(converted!.classifierSort, tool)).toEqual({ status: "never_tried" });
    }
    // The old preparation stays readable until a later slice retires it.
    expect(Object.keys(converted!.classifierPreparation.entries).sort()).toEqual([
      "opted_out",
      "reviewed_high",
      "reviewed_low"
    ]);

    const resorted = await as(ids.userA, (scopedDb) =>
      repository.saveClassifierToolSorts(
        scopedDb,
        id,
        tools.map((tool) => ({ toolName: tool.name, result: sortedAs(tool, "write") }))
      )
    );
    const riskOf = (name: string) =>
      toolSortState(resorted!.classifierSort, tools.find((tool) => tool.name === name)!);
    expect(riskOf("reviewed_high")).toMatchObject({ risk: "destructive" });
    expect(riskOf("reviewed_low")).toMatchObject({ risk: "write" });
    expect(riskOf("never_reviewed")).toMatchObject({ risk: "write" });

    const other = await as(ids.userB, (scopedDb) =>
      repository.getConnection(scopedDb, untouched.id)
    );
    expect(other!.classifierKeptOutTools).toEqual([]);
    expect(other!.classifierSort.entries).toEqual({});
  });
});
