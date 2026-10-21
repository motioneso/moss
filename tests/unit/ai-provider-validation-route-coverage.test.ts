import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { aiModuleManifest } from "../../packages/ai/src/manifest.js";
import {
  registerAiProviderValidationRoutes,
  type AiProviderValidationRouteDependencies
} from "../../packages/ai/src/provider-validation-routes.js";
import { routeKey } from "../../packages/module-registry/src/route-guard.js";

// The server refuses to boot when a registered route is missing from every manifest, and no other
// unit test stands up the real server, so this pins the provider validation routes to the ai
// manifest.
describe("provider validation routes are all claimed by the ai manifest", () => {
  it("declares every route registerAiProviderValidationRoutes registers", async () => {
    const server = Fastify();
    const registered = new Set<string>();
    server.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.add(routeKey(method, route.url));
    });

    registerAiProviderValidationRoutes(server, {
      resolveAccessContext: async () => ({ actorUserId: "user-a", requestId: "req-1" }),
      dataContext: { withDataContext: async () => undefined }
    } as unknown as AiProviderValidationRouteDependencies);
    await server.ready();
    await server.close();

    const declared = new Set(
      aiModuleManifest.routes.map((route) => routeKey(route.method, route.path))
    );
    expect(registered.size).toBeGreaterThan(0);
    expect([...registered].filter((key) => !declared.has(key)).sort()).toEqual([]);
  });
});
