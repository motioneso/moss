import { describe, expect, it } from "vitest";

import type { ManifestToolset } from "../../scripts/cli-tools-manifest/manifest.js";
import type { PrepareResult } from "../../scripts/cli-tools-manifest/prepare.js";
import { planPublish, readCheckPasses } from "../../scripts/cli-tools-manifest/publish.js";

const toolset = (pkg: string, version: string): ManifestToolset => ({
  minMossVersion: "0.2.0",
  packages: [
    {
      role: "cli",
      pkg,
      version,
      lockfile: `x-cli-${version}.json`,
      lockfileSha256: "a".repeat(64),
      provenance: "attested"
    }
  ]
});

const prepared: PrepareResult = {
  attested: [],
  outcomes: [
    {
      toolset: "a",
      status: "updated",
      failures: [],
      manifestToolset: toolset("tool-a", "1.0.0"),
      attested: [{ pkg: "tool-a", version: "1.0.0" }]
    },
    {
      toolset: "b",
      status: "updated",
      failures: [],
      manifestToolset: toolset("tool-b", "2.0.0"),
      attested: [{ pkg: "tool-b", version: "2.0.0" }]
    },
    {
      toolset: "c",
      status: "blocked",
      failures: ["tarball does not match"],
      subject: { pkg: "tool-c", version: "3.0.0" }
    }
  ]
};
const issuedAt = "2026-09-30T00:00:00Z";

describe("planPublish", () => {
  it("publishes only toolsets whose contract check passed", () => {
    const plan = planPublish({
      previous: null,
      prepared,
      checkPasses: new Map([
        ["a", true],
        ["b", false]
      ]),
      issuedAt
    });
    expect(Object.keys(plan.manifest!.toolsets)).toEqual(["a"]);
    expect(plan.manifest!.provenanceHistory).toEqual({ "tool-a": { since: "1.0.0" } });
    expect(plan.blocked.map((b) => `${b.toolset}:${b.reason}`)).toEqual([
      "b:contract-check",
      "c:prepare"
    ]);
  });

  it("treats a missing check result as a failure for every toolset", () => {
    const plan = planPublish({ previous: null, prepared, checkPasses: new Map(), issuedAt });
    expect(plan.manifest).toBeNull();
    expect(plan.blocked).toHaveLength(3);
  });

  it("cannot be talked into publishing a toolset the prepare step blocked", () => {
    const plan = planPublish({
      previous: null,
      prepared,
      checkPasses: new Map([
        ["a", true],
        ["b", true],
        ["c", true]
      ]),
      issuedAt
    });
    expect(Object.keys(plan.manifest!.toolsets)).toEqual(["a", "b"]);
  });
});

describe("readCheckPasses", () => {
  it("keeps only the pass bit and counts anything odd as a fail", () => {
    const m = readCheckPasses([
      { toolset: "a", pass: true, failures: ["ignore me"] },
      { toolset: "b", pass: "true" },
      "junk",
      null
    ]);
    expect(m.get("a")).toBe(true);
    expect(m.get("b")).toBe(false);
    expect(m.size).toBe(2);
    expect(readCheckPasses({ not: "an array" }).size).toBe(0);
  });
});
