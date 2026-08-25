import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";

import { registerModuleBuildRoutes } from "../../packages/ai/src/module-build-routes.js";
import type { AiRoutesDependencies } from "../../packages/ai/src/routes.js";

// #1945 — the Workshop page's "my builds" list. The one thing this route must prove is that a
// signed-in user only ever sees their own builds, never someone else's, even though the route
// itself carries no extra ownership check (it relies on the repository query being scoped).

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

const rows = [
  {
    id: "build-a",
    owner_user_id: USER_A,
    conversation_id: null,
    status: "building" as const,
    plan: null,
    step: "Writing the page",
    module_id: null,
    fetched_urls: ["https://example.com/one"],
    cost_cents: 10,
    error: null,
    created_at: new Date("2026-08-20T00:00:00Z"),
    updated_at: new Date("2026-08-20T00:00:00Z")
  },
  {
    id: "build-b",
    owner_user_id: USER_B,
    conversation_id: null,
    status: "ready" as const,
    plan: null,
    step: null,
    module_id: "mod-1",
    fetched_urls: [],
    cost_cents: 20,
    error: null,
    created_at: new Date("2026-08-21T00:00:00Z"),
    updated_at: new Date("2026-08-21T00:00:00Z")
  }
];

function fakeScopedDb(): DataContextDb {
  const db = {
    selectFrom: () => ({
      selectAll: () => ({
        where: (column: string, _op: string, value: string) => ({
          orderBy: () => ({
            execute: async () =>
              rows.filter((row) => (row as Record<string, unknown>)[column] === value)
          })
        })
      })
    })
  };
  return { db, [dataContextBrand]: true } as unknown as DataContextDb;
}

function buildServer(actorUserId: string): FastifyInstance {
  const server = Fastify();
  const dependencies = {
    resolveAccessContext: async () => ({ actorUserId, requestId: "req-1" }),
    dataContext: {
      withDataContext: async (_accessContext: unknown, run: (db: DataContextDb) => unknown) =>
        run(fakeScopedDb())
    },
    resolveActiveModules: () => []
  } as unknown as AiRoutesDependencies;
  registerModuleBuildRoutes(server, dependencies);
  return server;
}

describe("GET /api/ai/module-builds/mine", () => {
  it("returns only the caller's own build, not another user's", async () => {
    const server = buildServer(USER_A);
    const response = await server.inject({ method: "GET", url: "/api/ai/module-builds/mine" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { builds: Array<{ id: string; step: string | null }> };
    expect(body.builds.map((build) => build.id)).toEqual(["build-a"]);
    expect(body.builds[0]?.step).toBe("Writing the page");
  });

  it("returns a different user's own build for that user, proving the filter is real", async () => {
    const server = buildServer(USER_B);
    const response = await server.inject({ method: "GET", url: "/api/ai/module-builds/mine" });

    const body = response.json() as { builds: Array<{ id: string }> };
    expect(body.builds.map((build) => build.id)).toEqual(["build-b"]);
  });

  it("returns an empty list for a user with no builds, not an error", async () => {
    const server = buildServer("33333333-3333-3333-3333-333333333333");
    const response = await server.inject({ method: "GET", url: "/api/ai/module-builds/mine" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ builds: [] });
  });
});
