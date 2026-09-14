import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the briefing composition seams so the test proves application startup, not a
// hand-built service, connects the News/Sports briefing tools. Everything else is real.
const seams = vi.hoisted(() => ({
  configureSportsBriefingService: vi.fn(),
  configureNewsBriefingService: vi.fn(),
  datasetClients: [] as { sourceId: string; opts: { fetchFn?: unknown }; client: unknown }[]
}));

vi.mock("@moss/sports", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, configureSportsBriefingService: seams.configureSportsBriefingService };
});

vi.mock("@moss/news", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, configureNewsBriefingService: seams.configureNewsBriefingService };
});

vi.mock("@moss/datasets", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createDatasetClient: (
      source: { id: string },
      adapter: unknown,
      opts: { fetchFn?: unknown }
    ) => {
      const client = { __briefingTestClient: source.id, adapter };
      seams.datasetClients.push({ sourceId: source.id, opts, client });
      return client;
    }
  };
});

import { dataContextBrand } from "@moss/db";
import type { DataContextDb } from "@moss/db";
import type * as DatasetsModule from "@moss/datasets";
import type * as SportsModule from "@moss/sports";
import type { MossModuleManifest } from "@moss/module-sdk";
import { newsTopHeadlinesTodayExecute } from "@moss/news";
import { sportsFollowedFactsTodayExecute } from "@moss/sports";

import { getBuiltInModuleRegistrations } from "../../packages/module-registry/src/index.js";
import { composeBriefing } from "../../packages/briefings/src/compose.js";
import { definition, fakeScopedDb, makeFakeDeps, runInput } from "./briefings-compose.harness.js";

function sportsRegistration() {
  const registration = getBuiltInModuleRegistrations().find(
    (entry) => entry.manifest.id === "sports"
  );
  if (!registration) throw new Error("sports module registration missing");
  return registration;
}

function newsRegistration() {
  const registration = getBuiltInModuleRegistrations().find(
    (entry) => entry.manifest.id === "news"
  );
  if (!registration) throw new Error("news module registration missing");
  return registration;
}

function fakeBoss() {
  return {
    work: vi.fn(async () => "work-id"),
    schedule: vi.fn(async () => undefined),
    send: vi.fn(async () => null),
    createQueue: vi.fn(async () => undefined)
  } as never;
}

function fakeServer() {
  const noop = vi.fn();
  return {
    get: noop,
    post: noop,
    put: noop,
    patch: noop,
    delete: noop,
    route: noop,
    register: vi.fn(async () => undefined),
    addHook: noop,
    decorate: noop,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
  } as never;
}

function fakeRouteDeps(fetchFn: typeof fetch) {
  return {
    rootDb: {} as never,
    dataContext: { withDataContext: vi.fn() } as never,
    resolveAccessContext: vi.fn(),
    listConfiguredAuthProviders: () => [],
    listModuleManifests: () => [],
    resolveActiveModules: vi.fn(async () => []),
    boss: fakeBoss(),
    mcpServerUrl: "http://localhost/mcp",
    fetchFn,
    createCliStructuredAdapter: (() => ({
      generateStructured: async () => ({
        rawObject: {},
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    })) as never
  } as never;
}

const throwingFetch = (async () => {
  throw new Error("provider down");
}) as typeof fetch;

describe("briefing source startup wiring (#2313)", () => {
  beforeEach(() => {
    seams.configureSportsBriefingService.mockReset();
    seams.configureNewsBriefingService.mockReset();
    seams.datasetClients.length = 0;
  });

  it("worker startup configures the sports and news briefing services", async () => {
    const sports = sportsRegistration();
    const news = newsRegistration();
    // On the base the sports registration has no worker entry, so the service is never
    // configured in the worker process and the morning report ships a tool_failed gap.
    expect(sports.registerWorkers, "sports gains a worker entry").toBeDefined();
    expect(news.registerWorkers, "news keeps its worker entry").toBeDefined();
    // Worker-only dependency fields: nothing route-only may be read here.
    const workerDeps = { rootDb: {} as never, dataContext: {} as never, fetchFn: throwingFetch };
    await sports.registerWorkers!(fakeBoss(), workerDeps as never);
    await news.registerWorkers!(fakeBoss(), workerDeps as never);
    expect(seams.configureSportsBriefingService).toHaveBeenCalledTimes(1);
    expect(seams.configureNewsBriefingService).toHaveBeenCalledTimes(1);
    // The worker fetch seam reaches both dataset clients.
    for (const sourceId of ["espn", "newsfeeds"]) {
      const calls = seams.datasetClients.filter((call) => call.sourceId === sourceId);
      expect(calls, `one client built for ${sourceId}`).toHaveLength(1);
      expect(calls[0]!.opts.fetchFn).toBe(throwingFetch);
    }
  });

  it("API startup configures both through one shared client each", async () => {
    const sports = sportsRegistration();
    const news = newsRegistration();
    await sports.registerRoutes!(fakeServer(), fakeRouteDeps(throwingFetch));
    await news.registerRoutes!(fakeServer(), fakeRouteDeps(throwingFetch));
    // One client per module, and the configure seam receives that same instance: the
    // route block reuses the builder's return for routes and chat tools.
    for (const [configure, sourceId] of [
      [seams.configureSportsBriefingService, "espn"],
      [seams.configureNewsBriefingService, "newsfeeds"]
    ] as const) {
      expect(configure).toHaveBeenCalledTimes(1);
      const built = seams.datasetClients.filter((call) => call.sourceId === sourceId);
      expect(built, `one client built for ${sourceId}`).toHaveLength(1);
      expect(configure.mock.calls[0]![0]).toBe(built[0]!.client);
    }
  });

  it("an unconfigured sports tool becomes one tool_failed gap and the run completes", async () => {
    // The real tool function against never-configured module state, through the real
    // composer catch: no throw escapes, other sections stay intact.
    // The harness cans sports facts; swap in the real tool so the test exercises the
    // never-configured module state through the real composer catch.
    const deps = makeFakeDeps();
    const withSports: MossModuleManifest[] = deps.moduleManifests.map((manifest) => ({
      ...manifest,
      assistantTools: (manifest.assistantTools ?? []).map((tool) =>
        tool.name === "sports.followedFactsToday"
          ? { ...tool, execute: sportsFollowedFactsTodayExecute }
          : tool
      )
    }));
    const result = await composeBriefing(
      fakeScopedDb,
      definition({ selected_tool_names: ["tasks.list", "sports.followedFactsToday"] }),
      runInput,
      { ...deps, moduleManifests: withSports }
    );
    const gaps = (result.sourceMetadata.gaps ?? []) as { source: string; reason: string }[];
    expect(gaps).toEqual([{ source: "sports", reason: "tool_failed" }]);
    expect(result.status).toBe("succeeded");
    expect(result.sourceMetadata.taskCount).toBe(1);
  });

  it("the unconfigured news tool fails closed instead of returning facts", async () => {
    // The morning composer gathers no news section in this slice, so the tool is proven
    // directly: past the db brand check it throws its named composition-root error rather
    // than fabricating items.
    const brandedDb = { [dataContextBrand]: true } as DataContextDb;
    await expect(
      newsTopHeadlinesTodayExecute(brandedDb, {}, { actorUserId: "owner-1" } as never)
    ).rejects.toThrow("used before configureNewsBriefingService ran");
  });

  it("a dead provider degrades the briefing dataset instead of throwing", async () => {
    // Real client, real ESPN adapter, dead provider: the dataset runtime degrades to the
    // fallback instead of throwing, which is what lets the composer record a neutral
    // empty gap for the source (the gap half is proven in briefing-inclusion, where a
    // real database exists for the service's follows read).
    const realSports = await vi.importActual<typeof SportsModule>("@moss/sports");
    const realDatasets = await vi.importActual<typeof DatasetsModule>("@moss/datasets");
    const client = realDatasets.createDatasetClient(
      realSports.sportsModuleManifest.externalSources![0]!,
      realSports.createEspnDatasetAdapter(),
      { fetchFn: throwingFetch }
    );
    const envelope = await client.getDataset(
      "scoreboard",
      { competitionKey: "nfl" },
      { fallback: [] }
    );
    expect(envelope.data).toEqual([]);
    expect(envelope.degraded).toBe(true);
  });
});
