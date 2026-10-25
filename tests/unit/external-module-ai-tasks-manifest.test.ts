import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { reconcileExternalModules } from "@moss/module-registry";
import {
  getExternalModuleRegistrations,
  hashCanonicalManifest,
  hashExternalPackage,
  validateExternalModuleManifest
} from "@moss/module-registry/node";
import type { ModuleAiTaskDeclaration } from "@moss/module-sdk";

const baseManifest = {
  schemaVersion: 1,
  id: "meal-test",
  name: "Meal Test",
  version: "1.0.0",
  publisher: "Test",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" }
};

const planTask = { id: "plan", label: "Plan writing", defaultTier: "reasoning" };

function validate(aiTasks: unknown) {
  return validateExternalModuleManifest({ ...baseManifest, aiTasks }, baseManifest.id);
}

describe("external manifest AI task declarations (#3716)", () => {
  it("preserves declaration order, labels, tiers and optional capabilities in validated output", () => {
    const aiTasks: readonly ModuleAiTaskDeclaration[] = [
      { id: "plan", label: "Plan writing", defaultTier: "reasoning" },
      { id: "swap", label: "Quick swaps", defaultTier: "interactive", requires: [] },
      { id: "estimate", label: "Nutrition estimates", defaultTier: "economy" },
      { id: "photo", label: "Photo reading", defaultTier: "interactive", requires: ["vision"] }
    ];
    const result = validate(aiTasks);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.manifest.aiTasks).toEqual(aiTasks);
    expect(result.manifest.aiTasks?.[0]).not.toHaveProperty("requires");
  });

  it("keeps manifests without tasks unchanged", () => {
    const result = validateExternalModuleManifest(baseManifest, baseManifest.id);
    expect(result).toEqual({ ok: true, manifest: baseManifest });
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.manifest).not.toHaveProperty("aiTasks");
  });

  it("accepts exactly sixteen tasks and the id and label length boundaries", () => {
    const tasks = Array.from({ length: 16 }, (_, index) => ({
      ...planTask,
      id: `task-${index}`
    }));
    tasks[0] = { ...planTask, id: "a", label: "A" };
    tasks[15] = { ...planTask, id: `a${"b".repeat(31)}`, label: "L".repeat(48) };
    const result = validate(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.manifest.aiTasks).toEqual(tasks);
  });

  it.each([
    ["null", null],
    ["object", {}],
    ["string", "plan"],
    ["empty array", []],
    ["seventeen tasks", Array.from({ length: 17 }, (_, i) => ({ ...planTask, id: `task-${i}` }))],
    ["null entry", [null]],
    ["array entry", [[]]],
    ["string entry", ["plan"]],
    ["missing id", [{ label: "Plan", defaultTier: "reasoning" }]],
    ["empty id", [{ ...planTask, id: "" }]],
    ["dotted id", [{ ...planTask, id: "plan.write" }]],
    ["trailing newline in id", [{ ...planTask, id: "plan\n" }]],
    ["uppercase id", [{ ...planTask, id: "Plan" }]],
    ["numeric first character", [{ ...planTask, id: "1plan" }]],
    ["underscore id", [{ ...planTask, id: "plan_write" }]],
    ["long id", [{ ...planTask, id: "a".repeat(33) }]],
    ["non-string id", [{ ...planTask, id: 1 }]],
    ["duplicate ids", [planTask, { ...planTask, label: "Other label" }]],
    ["missing label", [{ id: "plan", defaultTier: "reasoning" }]],
    ["empty label", [{ ...planTask, label: "" }]],
    ["whitespace label", [{ ...planTask, label: " \t " }]],
    ["long label", [{ ...planTask, label: "L".repeat(49) }]],
    ["non-string label", [{ ...planTask, label: 2 }]],
    ["missing tier", [{ id: "plan", label: "Plan" }]],
    ["unknown tier", [{ ...planTask, defaultTier: "fast" }]],
    ["non-string tier", [{ ...planTask, defaultTier: 1 }]],
    ["non-array requires", [{ ...planTask, requires: "vision" }]],
    ["null requires", [{ ...planTask, requires: null }]],
    ["chat capability", [{ ...planTask, requires: ["chat"] }]],
    ["implicit json capability", [{ ...planTask, requires: ["json"] }]],
    ["tool-use capability", [{ ...planTask, requires: ["tool-use"] }]],
    ["transcription capability", [{ ...planTask, requires: ["transcription"] }]],
    ["web-search capability", [{ ...planTask, requires: ["web-search"] }]],
    ["summarization capability", [{ ...planTask, requires: ["summarization"] }]],
    ["non-string capability", [{ ...planTask, requires: [3] }]],
    ["duplicate capabilities", [{ ...planTask, requires: ["vision", "vision"] }]],
    ["unknown entry key", [{ ...planTask, model: "a-model" }]]
  ])("rejects %s rather than silently dropping declarations", (_label, raw) => {
    const result = validate(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid AI task declaration accepted");
    expect(result.errors.join("; ")).toMatch(/aiTasks/);
  });

  it("does not let another invalid field bypass task validation", () => {
    const result = validateExternalModuleManifest(
      { ...baseManifest, name: "", aiTasks: [{ ...planTask, id: "bad.id" }] },
      baseManifest.id
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid manifest accepted");
    expect(result.errors.join("; ")).toMatch(/aiTasks/);
  });

  it("discovers task metadata and requires renewed approval after a platform-only manifest hash change", () => {
    const modulesDir = mkdtempSync(join(tmpdir(), "moss-ai-tasks-"));
    try {
      const dir = join(modulesDir, baseManifest.id);
      mkdirSync(dir);
      writeFileSync(
        join(dir, "jarvis.module.json"),
        JSON.stringify({ ...baseManifest, aiTasks: [planTask] })
      );
      // Before this field was recognized, validation omitted it from the canonical hash.
      const oldManifestHash = hashCanonicalManifest(baseManifest);
      const oldPackageHash = hashExternalPackage(dir);
      const result = getExternalModuleRegistrations({ modulesDir });
      expect(result.rejected).toEqual([]);
      expect(result.discoveries).toHaveLength(1);
      const discovery = result.discoveries[0];
      if (!discovery) throw new Error("module was not discovered");
      expect(discovery.manifest.aiTasks).toEqual([planTask]);
      expect(discovery.manifestHash).toBe(hashCanonicalManifest(discovery.manifest));
      expect(discovery.manifestHash).not.toBe(oldManifestHash);
      expect(discovery.packageHash).toBe(oldPackageHash);

      const previousState = {
        id: baseManifest.id,
        status: "enabled" as const,
        packageHash: oldPackageHash,
        manifestHash: oldManifestHash,
        descriptorApprovedByUserId: "admin",
        disabledReason: null,
        ownerUserId: null
      };
      const upgraded = reconcileExternalModules(result.discoveries, [previousState]);
      expect(upgraded.driftDisable).toEqual([]);
      expect(upgraded.modules[0]).toMatchObject({
        active: true,
        status: "enabled",
        drifted: false,
        descriptorApprovedByUserId: null
      });

      // Admin re-enable records both current hashes (routes-modules → repository).
      const reapproved = reconcileExternalModules(result.discoveries, [
        { ...previousState, manifestHash: discovery.manifestHash }
      ]);
      expect(reapproved.modules[0]).toMatchObject({
        active: true,
        descriptorApprovedByUserId: "admin"
      });
    } finally {
      rmSync(modulesDir, { recursive: true, force: true });
    }
  });
});
