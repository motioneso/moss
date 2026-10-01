// Guards the signing-key scope in modules-registry.yml. The repository has no YAML parser, so
// this reads the workflow as text, like cli-tools-manifest-workflow.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/modules-registry.yml", import.meta.url)),
  "utf8"
);

describe("modules-registry workflow", () => {
  it("runs the publish job in the module-registry environment", () => {
    // Environment secrets shadow the repository-wide key only when the job names the
    // environment, and the environment's branch rule keeps a branch run from reading the key.
    expect(source).toMatch(
      /^ {2}publish:\n {4}runs-on: ubuntu-latest\n {4}environment: module-registry\n/m
    );
  });

  it("reads the signing key in the build step only", () => {
    const uses = [...source.matchAll(/secrets\.MOSS_MODULE_CATALOG_SIGNING_[A-Z_]+/g)];
    expect(uses).toHaveLength(2);
    const step = source.split(/^ {6}- /m).find((c) => c.includes("name: Build registry artifacts"));
    expect(step).toBeDefined();
    for (const use of uses) expect(step).toContain(use[0]);
  });
});
