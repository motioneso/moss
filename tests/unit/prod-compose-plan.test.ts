import { describe, expect, it } from "vitest";

import { createComposeSmokePlan } from "../../scripts/smoke-compose.js";

describe("createComposeSmokePlan — prod variant", () => {
  it("defaults to the dev compose file with no build step", () => {
    const plan = createComposeSmokePlan();
    // The compose-driven commands all target the dev compose file…
    const composeCmds = plan.commands.filter((c) => c.args[0] === "compose");
    expect(composeCmds.every((c) => c.args.includes("infra/docker-compose.yml"))).toBe(true);
    // …and there is no `docker build` step.
    expect(plan.commands.some((c) => c.args[0] === "build")).toBe(false);
  });

  it("builds and exercises both production images when build is set", () => {
    const plan = createComposeSmokePlan({
      composeFile: "infra/docker-compose.prod.yml",
      build: true
    });
    // Compose-driven commands target the prod compose file.
    const composeCmds = plan.commands.filter((c) => c.args[0] === "compose");
    expect(composeCmds.length).toBeGreaterThan(0);
    expect(composeCmds.every((c) => c.args.includes("infra/docker-compose.prod.yml"))).toBe(true);
    const builds = plan.commands.filter((c) => c.args[0] === "build");
    expect(builds).toHaveLength(2);
    expect(builds[0]?.args).toContain("Dockerfile");
    expect(builds[0]?.args.some((a) => a.startsWith("ghcr.io/motioneso/moss:"))).toBe(true);
    expect(builds[1]?.args).toContain("Dockerfile.sports-renderer");
    expect(
      builds[1]?.args.some((a) => a.startsWith("ghcr.io/motioneso/moss-sports-renderer:"))
    ).toBe(true);
    expect(plan.healthUrl).toBe("http://localhost:1533/health/ready");
    expect(plan.commands.some((c) => c.args.includes("api"))).toBe(false);
    expect(plan.commands.some((c) => c.args.includes("web"))).toBe(false);
    expect(plan.commands.some((c) => c.args.includes("worker"))).toBe(false);
    expect(plan.commands.some((c) => c.args.includes("migrate"))).toBe(false);
    expect(plan.commands.some((c) => c.args.includes("jarv1s"))).toBe(true);
    expect(plan.commands.some((c) => c.args.includes("sports-source-renderer"))).toBe(true);
    expect(
      plan.commands.some((c) => c.args.includes("run") && c.args.includes("sports-renderer-smoke"))
    ).toBe(true);
    expect(
      plan.commands.some(
        (c) => c.args.includes("test") && c.args.includes("/run/moss-sports-browser/renderer.sock")
      )
    ).toBe(true);
    expect(
      plan.commands.some(
        (c) => c.args.includes("sports-source-renderer") && c.args.includes("--input-type=module")
      )
    ).toBe(true);
    expect(
      plan.commands.some(
        (c) => c.args.includes("stop") && c.args.includes("sports-source-renderer")
      )
    ).toBe(true);
  });
});
