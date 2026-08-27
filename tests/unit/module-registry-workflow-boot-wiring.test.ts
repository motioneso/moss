// #2012 (slice 819-A). The validator passing its own tests proves nothing about boot: a rule set
// that no boot path calls would let a broken workflow definition through untouched. This file
// asserts the wiring instead of the rules -- that the consistency check every built-in module
// already goes through at import time runs workflow validation too, and that the validated lookup
// is reachable.
//
// Importing the registry package is itself part of the proof: both apps/api/src/server.ts and
// apps/worker/src/worker.ts import it, and it runs assertModuleRegistryConsistency at module load,
// so if a built-in workflow were ever invalid this import would throw and every test here would
// fail rather than quietly skipping the broken definition.
import { describe, expect, it } from "vitest";

import type { MossModuleManifest, WorkflowStepHandler } from "@moss/module-sdk";
import {
  assertModuleRegistryConsistency,
  getWorkflowRegistry
} from "../../packages/module-registry/src/index.js";

const handler: WorkflowStepHandler = async () => ({ status: "ok" });

/** A registration whose workflow points its start at a step that does not exist. */
const brokenRegistration = {
  manifest: {
    id: "fake-module",
    workflows: [
      {
        id: "fake-module.broken",
        displayName: "Broken",
        version: 1,
        startStepId: "nowhere",
        trigger: "manual",
        steps: [{ id: "draft", kind: "task", handler }],
        edges: []
      }
    ]
  } as unknown as MossModuleManifest,
  sqlMigrationDirectories: [],
  queueDefinitions: []
};

describe("workflow validation is wired into the registry boot check", () => {
  it("stops the registry consistency check on a broken workflow definition", () => {
    // This is the seam that fails the API and the worker closed at boot. Without the call inside
    // assertModuleRegistryConsistency, this registration would sail through.
    expect(() => assertModuleRegistryConsistency([brokenRegistration])).toThrow(/"start-step"/);
  });

  it("still names the module and the workflow when it throws from the boot check", () => {
    expect(() => assertModuleRegistryConsistency([brokenRegistration])).toThrow(
      /"fake-module".*"fake-module\.broken"/
    );
  });

  it("exposes a validated workflow lookup, empty until a module declares one", () => {
    // Empty is the expected result after this slice, not a bug: no built-in declares a workflow
    // yet. What matters is that the lookup exists and was built from validated definitions.
    const registry = getWorkflowRegistry();
    expect(registry).toBeInstanceOf(Map);
    expect(registry.size).toBe(0);
  });
});
