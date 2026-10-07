import { describe, expect, it } from "vitest";

import { briefingsModuleManifest } from "../../packages/briefings/src/manifest.js";
import { calendarModuleManifest } from "../../packages/calendar/src/manifest.js";
import { commitmentsModuleManifest } from "../../packages/commitments/src/manifest.js";
import { goalsModuleManifest } from "../../packages/goals/src/manifest.js";
import {
  assertRouteChatClassification,
  buildRouteCatalog
} from "../../packages/module-registry/src/route-catalog.js";
import type { MossModuleManifest } from "../../packages/module-sdk/src/index.js";
import { tasksModuleManifest } from "../../packages/tasks/src/manifest.js";
import {
  SCHEDULING_EXPECTED_ROWS,
  SCHEDULING_MODULE_IDS,
  SCHEDULING_NAMED_BLOCKED
} from "../fixtures/route-chat-content-scheduling.js";

const manifests: readonly MossModuleManifest[] = [
  tasksModuleManifest,
  calendarModuleManifest,
  commitmentsModuleManifest,
  goalsModuleManifest,
  briefingsModuleManifest
];
const routes = manifests.flatMap((manifest) => manifest.routes ?? []);

describe("scheduling route chat classification", () => {
  it("explicitly classifies all 58 routes without an access default", () => {
    expect(new Set(manifests.map((manifest) => manifest.id))).toEqual(SCHEDULING_MODULE_IDS);
    expect(routes).toHaveLength(58);
    for (const manifest of manifests) expect(manifest.chatDefaults?.access).toBeUndefined();
    for (const route of routes) expect(route.chat?.access, route.path).toBeDefined();
    const toolNames = new Set(
      manifests.flatMap((manifest) => (manifest.assistantTools ?? []).map((tool) => tool.name))
    );
    expect(() => assertRouteChatClassification(manifests, { toolNames })).not.toThrow();
  });

  it("pins every access, exclusion, and response content decision", () => {
    const catalog = buildRouteCatalog(manifests, []);
    const rows = catalog.routes.map((route) =>
      [
        route.moduleId,
        route.method,
        route.path,
        route.policy.access,
        route.policy.blockedBecause,
        route.policy.content === "user_authored" ? "user_authored" : undefined,
        route.policy.outbound ? "outbound" : undefined
      ]
        .filter((part) => part !== undefined)
        .join(" ")
    );
    expect(rows.sort()).toEqual([...SCHEDULING_EXPECTED_ROWS].sort());
  });

  // Inspect the declaration as well as the catalog: central exclusions must not hide a
  // mistaken read/write declaration on a job, provider, self-healing or approval route.
  it.each(SCHEDULING_NAMED_BLOCKED)("blocks %s %s as %s", (method, path, category) => {
    const declared = routes.find((route) => route.method === method && route.path === path);
    expect(declared?.chat).toMatchObject({ access: "blocked", blockedBecause: category });
    const hit = buildRouteCatalog(manifests, []).resolve(
      method,
      path.replace(/:[A-Za-z]+/g, "record-id")
    );
    expect(hit?.route.path).toBe(path);
    expect(hit?.route.policy).toMatchObject({ access: "blocked", blockedBecause: category });
  });

  it("keeps delete operations destructive and resolves every parameterized target", () => {
    const deletes = routes.filter((route) => route.method === "DELETE");
    expect(deletes).toHaveLength(3);
    for (const route of deletes) {
      expect(route.chat?.access).toBe("destructive");
      expect(route.chat?.title).toBeTruthy();
      expect(route.chat?.target).toBeTypeOf("function");
    }
  });

  it("points to richer dedicated task and goal reads without claiming draft-write equivalence", () => {
    for (const [path, coveredBy] of [
      ["/api/tasks/:id", "tasks.get"],
      ["/api/tasks/:id/subtasks", "tasks.get"],
      ["/api/tasks/:id/activity", "tasks.activity"],
      ["/api/goals/:id", "goals.get"],
      ["/api/calendar/events", "calendar.listVisibleEvents"]
    ]) {
      expect(
        routes.find((route) => route.method === "GET" && route.path === path)?.chat?.coveredBy
      ).toBe(coveredBy);
    }
    // dayPlanDraft permits only untimed additions; the route can replace blocks and propose moves.
    expect(
      routes.find((route) => route.path.endsWith("/:id/draft"))?.chat?.coveredBy
    ).toBeUndefined();
  });
});
