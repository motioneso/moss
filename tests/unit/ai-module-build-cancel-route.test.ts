import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";

import { registerModuleBuildRoutes } from "../../packages/ai/src/module-build-routes.js";
import type { AiRoutesDependencies } from "../../packages/ai/src/routes.js";

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
