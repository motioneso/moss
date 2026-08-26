import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";

import { registerModuleBuildRoutes } from "../../packages/ai/src/module-build-routes.js";
import type { AiRoutesDependencies } from "../../packages/ai/src/routes.js";
import { aiModuleManifest } from "../../packages/ai/src/manifest.js";
import { routeKey } from "../../packages/module-registry/src/route-guard.js";

// #1975 — the "Stop" button on a build in progress. The route itself carries no extra ownership
// check; it relies on cancelModuleBuild's scoped UPDATE reporting whether a row matched. This test
// pins down the two outcomes the route must turn into: 200 when a row was cancelled, 404 (same
// shape for "not found" and "not yours") when it was not.

function fakeScopedDb(numUpdatedRows: bigint): DataContextDb {
  const chain = {
    set: () => chain,
    where: () => chain,
    executeTakeFirst: async () => ({ numUpdatedRows })
  };
  const db = { updateTable: () => chain };
  return { db, [dataContextBrand]: true } as unknown as DataContextDb;
}

function buildServer(numUpdatedRows: bigint): FastifyInstance {
  const server = Fastify();
  const dependencies = {
    resolveAccessContext: async () => ({ actorUserId: "user-a", requestId: "req-1" }),
    dataContext: {
      withDataContext: async (_accessContext: unknown, run: (db: DataContextDb) => unknown) =>
        run(fakeScopedDb(numUpdatedRows))
    },
    cancelModuleBuild: async () => numUpdatedRows > 0n,
    resolveActiveModules: () => []
  } as unknown as AiRoutesDependencies;
  registerModuleBuildRoutes(server, dependencies);
  return server;
}

describe("POST /api/ai/module-builds/:buildId/cancel", () => {
  it("cancels the caller's own in-progress build", async () => {
    const server = buildServer(1n);
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/module-builds/build-a/cancel"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ buildId: "build-a", status: "cancelled" });
  });

  it("returns 404 when no build was cancelled (not found or not the caller's)", async () => {
    const server = buildServer(0n);
    const response = await server.inject({
      method: "POST",
      url: "/api/ai/module-builds/build-a/cancel"
    });

    expect(response.statusCode).toBe(404);
  });
});

// The regression this guards against: adding a route to module-build-routes.ts without adding it
// to the ai module's manifest routes[] passes every unit test (nothing here stands up the real
// server), then throws at server BOOT from assertRouteCoverage (apps/api/src/server.ts) —
// something only the compose deployment smoke actually exercises. packages/chat hit this exact
// trap for #1284 (see chat-route-coverage.test.ts); this is the same guard for the module-build
// routes registered here.
describe("module build routes are all claimed by the ai manifest", () => {
  it("declares every route registerModuleBuildRoutes registers", async () => {
    const server = Fastify();
    const registered = new Set<string>();
    server.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.add(routeKey(method, route.url));
    });

    const dependencies = {
      resolveAccessContext: async () => ({ actorUserId: "user-a", requestId: "req-1" }),
      dataContext: {
        withDataContext: async (_accessContext: unknown, run: (db: DataContextDb) => unknown) =>
          run(fakeScopedDb(1n))
      },
      resolveActiveModules: () => []
    } as unknown as AiRoutesDependencies;
    registerModuleBuildRoutes(server, dependencies);
    await server.ready();
    await server.close();

    const declared = new Set(
      aiModuleManifest.routes.map((route) => routeKey(route.method, route.path))
    );
    const unclaimed = [...registered].filter((key) => !declared.has(key)).sort();
    expect(unclaimed).toEqual([]);
  });
});
