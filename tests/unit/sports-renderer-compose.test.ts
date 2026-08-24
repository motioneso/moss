import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface ComposeService {
  readonly image?: string;
  readonly build?: { readonly dockerfile?: string };
  readonly network_mode?: string;
  readonly environment?: unknown;
  readonly env_file?: unknown;
  readonly secrets?: unknown;
  readonly networks?: unknown;
  readonly read_only?: boolean;
  readonly tmpfs?: readonly string[];
  readonly user?: string;
  readonly cap_drop?: readonly string[];
  readonly security_opt?: readonly string[];
  readonly cpus?: number | string;
  readonly mem_limit?: number | string;
  readonly pids_limit?: number;
  readonly volumes?: ReadonlyArray<{
    readonly source?: string;
    readonly target?: string;
    readonly type?: string;
  }>;
}

function renderCompose(file: string): Record<string, ComposeService> {
  const output = execFileSync(
    "docker",
    [
      "compose",
      "-f",
      resolve(import.meta.dirname, `../../infra/${file}`),
      "config",
      "--format",
      "json"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        JARVIS_IMAGE_TAG: "test",
        POSTGRES_PASSWORD: "test",
        JARVIS_CLI_RUNNER_RPC_SECRET: "test"
      }
    }
  );
  return (JSON.parse(output) as { services: Record<string, ComposeService> }).services;
}

function expectSandboxedRenderer(services: Record<string, ComposeService>, appName: string): void {
  const renderer = services["sports-source-renderer"];
  expect(renderer).toBeDefined();
  expect(renderer?.network_mode).toBe("none");
  expect(renderer?.environment).toBeUndefined();
  expect(renderer?.env_file).toBeUndefined();
  expect(renderer?.secrets).toBeUndefined();
  expect(renderer?.networks).toBeUndefined();
  expect(renderer?.read_only).toBe(true);
  expect(renderer?.tmpfs?.some((mount) => mount.startsWith("/tmp:"))).toBe(true);
  expect(renderer?.user).toBe("1001:1001");
  expect(renderer?.cap_drop).toEqual(["ALL"]);
  expect(renderer?.security_opt).toEqual(["no-new-privileges:true"]);
  expect(Number(renderer?.cpus)).toBe(1);
  expect(Number(renderer?.mem_limit)).toBe(512 * 1024 * 1024);
  expect(renderer?.pids_limit).toBe(128);
  expect(renderer?.volumes).toEqual([
    expect.objectContaining({ type: "volume", target: "/run/moss-sports-browser" })
  ]);
  expect(renderer?.volumes?.every((mount) => mount.type === "volume")).toBe(true);
  expect(services[appName]?.volumes).toContainEqual(
    expect.objectContaining({ type: "volume", target: "/run/moss-sports-browser" })
  );
}

describe("Sports source renderer Compose sandbox", () => {
  it("ships the same isolated renderer boundary in dev and production", () => {
    const dev = renderCompose("docker-compose.yml");
    const prod = renderCompose("docker-compose.prod.yml");

    expectSandboxedRenderer(dev, "api");
    expectSandboxedRenderer(prod, "jarv1s");
    expect(dev["sports-source-renderer"]?.build?.dockerfile).toBe("Dockerfile.sports-renderer");
    expect(prod["sports-source-renderer"]?.image).toBe(
      "ghcr.io/motioneso/moss-sports-renderer:test"
    );
  });
});
