import { describe, expect, it } from "vitest";

import { createDatabaseIsolationPlan, resolveVitestArgs } from "../../scripts/test-integration.js";

describe("createDatabaseIsolationPlan", () => {
  it("passes through when JARVIS_PGDATABASE is already set", () => {
    const plan = createDatabaseIsolationPlan(
      { JARVIS_PGDATABASE: "jarvis_build_537" } as NodeJS.ProcessEnv,
      "unused-entropy"
    );

    expect(plan).toEqual({ mode: "passthrough", databaseName: "jarvis_build_537" });
  });

  it("generates an isolated database name when JARVIS_PGDATABASE is unset", () => {
    const plan = createDatabaseIsolationPlan({} as NodeJS.ProcessEnv, "12345_ab12cd");

    expect(plan).toEqual({ mode: "isolated", databaseName: "jarvis_test_12345_ab12cd" });
  });

  it("ignores an empty-string JARVIS_PGDATABASE (treats as unset)", () => {
    const plan = createDatabaseIsolationPlan({ JARVIS_PGDATABASE: "" } as NodeJS.ProcessEnv, "xyz");

    expect(plan).toEqual({ mode: "isolated", databaseName: "jarvis_test_xyz" });
  });
});

describe("resolveVitestArgs", () => {
  // #1314: `pnpm test:integration <file>` used to run the whole suite AND <file>, because the
  // package.json script hardcoded "tests/integration" and pnpm appends CLI args rather than
  // replacing them. The fix moves the default here, so "no CLI args" is the only case that
  // falls back to the directory glob.
  it("falls back to the tests/integration glob when no CLI args are given (the verify:foundation path)", () => {
    expect(resolveVitestArgs([])).toEqual(["tests/integration"]);
  });

  it("runs only the given path, replacing the default rather than appending to it", () => {
    expect(resolveVitestArgs(["tests/integration/notifications.test.ts"])).toEqual([
      "tests/integration/notifications.test.ts"
    ]);
  });

  it("passes multiple explicit paths through unchanged and in order", () => {
    const args = ["tests/integration/tasks.test.ts", "tests/integration/tasks-tools.test.ts"];
    expect(resolveVitestArgs(args)).toEqual(args);
  });
});
