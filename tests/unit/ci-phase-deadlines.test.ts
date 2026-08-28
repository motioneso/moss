// #1534 gave every long-running CI phase its own deadline so a stuck phase fails fast and names
// itself in the job summary. #1724 is what happens when one is missed: "Install Playwright
// browsers" had no wrapper, an Ubuntu mirror stalled inside it for 21 minutes, and the job hit the
// 45-minute backstop and was cancelled before a single test ran. A cancelled job produces no error
// annotation, so the cause was only findable by reading the raw log.
//
// This test is the thing that was missing — the rule from #1534 written down somewhere that fails.
// It reads the workflow as text rather than parsed YAML deliberately: the repository has no YAML
// parser dependency, and adding one to assert a handful of strings would cost more than it earns.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CI_WORKFLOW = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

/**
 * Steps that take minutes and can hang on something outside this repository — a package mirror, a
 * browser download, a database that never comes up. Each one needs its own `timeout` wrapper.
 * Add to this list when a new long phase appears; that is the point of the list.
 */
const PHASES_NEEDING_A_DEADLINE = [
  "Install Chromium for unit tests",
  "Run unit tests",
  "Run integration shard",
  "Install Playwright browsers",
  "Run Playwright smoke tests"
] as const;

/** Splits the workflow into one chunk per step, keyed by the step's `name:`. */
function stepBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const chunks = source.split(/^ *- name: /m);
  for (const chunk of chunks.slice(1)) {
    const newline = chunk.indexOf("\n");
    const name = chunk.slice(0, newline === -1 ? undefined : newline).trim();
    bodies.set(name, chunk);
  }
  return bodies;
}

describe("CI phase deadlines (#1534, #1724)", () => {
  const source = readFileSync(CI_WORKFLOW, "utf8");
  const steps = stepBodies(source);

  it.each(PHASES_NEEDING_A_DEADLINE)("%s runs under a timeout", (name) => {
    const body = steps.get(name);
    // A renamed step would otherwise silently drop out of this check and pass.
    expect(body, `no step named "${name}" in ci.yml — rename it here too`).toBeDefined();
    expect(body).toContain("timeout --verbose");
  });

  it.each(PHASES_NEEDING_A_DEADLINE)("%s says so in the log when it runs out of time", (name) => {
    // Without this the failure looks like an ordinary non-zero exit and the reader has to guess
    // which phase died — exactly the situation #1724 was reported from.
    expect(steps.get(name)).toContain("CI_PHASE_TIMEOUT phase=");
  });

  it("keeps publish behind every full main verification lane", () => {
    expect(source).toContain("shard: [1, 2]");
    expect(source.match(/if: needs\.changes\.outputs\.docs_only != 'true'/g)).toHaveLength(5);
    expect(source).not.toContain(
      "if: github.event_name == 'push' && needs.changes.outputs.docs_only"
    );
    expect(source).toContain(
      "needs: [verify, integration, browser, compose-smoke, prod-compose-smoke]"
    );
    expect(source).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
  });

  it("builds the app map on each integration runner before DB-backed tests", () => {
    const integrationJob = source.slice(
      source.indexOf("\n  integration:"),
      source.indexOf("\n  browser:")
    );

    expect(integrationJob).toContain("- name: Build app map\n        run: pnpm build:app-map");
    expect(integrationJob.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
      integrationJob.indexOf("pnpm build:app-map")
    );
    expect(integrationJob.indexOf("pnpm build:app-map")).toBeLessThan(
      integrationJob.indexOf("pnpm db:up")
    );
  });

  it("runs the release-hardening audit after migration in integration shard 1", () => {
    const verifyJob = source.slice(
      source.indexOf("\n  verify:"),
      source.indexOf("\n  integration:")
    );
    const integrationJob = source.slice(
      source.indexOf("\n  integration:"),
      source.indexOf("\n  browser:")
    );

    expect(verifyJob).not.toContain("pnpm audit:release-hardening");
    expect(integrationJob).toContain(
      "if: matrix.shard == 1\n        run: pnpm audit:release-hardening"
    );
    expect(integrationJob.indexOf("pnpm db:migrate")).toBeLessThan(
      integrationJob.indexOf("pnpm audit:release-hardening")
    );
  });

  it("leaves enough time for the measured integration suite and every bounded job", () => {
    const verifyJob = source.slice(
      source.indexOf("\n  verify:"),
      source.indexOf("\n  integration:")
    );
    const integrationJob = source.slice(
      source.indexOf("\n  integration:"),
      source.indexOf("\n  browser:")
    );
    const browserJob = source.slice(
      source.indexOf("\n  browser:"),
      source.indexOf("\n  compose-smoke:")
    );

    expect(verifyJob).toContain("timeout-minutes: 45");
    expect(integrationJob).toContain("timeout-minutes: 45");
    expect(steps.get("Run integration shard")).toContain("timeout --verbose --signal=TERM 30m");
    expect(steps.get("Run integration shard")).toContain("budget=30m");
    expect(browserJob).toContain("timeout-minutes: 45");
  });
});
