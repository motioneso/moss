/**
 * #1121 Task 4: proves the `docker-compose.prod.yml:152` fix
 * (`JARVIS_CLI_TOOLS_PREFIX: ${JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools}`) resolves correctly —
 * default value on a normal prod run, and the provisioner's scripted-provider override when
 * exported — without starting a live stack. Real `docker compose config` invocation (not a text
 * grep) so this catches interpolation-syntax mistakes a static assertion would miss.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const COMPOSE_PATH = path.resolve(import.meta.dirname, "../../infra/docker-compose.prod.yml");

const REQUIRED_ENV = {
  JARVIS_IMAGE_TAG: "test",
  POSTGRES_PASSWORD: "test",
  JARVIS_CLI_RUNNER_RPC_SECRET: "test"
};

function resolveConfig(extraEnv: Record<string, string> = {}): string {
  return execFileSync("docker", ["compose", "-f", COMPOSE_PATH, "config"], {
    encoding: "utf8",
    env: { ...process.env, ...REQUIRED_ENV, ...extraEnv }
  });
}

describe("docker-compose.prod.yml JARVIS_CLI_TOOLS_PREFIX resolution", () => {
  it("defaults to /data/cli-tools when JARVIS_CLI_TOOLS_PREFIX is unset", () => {
    const config = resolveConfig();
    expect(config).toMatch(/JARVIS_CLI_TOOLS_PREFIX: \/data\/cli-tools/);
  });

  it("honors an exported JARVIS_CLI_TOOLS_PREFIX override (the provisioner's scripted-provider path)", () => {
    const config = resolveConfig({
      JARVIS_CLI_TOOLS_PREFIX: "/app/tests/uat/fixtures/scripted-provider"
    });
    expect(config).toMatch(
      /JARVIS_CLI_TOOLS_PREFIX: \/app\/tests\/uat\/fixtures\/scripted-provider/
    );
  });
});
