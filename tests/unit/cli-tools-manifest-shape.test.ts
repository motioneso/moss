import { describe, expect, it } from "vitest";

import {
  compareVersions,
  nextSequence,
  validateCliToolsManifest,
  type CliToolsManifest
} from "../../scripts/cli-tools-manifest/manifest.js";
import { validateRegistryIndex } from "../../packages/module-registry/src/node.js";

const good: CliToolsManifest = {
  kind: "cli-tools",
  formatVersion: 1,
  issuedAt: "2026-09-30T04:00:00Z",
  sequence: 3,
  provenanceHistory: { "@openai/codex": { since: "0.150.0" } },
  toolsets: {
    anthropic: {
      minMossVersion: "0.1.0",
      packages: [
        {
          role: "cli",
          pkg: "@anthropic-ai/claude-code",
          version: "2.1.290",
          lockfile: "anthropic-cli-2.1.290.json",
          lockfileSha256: "a".repeat(64),
          provenance: "none"
        }
      ]
    }
  }
};

const moduleIndex = { schemaVersion: 1, generatedAt: "2026-09-30T04:00:00Z", modules: [] };

describe("cli tools manifest shape", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateCliToolsManifest(good).errors).toEqual([]);
  });

  it("rejects a module registry index (wrong kind)", () => {
    expect(validateCliToolsManifest(moduleIndex).manifest).toBeNull();
  });

  it("makes a cli-tools manifest fail the module index check", () => {
    expect(validateRegistryIndex(good).index).toBeNull();
  });

  it("rejects a missing provenanceHistory", () => {
    const { provenanceHistory: _omit, ...rest } = good;
    expect(validateCliToolsManifest(rest).manifest).toBeNull();
  });

  it("rejects a bad lockfile hash, a path-like lockfile name and a ranged version", () => {
    const pkg = good.toolsets.anthropic!.packages[0]!;
    const bad = (over: object): unknown => ({
      ...good,
      toolsets: { anthropic: { minMossVersion: "0.1.0", packages: [{ ...pkg, ...over }] } }
    });
    expect(validateCliToolsManifest(bad({ lockfileSha256: "zz" })).manifest).toBeNull();
    expect(validateCliToolsManifest(bad({ lockfile: "../x.json" })).manifest).toBeNull();
    expect(validateCliToolsManifest(bad({ version: "^2.1.0" })).manifest).toBeNull();
  });

  it("numbers sequences upward from 1", () => {
    expect(nextSequence(null)).toBe(1);
    expect(nextSequence(good)).toBe(4);
  });

  it("compares versions numerically, not as strings", () => {
    expect(compareVersions("2.1.290", "2.1.92")).toBe(1);
    expect(compareVersions("0.157.1", "0.157.1")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });
});
