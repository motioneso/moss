import { describe, expect, it } from "vitest";
import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import {
  assertRouteChatClassification,
  buildRouteCatalog
} from "../../packages/module-registry/src/route-catalog.js";
import {
  assertRouteCoverage,
  PLATFORM_UNGUARDED_ROUTES
} from "../../packages/module-registry/src/route-guard.js";

const path = "/api/modules/:moduleId/tools/:name/invoke";

describe("module page route is self-authority", () => {
  it("is covered at boot without becoming a callable chat route", () => {
    expect(() =>
      assertRouteCoverage({
        registered: [{ method: "POST", url: path }],
        manifests: [],
        platformAllowlist: PLATFORM_UNGUARDED_ROUTES
      })
    ).not.toThrow();
    expect(
      buildRouteCatalog(getBuiltInModuleManifests(), []).resolve(
        "POST",
        "/api/modules/demo/tools/demo.change/invoke"
      )
    ).toBeNull();
  });

  it("rejects accidental permissive metadata and blocks it in the real catalog", () => {
    const manifest = {
      ...getBuiltInModuleManifests()[0]!,
      routes: [
        {
          method: "POST" as const,
          path,
          permissionId: "demo.write",
          chat: { access: "write" as const, title: "Invoke a module tool" }
        }
      ]
    };
    expect(() => assertRouteChatClassification([manifest])).toThrow(/self_authority/);
    const catalog = buildRouteCatalog([manifest], []);
    expect(
      catalog.resolve("POST", "/api/modules/demo/tools/demo.change/invoke")?.route.policy
    ).toMatchObject({ access: "blocked", blockedBecause: "self_authority" });
    expect(catalog.search("invoke module tool", 10)).toEqual([]);
  });
});
