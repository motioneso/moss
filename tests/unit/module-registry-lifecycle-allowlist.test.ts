import { describe, expect, it } from "vitest";

import { LIFECYCLE_MIGRATION_PENDING } from "@moss/module-registry";

/**
 * Pins the exact contents of the LIFECYCLE_MIGRATION_PENDING allowlist (#801 Phase A). The
 * list documents which built-in modules with owned tables have not yet declared a
 * `dataLifecycle` manifest (Phase B work). It is a review-visible, shrink-only list: every
 * Phase B PR should REMOVE an id from it, never add one. If this test fails because the list
 * grew, that is very likely a regression (a module lost its dataLifecycle declaration) rather
 * than an intentional addition — update this pin only when deliberately reverting a module's
 * migration.
 */
describe("LIFECYCLE_MIGRATION_PENDING allowlist", () => {
  it("contains exactly the modules still pending a dataLifecycle declaration", () => {
    expect([...LIFECYCLE_MIGRATION_PENDING].sort()).toEqual(
      [
        "ai",
        "briefings",
        "calendar",
        "connectors",
        "email",
        "jarvis.commitments",
        "memory",
        "notes",
        "notifications",
        "people",
        "proactive-monitoring",
        "structured-state",
        "tasks",
        "usefulness-feedback",
        "weather"
      ].sort()
    );
  });

  it("no longer contains wellness or sports (migrated in #801 Phase A)", () => {
    expect(LIFECYCLE_MIGRATION_PENDING).not.toContain("wellness");
    expect(LIFECYCLE_MIGRATION_PENDING).not.toContain("sports");
  });
});
