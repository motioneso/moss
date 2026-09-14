import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import { createActiveModulesResolver } from "@moss/module-registry";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import type { MossModuleManifest } from "@moss/module-sdk";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import type { BriefingsRepository } from "@moss/briefings";
import type { ComposeDeps } from "@moss/briefings";

import { connectionStrings, ids } from "./test-database.js";
import {
  makeComposeDeps,
  setupBriefingsHarness,
  teardownBriefingsHarness,
  userAContext,
  userAHeaders,
  type BriefingsTestHarness
} from "./briefings.helpers.js";

describe("briefing source inclusion boundary", () => {
  let appDb: Kysely<MossDatabase>;
  let gateDb: Kysely<MossDatabase> | undefined;
  let workerDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: BriefingsRepository;
  let appBoss: PgBoss;
  let workerBoss: PgBoss;
  let server: BriefingsTestHarness["server"];

  beforeAll(async () => {
    const harness = await setupBriefingsHarness();
    appDb = harness.appDb;
    workerDb = harness.workerDb;
    dataContext = harness.dataContext;
    repository = harness.repository;
    appBoss = harness.appBoss;
    workerBoss = harness.workerBoss;
    server = harness.server;
  });

  afterAll(async () => {
    await teardownBriefingsHarness({ server, appBoss, workerBoss, appDb, workerDb });
    await gateDb?.destroy();
  });

  async function storedToolNames(definitionId: string): Promise<unknown> {
    return dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const row = await repository.getDefinitionById(scopedDb, definitionId);
      return row?.selected_tool_names;
    });
  }

  it("stores an explicit empty tool list end to end", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/briefings/definitions",
      headers: userAHeaders(),
      payload: { title: "No-source briefing", selectedToolNames: [] }
    });
    expect(response.statusCode).toBe(201);
    const created = (response.json() as { definition: { id: string } }).definition;
    expect(await storedToolNames(created.id)).toEqual([]);
  });

  it("uses the morning default with news and sports when create omits the list", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/briefings/definitions",
      headers: userAHeaders(),
      payload: { title: "Default-source briefing" }
    });
    expect(response.statusCode).toBe(201);
    const created = (response.json() as { definition: { id: string } }).definition;
    const stored = (await storedToolNames(created.id)) as string[];
    expect(stored).toContain("news.topHeadlinesToday");
    expect(stored).toContain("sports.followedFactsToday");
  });

  it("keeps the stored list when PATCH omits it", async () => {
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Keep-list briefing",
        selectedToolNames: ["tasks.list", "sports.followedFactsToday"]
      })
    );
    const response = await server.inject({
      method: "PATCH",
      url: `/api/briefings/definitions/${created.id}`,
      headers: userAHeaders(),
      payload: { title: "Keep-list briefing, renamed" }
    });
    expect(response.statusCode).toBe(200);
    expect(await storedToolNames(created.id)).toEqual(["tasks.list", "sports.followedFactsToday"]);
  });

  it("still rejects null, false and write-risk names with 400", async () => {
    // The route coerces a lone value into a one-item list, so null and false reach
    // the parser as one invalid element and a write-risk name fails membership.
    for (const selectedToolNames of [null, false, ["tasks.updateStatus"]]) {
      const response = await server.inject({
        method: "POST",
        url: "/api/briefings/definitions",
        headers: userAHeaders(),
        payload: { title: "Invalid briefing", selectedToolNames }
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("replaces the non-empty installed check while keeping the empty-string guard", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      const checks = await client.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
         WHERE conrelid = 'app.briefing_definitions'::regclass AND contype = 'c'`
      );
      const toolCheck = checks.rows.find((row) => row.definition.includes("selected_tool_names"));
      expect(toolCheck?.conname).toBe("briefing_definitions_selected_tool_names_check");
      expect(toolCheck?.definition).not.toContain("cardinality");
      // pg_get_constraintdef renders the literal with a ::text cast.
      expect(toolCheck?.definition).toContain("array_position(selected_tool_names,");
      expect(toolCheck?.definition).toContain("IS NULL");
    } finally {
      await client.end();
    }
  });

  it("skips a selected tool whose module is disabled, without touching the stored list", async () => {
    const actor: AccessContext = userAContext();
    const definition = await dataContext.withDataContext(actor, (scopedDb) =>
      repository.createDefinition(scopedDb, {
        title: "Sports-disabled briefing",
        selectedToolNames: ["tasks.list", "sports.followedFactsToday"]
      })
    );
    const manifests = getBuiltInModuleManifests();
    let sportsExecutions = 0;
    const countingManifests: readonly MossModuleManifest[] = manifests.map((manifest) =>
      manifest.id === "sports"
        ? {
            ...manifest,
            assistantTools: (manifest.assistantTools ?? []).map((tool) =>
              tool.name === "sports.followedFactsToday"
                ? {
                    ...tool,
                    execute: (async (...args: never[]) => {
                      sportsExecutions += 1;
                      return (tool.execute as (...a: never[]) => unknown)(...args);
                    }) as typeof tool.execute
                  }
                : tool
            )
          }
        : manifest
    );
    // The module gate opens its own data context inside the run's transaction,
    // so it needs a pool beyond the harness single connection.
    gateDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    const gateContext = new DataContextRunner(gateDb);
    const deps: ComposeDeps = {
      ...makeComposeDeps(),
      moduleManifests: countingManifests,
      resolveActiveModules: createActiveModulesResolver({
        dataContext: gateContext,
        manifests: () => countingManifests
      })
    };
    await dataContext.withDataContext(actor, (scopedDb) =>
      scopedDb.db
        .insertInto("app.module_enablement")
        .values({ scope: "user", module_id: "sports", user_id: ids.userA })
        .execute()
    );
    try {
      const outcome = await dataContext.withDataContext(actor, (scopedDb) =>
        repository.generateRun(scopedDb, definition.id, {
          moduleManifests: countingManifests,
          runKind: "manual",
          composeDeps: deps
        })
      );
      expect(outcome?.created).toBe(true);
      const gaps = (
        (outcome?.run?.source_metadata as { gaps?: { source: string; reason: string }[] })?.gaps ??
        []
      ).filter((gap) => gap.source === "sports");
      expect(gaps).toEqual([{ source: "sports", reason: "module_disabled" }]);
      expect(sportsExecutions).toBe(0);
      expect(await storedToolNames(definition.id)).toEqual([
        "tasks.list",
        "sports.followedFactsToday"
      ]);
    } finally {
      await dataContext.withDataContext(actor, (scopedDb) =>
        scopedDb.db
          .deleteFrom("app.module_enablement")
          .where("scope", "=", "user")
          .where("module_id", "=", "sports")
          .where("user_id", "=", ids.userA)
          .execute()
      );
    }
    const retried = await dataContext.withDataContext(actor, (scopedDb) =>
      repository.generateRun(scopedDb, definition.id, {
        moduleManifests: countingManifests,
        runKind: "manual",
        composeDeps: deps
      })
    );
    expect(retried?.created).toBe(true);
    expect(sportsExecutions).toBe(1);
  });
});
