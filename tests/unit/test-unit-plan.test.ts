import { describe, expect, it } from "vitest";

import { resolveVitestArgs } from "../../scripts/test-unit.js";

describe("resolveVitestArgs", () => {
  // #1324: `pnpm test:unit <file>` used to run the whole suite AND <file>, because the
  // package.json script hardcoded "tests/unit" and pnpm appends CLI args rather than replacing
  // them. The fix moves the default here, so "no CLI args" is the only case that falls back to
  // the directory glob. Mirrors the #1314 fix for `test:integration`.
  it("falls back to the tests/unit glob when no CLI args are given (the verify:foundation path)", () => {
    expect(resolveVitestArgs([])).toEqual(["--fileParallelism", "--maxWorkers=2", "tests/unit"]);
  });

  it("runs only the given path, replacing the default rather than appending to it", () => {
    expect(resolveVitestArgs(["tests/unit/job-search-crawl-stage.test.ts"])).toEqual([
      "--fileParallelism",
      "--maxWorkers=2",
      "tests/unit/job-search-crawl-stage.test.ts"
    ]);
  });

  it("passes multiple explicit paths through unchanged and in order", () => {
    const args = ["tests/unit/job-search-crawl-stage.test.ts", "tests/unit/test-unit-plan.test.ts"];
    expect(resolveVitestArgs(args)).toEqual(["--fileParallelism", "--maxWorkers=2", ...args]);
  });
});
