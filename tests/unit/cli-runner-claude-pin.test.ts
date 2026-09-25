/**
 * The pinned Claude CLI must be new enough for the Claude models users can pick (#2674 follow-up).
 * Claude CLI 2.1.183 rejects claude-opus-5-5 with "version 2.1.280 or newer is required", so
 * every background AI call on prod failed before writing any answer.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";

const MIN_CLAUDE_CLI = [2, 1, 280] as const;

function parseVersion(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function atLeast(version: string, min: readonly number[]): boolean {
  const parts = parseVersion(version);
  for (let i = 0; i < min.length; i++) {
    const have = parts[i] ?? 0;
    if (have !== min[i]) return have > min[i]!;
  }
  return true;
}

describe("pinned Claude CLI version", () => {
  const recipe = PROVIDER_CATALOG.anthropic.recipe;

  it("is new enough for current Claude models", () => {
    expect(PROVIDER_CATALOG.anthropic.status).toBe("supported");
    expect(recipe?.kind).toBe("npm");
    const version = recipe?.kind === "npm" ? recipe.version : "";
    expect(atLeast(version, MIN_CLAUDE_CLI)).toBe(true);
  });

  it("matches the committed lockfile", () => {
    const version = recipe?.kind === "npm" ? recipe.version : "";
    const lockfile = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "packages/cli-runner/recipes/anthropic/npm-shrinkwrap.json"),
        "utf8"
      )
    ) as { packages: Record<string, { version?: string }> };
    expect(lockfile.packages["node_modules/@anthropic-ai/claude-code"]?.version).toBe(version);
    expect(lockfile.packages["node_modules/@anthropic-ai/claude-code-linux-x64"]?.version).toBe(
      version
    );
  });
});
