import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Summaries must never depend on which Claude version is installed (#3689). */
describe("no code path names a Claude version to decide whether summaries run", () => {
  it.each([
    "packages/chat/src/live/constrained-structured-engine.ts",
    "packages/chat/src/live/public.ts",
    "packages/cli-runner/src/engine-host.ts",
    "packages/module-registry/src/meeting-output-runtime.ts",
    "packages/module-registry/src/constrained-cli-readiness.ts",
    "packages/chat/src/live/acp-structured-adapter.ts"
  ])("%s has no Claude version or release list", (path) => {
    expect(read(path)).not.toMatch(/CONSTRAINED_CLAUDE_(VERSION|RELEASES)|isSupportedDigest/);
  });

  it("the old Claude route files are gone", () => {
    expect(() => read("packages/chat/src/live/constrained-claude-profile.ts")).toThrow();
  });
});
