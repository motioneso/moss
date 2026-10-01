/**
 * Tools-volume adapter lookup (#2689 slice 2): the live release is found through
 * `providers/<slot>/current`, a missing or escaping path falls back to the image copy.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  candidateReleasesFor,
  resolveToolsVolumeAdapterEntry,
  resolveToolsVolumeCli
} from "../../packages/cli-runner/src/tools-volume-adapters.js";

let prefix: string;
beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), "tools-vol-"));
});
afterEach(() => rmSync(prefix, { recursive: true, force: true }));

function installRelease(slot: string, name: string, files: Record<string, string>): string {
  const release = join(prefix, "providers", slot, "releases", name);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(release, rel)), { recursive: true });
    writeFileSync(join(release, rel), body);
    chmodSync(join(release, rel), 0o755);
  }
  const current = join(prefix, "providers", slot, "current");
  rmSync(current, { force: true });
  symlinkSync(join("releases", name), current);
  return release;
}

const CLAUDE_ENTRY = "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";

describe("resolveToolsVolumeAdapterEntry", () => {
  it("returns the entry inside the concrete release, not the current link", () => {
    const release = installRelease("anthropic-adapter", "r1", { [CLAUDE_ENTRY]: "//" });
    const entry = resolveToolsVolumeAdapterEntry(prefix, "anthropic");
    expect(entry).toBe(join(release, CLAUDE_ENTRY));
    expect(entry).not.toContain("/current/");
  });

  it("returns null when nothing is installed or the entry file is missing", () => {
    expect(resolveToolsVolumeAdapterEntry(prefix, "anthropic")).toBeNull();
    installRelease("anthropic-adapter", "r1", { "node_modules/other/x.js": "//" });
    expect(resolveToolsVolumeAdapterEntry(prefix, "anthropic")).toBeNull();
  });

  it("refuses an entry that is a link pointing outside the release", () => {
    const outside = join(prefix, "outside.js");
    writeFileSync(outside, "//");
    const release = installRelease("anthropic-adapter", "r1", { "node_modules/x": "" });
    mkdirSync(dirname(join(release, CLAUDE_ENTRY)), { recursive: true });
    symlinkSync(outside, join(release, CLAUDE_ENTRY));
    expect(resolveToolsVolumeAdapterEntry(prefix, "anthropic")).toBeNull();
  });

  it("refuses a current link that points outside the providers folder", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    try {
      mkdirSync(dirname(join(elsewhere, CLAUDE_ENTRY)), { recursive: true });
      writeFileSync(join(elsewhere, CLAUDE_ENTRY), "//");
      mkdirSync(join(prefix, "providers", "anthropic-adapter"), { recursive: true });
      symlinkSync(elsewhere, join(prefix, "providers", "anthropic-adapter", "current"));
      expect(resolveToolsVolumeAdapterEntry(prefix, "anthropic")).toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("resolveToolsVolumeCli", () => {
  it("returns the concrete release bin path for each provider", () => {
    const claude = installRelease("anthropic", "c1", { "node_modules/.bin/claude": "#!/bin/sh" });
    const codex = installRelease("openai-compatible", "x1", {
      "node_modules/.bin/codex": "#!/bin/sh"
    });
    expect(resolveToolsVolumeCli(prefix, "anthropic")).toBe(
      join(claude, "node_modules/.bin/claude")
    );
    expect(resolveToolsVolumeCli(prefix, "openai")).toBe(join(codex, "node_modules/.bin/codex"));
  });

  it("returns null when not installed or not executable", () => {
    expect(resolveToolsVolumeCli(prefix, "anthropic")).toBeNull();
    const release = installRelease("anthropic", "c1", { "node_modules/.bin/claude": "x" });
    chmodSync(join(release, "node_modules/.bin/claude"), 0o644);
    expect(resolveToolsVolumeCli(prefix, "anthropic")).toBeNull();
  });

  it("refuses a bin link that points outside the release", () => {
    const outside = join(prefix, "evil");
    writeFileSync(outside, "#!/bin/sh");
    chmodSync(outside, 0o755);
    const release = installRelease("anthropic", "c1", { "node_modules/keep": "" });
    mkdirSync(join(release, "node_modules/.bin"), { recursive: true });
    symlinkSync(outside, join(release, "node_modules/.bin/claude"));
    expect(resolveToolsVolumeCli(prefix, "anthropic")).toBeNull();
  });
});

describe("candidate releases", () => {
  function stageState(candidate: unknown[]): void {
    writeFileSync(
      join(prefix, "providers", "anthropic", "state.json"),
      JSON.stringify({ manifestSequence: 1, candidate, prior: [] })
    );
  }

  it("resolves the staged candidate and leaves the live release alone", async () => {
    const live = installRelease("anthropic", "live1", { "node_modules/.bin/claude": "#!/bin/sh" });
    installRelease("anthropic-adapter", "live2", { [CLAUDE_ENTRY]: "//" });
    const cand = join(prefix, "providers", "anthropic", "releases", "cand1");
    mkdirSync(join(cand, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(cand, "node_modules/.bin/claude"), "#!/bin/sh");
    chmodSync(join(cand, "node_modules/.bin/claude"), 0o755);
    stageState([
      { role: "cli", slot: "anthropic", pkg: "p", version: "2", release: "cand1" },
      { role: "chat-adapter", slot: "anthropic-adapter", pkg: "q", version: "2", release: "cand2" }
    ]);

    const overrides = await candidateReleasesFor(prefix, "anthropic");
    expect(overrides).not.toBeNull();
    expect(resolveToolsVolumeCli(prefix, "anthropic", overrides!)).toBe(
      join(realpathSync(cand), "node_modules/.bin/claude")
    );
    expect(resolveToolsVolumeCli(prefix, "anthropic")).toBe(join(live, "node_modules/.bin/claude"));
  });

  it("reports no candidate when the state has none or only half a toolset", async () => {
    mkdirSync(join(prefix, "providers", "anthropic"), { recursive: true });
    expect(await candidateReleasesFor(prefix, "anthropic")).toBeNull();
    stageState([{ role: "cli", slot: "anthropic", pkg: "p", version: "2", release: "cand1" }]);
    expect(await candidateReleasesFor(prefix, "anthropic")).toBeNull();
  });
});
