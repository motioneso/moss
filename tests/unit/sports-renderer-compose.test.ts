import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  readonly group_add?: readonly string[];
  readonly command?: readonly string[];
  readonly cap_drop?: readonly string[];
  readonly cap_add?: readonly string[];
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
      "--profile",
      "ops",
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
  expect(services[appName]?.environment).toMatchObject({
    MOSS_SPORTS_RENDERER_SOCKET: "/run/moss-sports-browser/renderer.sock"
  });
  expect(services[appName]?.group_add).toEqual(["1001"]);

  const initializer = services["sports-browser-socket-init"];
  expect(initializer).toMatchObject({
    network_mode: "none",
    read_only: true,
    user: "0:0",
    cap_drop: ["ALL"],
    cap_add: ["CHOWN", "FOWNER", "FSETID"],
    security_opt: ["no-new-privileges:true"]
  });
  expect(initializer?.command).toEqual([
    "sh",
    "-c",
    "chown 0:1001 /run/moss-sports-browser && chmod 2770 /run/moss-sports-browser"
  ]);
  expect(initializer?.volumes).toEqual([
    expect.objectContaining({ type: "volume", target: "/run/moss-sports-browser" })
  ]);
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
    expect(dev.api?.user).toBeUndefined();
    expect(prod.jarv1s?.environment).toMatchObject({
      JARVIS_HOST_UID: "1000",
      JARVIS_HOST_GID: "1000"
    });
    expect(prod["sports-renderer-smoke"]).toMatchObject({
      network_mode: "none",
      read_only: true,
      user: "1000:1000",
      group_add: ["1001"],
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"]
    });
  });

  it("builds a setgid shared directory and group-writable sockets", () => {
    const root = resolve(import.meta.dirname, "../..");
    expect(readFileSync(resolve(root, "Dockerfile"), "utf8")).toContain(
      "chmod 2770 /run/moss-sports-browser"
    );
    expect(readFileSync(resolve(root, "Dockerfile.sports-renderer"), "utf8")).toContain(
      "-o 0 -g 1001 -m 2770 /run/moss-sports-browser"
    );
    for (const file of ["browser-broker.ts", "browser-sidecar.ts"]) {
      const source = readFileSync(resolve(root, "packages/sports/src/source", file), "utf8");
      expect(source).toContain("mode: 0o2770");
      expect(source).toContain("0o660");
    }
  });
});
