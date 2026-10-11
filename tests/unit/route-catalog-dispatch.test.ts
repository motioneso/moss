import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canonicalAppPath,
  type ModuleRouteManifest,
  type MossModuleManifest,
  type RouteChatPolicy
} from "@moss/module-sdk";

import {
  AppActionPathError,
  createAppActionsService
} from "../../packages/chat/src/app-actions.js";
import {
  buildRouteCatalog,
  createRouteCatalogHolder
} from "../../packages/module-registry/src/route-catalog.js";

/**
 * #3065: the catalog authorizes a concrete path, and Fastify inject dispatches it. These tests
 * run both over the same paths and require them to agree on the route, so a path the catalog
 * reads as one route can never reach a different, blocked route.
 */

const write: RouteChatPolicy = { access: "write", title: "Edit a theme" };
const blocked: RouteChatPolicy = { access: "blocked", blockedBecause: "self_authority" };

const routes: ModuleRouteManifest[] = [
  { method: "PUT", path: "/api/me/themes/:id", chat: write },
  { method: "PUT", path: "/api/me/themes/mode", chat: write },
  { method: "PUT", path: "/api/me/yolo", chat: blocked },
  {
    method: "PUT",
    path: "/api/me/persona",
    chat: { ...blocked, blockedBecause: "prompt_shaping" }
  },
  {
    method: "PUT",
    path: "/api/ai/chat-model-override",
    chat: { ...blocked, blockedBecause: "assistant_brain" }
  }
];

const manifest: MossModuleManifest = {
  id: "settings",
  name: "settings",
  version: "0.1.0",
  publisher: "test",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" },
  routes
};

const catalog = buildRouteCatalog([manifest], []);

const ATTACKS = [
  "/api/me/themes/..\\yolo",
  "/api/me/themes/..\\persona",
  "/api/me/themes/..\\..\\ai\\chat-model-override",
  "/api/me/themes/%2e%2e",
  "/api/me/themes/.%2E",
  "/api/me/themes/x/../../yolo",
  "/api/me/themes/\t..\\yolo",
  "/api/me/the\nmes/abc",
  "/api/me/themes/abc\u0000",
  "/api/me/themes/abc ",
  "/api/me/themes/café",
  "//api/me/yolo",
  "/api/me/themes/abc?x=1"
];

/**
 * Canonical for the router, which dispatches them to the theme route with the decoded text as
 * the id. The catalog still refuses them so no parameter value carries path syntax.
 */
const ENCODED_PATH_SYNTAX = [
  "/api/me/themes/%5C..%5Cyolo",
  "/api/me/themes/abc%09",
  "/api/me/themes/%00"
];

const BENIGN = [
  "/api/me/themes/abc",
  "/api/me/themes/mode",
  "/api/me/themes/a%20b",
  "/api/me/themes/a;b",
  "/api/me/themes/0f8c7f3e-1d2b-4c5a-9e6f-7a8b9c0d1e2f",
  "/api/me/yolo",
  "/api/me/persona",
  "/api/ai/chat-model-override"
];

let server: FastifyInstance;
let dispatched: string[] = [];

beforeAll(async () => {
  server = Fastify();
  for (const route of routes) {
    server.route({
      method: route.method,
      url: route.path,
      handler: async (request) => {
        dispatched.push(request.routeOptions.url ?? "");
        return { route: request.routeOptions.url };
      }
    });
  }
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

async function dispatch(path: string): Promise<string | null> {
  const response = await server.inject({ method: "PUT", url: path });
  if (response.statusCode !== 200) return null;
  return (response.json() as { route: string }).route;
}

describe("catalog and router agree on the route", () => {
  it("refuses every path the router could read as a different route", () => {
    for (const path of ATTACKS) {
      expect(catalog.resolve("PUT", path), JSON.stringify(path)).toBeNull();
      expect(canonicalAppPath(path), JSON.stringify(path)).toBeNull();
    }
  });

  it("refuses parameter values that decode to path syntax or control characters", () => {
    for (const path of ENCODED_PATH_SYNTAX) {
      expect(catalog.resolve("PUT", path), path).toBeNull();
    }
  });

  it("dispatches each resolved path to the route the catalog authorized", async () => {
    for (const path of [...ATTACKS, ...ENCODED_PATH_SYNTAX, ...BENIGN]) {
      const resolved = catalog.resolve("PUT", path);
      if (!resolved) continue;
      expect(await dispatch(path), JSON.stringify(path)).toBe(resolved.route.path);
    }
  });

  it("resolves the ordinary paths", () => {
    for (const path of BENIGN) {
      expect(catalog.resolve("PUT", path), path).not.toBeNull();
    }
  });
});

describe("app actions dispatch only canonical paths", () => {
  const holder = createRouteCatalogHolder();
  holder.set(catalog);
  const service = () =>
    createAppActionsService({
      server,
      catalog: holder,
      grants: { mint: () => "grant", consume: () => null, peekActor: () => null },
      readTurnId: () => null
    });
  const ctx = { actorUserId: "user-a", chatSessionId: "chat-1" } as unknown as Parameters<
    ReturnType<typeof createAppActionsService>["call"]
  >[1];

  it("refuses a non-canonical path without dispatching it", async () => {
    dispatched = [];
    for (const path of ATTACKS) {
      await expect(
        service().call({ method: "PUT", path, body: {} }, ctx),
        JSON.stringify(path)
      ).rejects.toBeInstanceOf(AppActionPathError);
    }
    expect(dispatched).toEqual([]);
  });

  it("dispatches a canonical path unchanged", async () => {
    dispatched = [];
    const result = await service().call(
      { method: "PUT", path: "/api/me/themes/abc", body: {} },
      ctx
    );
    expect(result.status).toBe(200);
    expect(dispatched).toEqual(["/api/me/themes/:id"]);
  });
});
