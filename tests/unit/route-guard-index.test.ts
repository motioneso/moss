import { describe, expect, it } from "vitest";

import type { MossModuleManifest } from "@moss/module-sdk";

import {
  PLATFORM_UNGUARDED_ROUTES,
  assertRouteCoverage,
  buildRouteModuleIndex,
  lookupModuleForRoute
} from "../../packages/module-registry/src/route-guard.js";

const manifests: MossModuleManifest[] = [
  {
    id: "weather",
    name: "Weather",
    version: "0.1.0",
    publisher: "test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    availability: { defaultEnabled: true, required: false, supportsUserDisable: true },
    routes: [
      { method: "GET", path: "/api/weather/today", permissionId: "weather.view" },
      { method: "GET", path: "/api/weather/:id", permissionId: "weather.view" }
    ]
  }
];

describe("route→module index", () => {
  it("maps method + matched-route-pattern to the owning module", () => {
    const index = buildRouteModuleIndex(manifests);
    expect(lookupModuleForRoute(index, "GET", "/api/weather/today")).toBe("weather");
    expect(lookupModuleForRoute(index, "GET", "/api/weather/:id")).toBe("weather");
    expect(lookupModuleForRoute(index, "POST", "/api/weather/today")).toBeUndefined();
    expect(lookupModuleForRoute(index, "GET", "/api/unknown")).toBeUndefined();
  });

  it("folds HEAD into GET so Fastify auto-HEAD is gated like its GET", () => {
    const index = buildRouteModuleIndex(manifests);
    // A GET-only manifest route must resolve for a HEAD request to the same path.
    expect(lookupModuleForRoute(index, "HEAD", "/api/weather/today")).toBe("weather");
  });

  it("throws when two modules claim the same method+pattern (naming both)", () => {
    const collide: MossModuleManifest[] = [
      manifests[0]!,
      {
        ...manifests[0]!,
        id: "imposter",
        name: "Imposter",
        routes: [{ method: "GET", path: "/api/weather/today", permissionId: "weather.view" }]
      }
    ];
    expect(() => buildRouteModuleIndex(collide)).toThrow(/weather/);
    expect(() => buildRouteModuleIndex(collide)).toThrow(/imposter/);
  });

  it("includes the platform health + auth + modules + me + admin/me-modules entries", () => {
    expect(PLATFORM_UNGUARDED_ROUTES.has("GET /health")).toBe(true);
    expect(PLATFORM_UNGUARDED_ROUTES.has("GET /api/modules")).toBe(true);
    expect(PLATFORM_UNGUARDED_ROUTES.has("GET /api/me")).toBe(true);
    // better-auth wildcard (all methods, owned by no module)
    expect(PLATFORM_UNGUARDED_ROUTES.has("POST /api/auth/*")).toBe(true);
    expect(PLATFORM_UNGUARDED_ROUTES.has("GET /api/auth/*")).toBe(true);
    // connector-owned routes must NOT be allowlisted (guarded by connectors module)
    expect(PLATFORM_UNGUARDED_ROUTES.has("GET /api/admin/connectors/accounts")).toBe(false);
    // host diagnostics + install: admin-gated platform routes owned by no module (#255, #993)
    expect(PLATFORM_UNGUARDED_ROUTES.has("GET /api/admin/host/diagnostics")).toBe(true);
    expect(PLATFORM_UNGUARDED_ROUTES.has("POST /api/admin/host/install")).toBe(true);
    // family encryption keys: dedicated encrypted admin routes (#2312) — missing
    // entries here stop the server booting, which is exactly what happened on 2315.
    expect(PLATFORM_UNGUARDED_ROUTES.has("GET /api/admin/settings/encryption-keys")).toBe(true);
    expect(PLATFORM_UNGUARDED_ROUTES.has("PUT /api/admin/settings/encryption-keys")).toBe(true);
    expect(PLATFORM_UNGUARDED_ROUTES.has("POST /api/admin/settings/encryption-keys/rotate")).toBe(
      true
    );
  });
});

describe("assertRouteCoverage", () => {
  const registered = [
    { method: "GET", url: "/api/weather/today" },
    { method: "GET", url: "/api/weather/:id" },
    { method: "GET", url: "/health" }
  ];
  const platform = new Set(["GET /health"]);

  it("passes when every registered route is indexed or allowlisted", () => {
    expect(() =>
      assertRouteCoverage({ registered, manifests, platformAllowlist: platform })
    ).not.toThrow();
  });

  it("throws naming an unindexed, non-allowlisted registered route", () => {
    expect(() =>
      assertRouteCoverage({
        registered: [...registered, { method: "POST", url: "/api/orphan" }],
        manifests,
        platformAllowlist: platform
      })
    ).toThrow(/orphan/);
  });

  it("throws when a manifest declares a route that is not registered (drift)", () => {
    const drifted: MossModuleManifest[] = [
      {
        ...manifests[0]!,
        routes: [
          ...(manifests[0]!.routes ?? []),
          { method: "GET", path: "/api/weather/ghost", permissionId: "weather.view" }
        ]
      }
    ];
    expect(() =>
      assertRouteCoverage({ registered, manifests: drifted, platformAllowlist: platform })
    ).toThrow(/ghost/);
  });
});
