import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import type { AiRepository } from "@moss/ai";
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

  it("runs both briefing tools through worker startup with zero tool_failed gaps", async () => {
    // T09 (#2313): the scheduled briefing runs in the worker process, so worker startup
    // must configure both briefing services. Fresh module graph first: the harness API
    // server already configured this process's singletons through the route entries, and
    // a reset also refreshes the db brand symbol, so every handle below comes from the
    // fresh graph (only the kysely pools and boss instances are reused). The provider
    // fetch is dead on purpose; configured services degrade to neutral empty gaps while
    // a bypassed setup would record tool_failed gaps instead.
    vi.resetModules();
    const freshRegistry = await import("../../packages/module-registry/src/index.js");
    const freshDb = await import("@moss/db");
    const freshBriefings = await import("@moss/briefings");
    const freshHelpers = await import("./briefings.helpers.js");
    const freshContext = new freshDb.DataContextRunner(appDb);
    const freshRepository = new freshBriefings.BriefingsRepository();
    const deadFetch = (async () => {
      throw new Error("provider down");
    }) as typeof fetch;
    await freshRegistry.registerBuiltInModuleWorkers(workerBoss, {
      rootDb: workerDb,
      dataContext: freshContext,
      fetchFn: deadFetch
    });
    const manifests = freshRegistry.getBuiltInModuleManifests();
    const definition = await freshContext.withDataContext(freshHelpers.userAContext(), (scopedDb) =>
      freshRepository.createDefinition(scopedDb, {
        title: "Worker-startup briefing",
        selectedToolNames: ["sports.followedFactsToday", "news.topHeadlinesToday"]
      })
    );
    const deps: ComposeDeps = {
      ...freshHelpers.makeComposeDeps(),
      moduleManifests: manifests
    };
    const outcome = await freshContext.withDataContext(freshHelpers.userAContext(), (scopedDb) =>
      freshRepository.generateRun(scopedDb, definition.id, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: deps
      })
    );
    expect(outcome?.created).toBe(true);
    expect(outcome?.run?.status).toBe("succeeded");
    const gaps =
      (outcome?.run?.source_metadata as { gaps?: { source: string; reason: string }[] })?.gaps ??
      [];
    expect(gaps.filter((gap) => gap.reason === "tool_failed")).toEqual([]);
    // The dead provider degrades to an empty sports section; news has no morning section
    // in this slice, so its half is proven by the unit startup test.
    expect(gaps).toContainEqual({ source: "sports", reason: "empty" });
  });

  it("stores valid sports+news evidence with module_cache freshness and no URL in the prompt (T10)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    vi.resetModules();
    const freshRegistry = await import("../../packages/module-registry/src/index.js");
    const freshDb = await import("@moss/db");
    const freshBriefings = await import("@moss/briefings");
    const freshHelpers = await import("./briefings.helpers.js");
    const freshSports = await import("../../packages/sports/src/index.js");
    const freshNews = await import("../../packages/news/src/index.js");
    const freshShared = await import("@moss/shared");
    const here = dirname(fileURLToPath(import.meta.url));
    const sportsFixture = (name: string): unknown =>
      JSON.parse(
        readFileSync(resolve(here, `../../packages/sports/src/source/__fixtures__/${name}`), "utf8")
      );
    const bbcRss = readFileSync(
      resolve(here, "../../packages/news/src/source/__fixtures__/bbc-feed.xml"),
      "utf8"
    );
    const allowedHosts = new Set([
      ...(freshSports.ESPN_FETCH_HOSTS as readonly string[]),
      ...(freshNews.NEWS_FETCH_HOSTS as readonly string[])
    ]);
    const fixtureFetch = (async (input: unknown) => {
      const href = typeof input === "string" ? input : (input as { url: string }).url;
      const requested = new URL(href);
      if (!allowedHosts.has(requested.hostname)) {
        throw new Error(`host_not_declared: ${requested.hostname}`);
      }
      const path = `${requested.pathname}${requested.search}`;
      if (requested.hostname === "site.api.espn.com") {
        if (path.includes("/scoreboard")) {
          return new Response(JSON.stringify(sportsFixture("nfl-scoreboard.json")), {
            status: 200
          });
        }
        if (path.includes("/news")) {
          return new Response(JSON.stringify(sportsFixture("nfl-news.json")), { status: 200 });
        }
        if (path.includes("/teams")) {
          return new Response(JSON.stringify(sportsFixture("nfl-teams.json")), { status: 200 });
        }
        if (path.includes("/standings")) {
          return new Response(JSON.stringify(sportsFixture("nfl-standings.json")), {
            status: 200
          });
        }
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }
      return new Response(bbcRss, {
        status: 200,
        headers: { "content-type": "application/rss+xml" }
      });
    }) as typeof fetch;
    const freshContext = new freshDb.DataContextRunner(appDb);
    const freshRepository = new freshBriefings.BriefingsRepository();
    const freshSportsRepo = new (
      await import("../../packages/sports/src/repository.js")
    ).SportsFollowsRepository();
    await freshRegistry.registerBuiltInModuleWorkers(workerBoss, {
      rootDb: workerDb,
      dataContext: freshContext,
      fetchFn: fixtureFetch
    });
    const manifests = freshRegistry.getBuiltInModuleManifests();
    await freshContext.withDataContext(freshHelpers.userAContext(), (scopedDb) =>
      freshSportsRepo.create(scopedDb, {
        competitionKey: "nfl",
        teamKey: "dal",
        sourceTeamId: "6"
      })
    );
    const definition = await freshContext.withDataContext(freshHelpers.userAContext(), (scopedDb) =>
      freshRepository.createDefinition(scopedDb, {
        title: "Editorial evidence briefing",
        selectedToolNames: ["sports.followedFactsToday", "news.topHeadlinesToday"]
      })
    );
    const { createAiSecretCipher } = await import("@moss/ai");
    const cipher = createAiSecretCipher();
    const captured: string[] = [];
    const deps: ComposeDeps = {
      ...freshHelpers.makeComposeDeps(undefined, manifests),
      moduleManifests: manifests,
      cipher,
      aiRepository: {
        selectModelForCapability: async () => ({
          id: "t10-model",
          provider_config_id: "t10-provider",
          provider_kind: "anthropic",
          provider_model_id: "t10-model",
          display_name: "T10 model",
          tier: "economy"
        }),
        selectProviderWithCredential: async () => ({
          id: "t10-provider",
          base_url: null,
          encrypted_credential: cipher.encryptJson({ apiKey: "t10-key" })
        })
      } as unknown as AiRepository,
      createAdapter: () => ({
        generateChat: async (input) => {
          for (const m of input.messages) captured.push(m.content);
          return { text: "synth narrative" };
        }
      })
    };
    const outcome = await freshContext.withDataContext(freshHelpers.userAContext(), (scopedDb) =>
      freshRepository.generateRun(scopedDb, definition.id, {
        moduleManifests: manifests,
        runKind: "manual",
        composeDeps: deps
      })
    );
    expect(outcome?.created).toBe(true);
    expect(outcome?.run?.status).toBe("succeeded");
    const meta = outcome?.run?.source_metadata as {
      gaps?: { source: string; reason: string }[];
      editorial?: { sports?: unknown; news?: unknown };
      sourceTimestamps?: {
        sources: { source: string; freshnessKind: string; asOf: string | null }[];
      };
    };
    expect((meta.gaps ?? []).filter((gap) => gap.reason === "tool_failed")).toEqual([]);
    expect(freshShared.isSportsBriefingEvidence(meta.editorial?.sports)).toBe(true);
    expect(freshShared.isNewsBriefingEvidence(meta.editorial?.news)).toBe(true);
    const bySource = new Map((meta.sourceTimestamps?.sources ?? []).map((s) => [s.source, s]));
    expect(bySource.get("sports")?.freshnessKind).toBe("module_cache");
    expect(bySource.get("sports")?.asOf).not.toBeNull();
    expect(bySource.get("news")?.freshnessKind).toBe("module_cache");
    expect(bySource.get("news")?.asOf).not.toBeNull();
    const prompt = captured.join("\n");
    expect(prompt).toContain('<external_source type="sports">');
    expect(prompt).toContain('<external_source type="news">');
    expect(prompt).not.toContain("https://");
    expect(prompt).not.toContain("/api/news/images/");
  });
});
