// tests/unit/external-module-food-manifest.test.ts
//
// Food Phase 1 (#926, plan §4 Task 7): the REAL shipped food manifest must pass the
// merged external ABI, and the "wired-not-just-defined" rule (plan line 460) must hold —
// every manifest `handler` string (including the queue's "estimate.run") is a real key in
// worker/registry.ts's HANDLERS map, not just a string that happens to look right.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateExternalModuleManifest } from "@moss/module-registry";

import { HANDLERS } from "../../external-modules/food/src/worker/registry.js";

const manifestPath = fileURLToPath(
  new URL("../../external-modules/food/jarvis.module.json", import.meta.url)
);
const loadManifest = (): Record<string, unknown> =>
  JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

describe("food manifest contract (#926 plan §4 Task 7)", () => {
  it("accepts the shipped manifest against the merged ABI", () => {
    const result = validateExternalModuleManifest(loadManifest(), "food", "0.1.0");
    expect(result.ok, JSON.stringify(!result.ok ? result.errors : [])).toBe(true);
  });

  it("declares tool/handler pairs matching the plan, one permission per read/write/destructive tool", () => {
    const manifest = loadManifest();
    const tools = manifest.assistantTools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => [tool.name, tool.handler])).toEqual([
      ["food.meals.list", "meals.list"],
      ["food.meals.summarize", "meals.summarize"],
      ["food.consent.get", "consent.get"],
      ["food.meals.log", "meals.log"],
      ["food.meals.reestimate", "meals.reestimate"],
      ["food.meals.correct", "meals.correct"],
      ["food.consent.grant", "consent.grant"],
      ["food.meals.delete", "meals.delete"]
    ]);
    const riskOf = Object.fromEntries(tools.map((tool) => [tool.name, tool.risk]));
    expect(riskOf["food.meals.list"]).toBe("read");
    expect(riskOf["food.meals.summarize"]).toBe("read");
    expect(riskOf["food.consent.get"]).toBe("read");
    expect(riskOf["food.meals.log"]).toBe("write");
    expect(riskOf["food.meals.reestimate"]).toBe("write");
    expect(riskOf["food.meals.correct"]).toBe("write");
    expect(riskOf["food.consent.grant"]).toBe("write");
    // Behaviour 12 (lifecycle) needs the real platform install/enable/disable contract to
    // fully verify, but this line is the manifest-side guarantee that deleting a meal is
    // gated as destructive, not merely a write — self-operation always confirms.
    expect(riskOf["food.meals.delete"]).toBe("destructive");
  });

  it("food.meals.log requires description and idempotencyKey — the wiring assertion's schema half", () => {
    const tools = loadManifest().assistantTools as Array<Record<string, unknown>>;
    const log = tools.find((tool) => tool.name === "food.meals.log")!;
    const schema = log.inputSchema as { required?: string[] };
    expect(schema.required).toEqual(["description", "idempotencyKey"]);
  });

  it("storage, database, navigation, and the queue's paramsSchema match the plan", () => {
    const manifest = loadManifest();
    expect(manifest.storage).toEqual([{ namespace: "food.settings", scopes: ["user"] }]);
    expect(manifest.database).toEqual({ ownedTables: ["app.food_meals", "app.food_estimates"] });
    expect(manifest.navigation).toEqual([
      { id: "food", label: "Food", path: "/", icon: "utensils" }
    ]);
    const queues = (manifest.worker as { queues: Array<Record<string, unknown>> }).queues;
    expect(queues).toEqual([
      {
        name: "food.estimate-run",
        handler: "estimate.run",
        retryLimit: 2,
        allowManualRun: true,
        paramsSchema: {
          type: "object",
          fields: {
            mealId: { type: "identifier" },
            revision: { type: "integer", min: 1, max: 1000000 }
          }
        }
      }
    ]);
  });

  it("wiring assertion (plan line 460): every manifest handler string is a real key in worker/registry.ts's HANDLERS", () => {
    const manifest = loadManifest();
    const toolHandlers = (manifest.assistantTools as Array<Record<string, unknown>>).map(
      (tool) => tool.handler as string
    );
    const queueHandlers = (
      manifest.worker as { queues: Array<Record<string, unknown>> }
    ).queues.map((queue) => queue.handler as string);
    for (const handler of [...toolHandlers, ...queueHandlers]) {
      expect(Object.keys(HANDLERS), handler).toContain(handler);
    }
    // And the reverse: HANDLERS has no dead entry the manifest never reaches, except that
    // registry.ts's own header comment documents src/tools/registry.ts as a stale duplicate
    // of this file — that file is not imported by worker/index.ts and is out of scope here.
    const declaredHandlers = new Set([...toolHandlers, ...queueHandlers]);
    for (const handler of Object.keys(HANDLERS)) {
      expect(
        declaredHandlers.has(handler),
        `${handler} is registered but no manifest entry reaches it`
      ).toBe(true);
    }
  });

  it("rejects a token/PII-bearing KV namespace outside the food prefix", () => {
    const manifest = loadManifest();
    const storage = manifest.storage as Array<Record<string, unknown>>;
    const mutated = {
      ...manifest,
      storage: [...storage, { namespace: "demo-module.feed", scopes: ["user"] }]
    };
    const result = validateExternalModuleManifest(mutated, "food", "0.1.0");
    expect(result.ok).toBe(false);
  });

  it("rejects duplicated permission ids", () => {
    const manifest = loadManifest();
    const tools = manifest.assistantTools as Array<Record<string, unknown>>;
    const mutated = {
      ...manifest,
      assistantTools: [
        { ...tools[0], permissionId: "food.read" },
        { ...tools[1], permissionId: "food.read" }
      ]
    };
    const result = validateExternalModuleManifest(mutated, "food", "0.1.0");
    expect(result.ok).toBe(false);
  });

  it("rejects forbidden executable-surface fields", () => {
    const result = validateExternalModuleManifest(
      { ...loadManifest(), permissions: [] },
      "food",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
  });

  it("fails closed on a compound compatibility range", () => {
    const result = validateExternalModuleManifest(
      { ...loadManifest(), compatibility: { jarv1s: ">=0.1.0 <0.2.0" } },
      "food",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
  });
});
