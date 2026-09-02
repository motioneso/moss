import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  createResolverCache,
  registerIntegrationsRoutes,
  type ConnectionRow,
  type IntegrationsRepository,
  type ResolverCache
} from "@moss/integrations";

function clock(startMs = 0) {
  let ms = startMs;
  return { now: () => ms, advance: (deltaMs: number) => (ms += deltaMs) };
}

function connection(overrides: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "conn-1",
    ownerUserId: "user-a",
    name: "connection",
    kind: "openapi",
    transport: "http",
    url: "http://example.com",
    credentialPlacement: null,
    hasCredential: false,
    enabled: true,
    baseUrl: null,
    specPasted: true,
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    discoveredTools: [],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

/** Minimal in-memory stand-in for IntegrationsRepository — no database involved. */
function fakeRepository(seed: ConnectionRow) {
  const rows = new Map<string, ConnectionRow>([[seed.id, seed]]);
  return {
    createConnection: async (_scopedDb: unknown, input: { name: string }) => {
      const created = connection({ id: "conn-new", name: input.name });
      rows.set(created.id, created);
      return created;
    },
    saveDiscovery: async () => {},
    getConnection: async (_scopedDb: unknown, id: string) => rows.get(id) ?? null,
    updateConnection: async (
      _scopedDb: unknown,
      id: string,
      patch: Partial<ConnectionRow>
    ) => {
      const existing = rows.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      rows.set(id, updated);
      return updated;
    },
    deleteConnection: async (_scopedDb: unknown, id: string) => rows.delete(id),
    loadCredentialEnvelope: async () => null,
    listConnections: async () => [...rows.values()]
  } as unknown as IntegrationsRepository;
}

function fakeDataContext(): DataContextRunner {
  return {
    withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work({})
  } as unknown as DataContextRunner;
}

const SPEC = {
  openapi: "3.0.0",
  paths: {
    "/widgets": { get: { operationId: "listWidgets", summary: "List widgets", tags: ["Widgets"] } }
  }
};

function buildServer(actorUserId: string, cache: ResolverCache, seed: ConnectionRow) {
  const server = Fastify();
  registerIntegrationsRoutes(server, {
    resolveAccessContext: async (): Promise<AccessContext> => ({
      actorUserId,
      requestId: "req-1"
    }),
    dataContext: fakeDataContext(),
    repository: fakeRepository(seed),
    resolverCache: cache
  });
  return server;
}

describe("resolverCache", () => {
  it("never returns one user's cached entry for another user", () => {
    const c = clock();
    const cache = createResolverCache({ now: c.now });
    const modulesA = [{ id: "integration-a" }] as never;

    cache.set("user-a", modulesA);

    expect(cache.get("user-a")).toBe(modulesA);
    expect(cache.get("user-b")).toBeUndefined();
  });

  it("drops only the named user's entry", () => {
    const cache = createResolverCache();
    cache.set("user-a", [{ id: "a" }] as never);
    cache.set("user-b", [{ id: "b" }] as never);

    cache.drop("user-a");

    expect(cache.get("user-a")).toBeUndefined();
    expect(cache.get("user-b")).toBeDefined();
  });

  it("expires an entry after 30 seconds", () => {
    const c = clock();
    const cache = createResolverCache({ now: c.now });
    cache.set("user-a", [{ id: "a" }] as never);

    c.advance(29_999);
    expect(cache.get("user-a")).toBeDefined();

    c.advance(2);
    expect(cache.get("user-a")).toBeUndefined();
  });
});

describe("integrations routes drop the resolver cache on every edit", () => {
  let cache: ResolverCache;

  beforeEach(() => {
    cache = { get: vi.fn(), set: vi.fn(), drop: vi.fn() };
  });

  it("drops on create", async () => {
    const server = buildServer("user-a", cache, connection({}));
    const response = await server.inject({
      method: "POST",
      url: "/api/integrations",
      payload: { name: "New API", kind: "openapi", url: "http://example.com/openapi.json", spec: JSON.stringify(SPEC) }
    });

    expect(response.statusCode).toBe(201);
    expect(cache.drop).toHaveBeenCalledWith("user-a");
  });

  it("drops on update, including a tool-curation change", async () => {
    const server = buildServer("user-a", cache, connection({}));
    const response = await server.inject({
      method: "PATCH",
      url: "/api/integrations/conn-1",
      payload: { enabledTools: ["some_tool"] }
    });

    expect(response.statusCode).toBe(200);
    expect(cache.drop).toHaveBeenCalledWith("user-a");
  });

  it("drops on refresh", async () => {
    const server = buildServer("user-a", cache, connection({}));
    const response = await server.inject({
      method: "POST",
      url: "/api/integrations/conn-1/refresh",
      payload: { spec: JSON.stringify(SPEC) }
    });

    expect(response.statusCode).toBe(200);
    expect(cache.drop).toHaveBeenCalledWith("user-a");
  });

  it("drops on delete", async () => {
    const server = buildServer("user-a", cache, connection({}));
    const response = await server.inject({ method: "DELETE", url: "/api/integrations/conn-1" });

    expect(response.statusCode).toBe(204);
    expect(cache.drop).toHaveBeenCalledWith("user-a");
  });

  it("does not drop when the edit target does not exist", async () => {
    const server = buildServer("user-a", cache, connection({}));
    const response = await server.inject({
      method: "PATCH",
      url: "/api/integrations/does-not-exist",
      payload: { enabled: false }
    });

    expect(response.statusCode).toBe(404);
    expect(cache.drop).not.toHaveBeenCalled();
  });
});
