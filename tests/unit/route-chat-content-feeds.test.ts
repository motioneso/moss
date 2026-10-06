import { describe, expect, it } from "vitest";

import type { MossModuleManifest } from "@moss/module-sdk";

import {
  assertRouteChatClassification,
  buildRouteCatalog
} from "../../packages/module-registry/src/route-catalog.js";
import { newsModuleManifest } from "../../packages/news/src/manifest.js";
import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";
import {
  FEEDS_EXPECTED_ROWS,
  FEEDS_MODULE_IDS,
  FEEDS_NAMED_BLOCKED
} from "../fixtures/route-chat-content-feeds.js";

const manifests: readonly MossModuleManifest[] = [newsModuleManifest, sportsModuleManifest];
const routes = manifests.flatMap((manifest) => manifest.routes ?? []);

function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/g, "11111111-1111-4111-8111-111111111111");
}

function row(moduleId: string, route: NonNullable<MossModuleManifest["routes"]>[number]) {
  const policy = route.chat;
  return [
    moduleId,
    route.method,
    route.path,
    policy?.access,
    policy?.blockedBecause,
    policy?.content === "user_authored" ? policy.content : undefined,
    policy?.outbound ? "outbound" : undefined
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}

describe("feed route chat classification", () => {
  it("classifies all 46 routes explicitly, with no inherited access or content", () => {
    expect(new Set(manifests.map((manifest) => manifest.id))).toEqual(FEEDS_MODULE_IDS);
    expect(routes).toHaveLength(46);
    for (const manifest of manifests) {
      expect(manifest.chatDefaults?.access).toBeUndefined();
      for (const route of manifest.routes ?? []) {
        expect(route.chat?.access, `${route.method} ${route.path}`).toBeDefined();
        expect(route.chat?.content, `${route.method} ${route.path}`).toMatch(
          /^(outside|user_authored)$/
        );
      }
    }
    expect(
      manifests.flatMap((m) => (m.routes ?? []).map((route) => row(m.id, route))).sort()
    ).toEqual([...FEEDS_EXPECTED_ROWS].sort());
    expect(() => assertRouteChatClassification(manifests)).not.toThrow();
  });

  it.each(FEEDS_NAMED_BLOCKED)("declares %s %s blocked as %s", (method, path, category) => {
    expect(routes.find((route) => route.method === method && route.path === path)?.chat).toEqual({
      access: "blocked",
      blockedBecause: category,
      content: "outside"
    });
    const hit = buildRouteCatalog(manifests, []).resolve(method, concrete(path));
    expect(hit?.route.policy.access).toBe("blocked");
    expect(hit?.route.policy.blockedBecause).toBe(category);
  });

  it.each(FEEDS_NAMED_BLOCKED)(
    "independently blocks permissive %s %s as %s",
    (method, path, category) => {
      const permissive = manifests.map((manifest) => ({
        ...manifest,
        routes: (manifest.routes ?? []).map((route) =>
          route.method === method && route.path === path
            ? { ...route, chat: { access: "read" as const, content: "user_authored" as const } }
            : route
        )
      }));
      const hit = buildRouteCatalog(permissive, []).resolve(method, concrete(path));
      expect(hit?.route.policy.access).toBe("blocked");
      expect(hit?.route.policy.blockedBecause).toBe(category);
      expect(() => assertRouteChatClassification(permissive)).toThrow(/must be blocked/);
    }
  );

  it("requires a server-read target for each of the three destructive routes", () => {
    const destructive = routes.filter((route) => route.chat?.access === "destructive");
    expect(destructive.map((route) => route.path).sort()).toEqual([
      "/api/sports/follows/:id",
      "/api/sports/sources/:id",
      "/api/sports/sources/:id/photos"
    ]);
    for (const route of destructive) {
      expect(route.chat?.target).toBeTypeOf("function");
      expect(route.chat?.title).toBeTruthy();
    }
  });

  it("keeps stored provider labels and imported source responses outside", () => {
    for (const [method, path] of [
      ["GET", "/api/sports/follows"],
      ["GET", "/api/sports/standings-preferences"],
      ["PUT", "/api/sports/standings-preferences"],
      ["GET", "/api/sports/sources"],
      ["DELETE", "/api/sports/sources/:id/photos"],
      ["GET", "/api/sports/headlines/:headlineId/photo"]
    ]) {
      expect(
        routes.find((route) => route.method === method && route.path === path)?.chat?.content
      ).toBe("outside");
    }
    const ownRecords = routes.filter((route) => route.chat?.content === "user_authored");
    expect(ownRecords.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "DELETE /api/sports/follows/:id",
      "DELETE /api/sports/sources/:id",
      "GET /api/news/prefs",
      "PUT /api/sports/sources/espn/coverage"
    ]);
  });

  it("only marks the exact dedicated source-list operation as covered", () => {
    expect(
      routes
        .filter((route) => route.chat?.coveredBy)
        .map((route) => [route.method, route.path, route.chat?.coveredBy])
    ).toEqual([["GET", "/api/sports/sources", "sports.listSources"]]);
  });
});
