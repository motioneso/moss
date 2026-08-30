import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Static guards for the production deploy artifacts (branch-review "infra-deploy"
// batch). These are config-only LOW findings — no Docker/systemd runtime is needed
// to prove them; the bug is in the literal text of the committed files, so we assert
// against that text. Resolved relative to this test file so cwd does not matter.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, "utf8");

const composeProd = read("infra/docker-compose.prod.yml");
const stackService = read("infra/systemd/jarv1s-stack.service");
const envExample = read("infra/env.production.example");

describe("prod deploy config — host CLI bridge removed for in-container CLI chat (#342 / ADR 0010)", () => {
  it("the host tmux-socket + CLI-home bridge mounts/env are fully gone", () => {
    // #342 reverses the host-native CLI topology (ADR 0010): api/worker no longer mount
    // the host tmux socket or the host ~/.claude|.codex|.gemini dirs — a dedicated
    // cli-runner sidecar forks its OWN tmux server in-container and owns all CLI data.
    // The old host-bridge env/mounts must be fully removed (the JARVIS_TMUX_SOCKET_DIR /
    // JARVIS_HOST_UID drift bug that branch-review #3 guarded no longer exists because the
    // var itself is gone). Replaces the obsolete "socket-dir derives from JARVIS_HOST_UID" guard.
    for (const token of [
      "JARVIS_TMUX_SOCKET_DIR",
      "JARVIS_HOST_CLAUDE_DIR",
      "JARVIS_HOST_CODEX_DIR",
      "JARVIS_HOST_GEMINI_DIR"
    ]) {
      expect(composeProd).not.toContain(token);
    }
  });

  it("runs cli-runner through the single jarv1s service while keeping RPC config", () => {
    expect(composeProd).toMatch(/^\s+jarv1s:/m);
    expect(composeProd).not.toMatch(/^\s+api:/m);
    expect(composeProd).not.toMatch(/^\s+worker:/m);
    expect(composeProd).not.toMatch(/^\s+web:/m);
    expect(composeProd).not.toMatch(/^\s+cli-runner:/m);
    expect(composeProd).toContain("JARVIS_CLI_RUNNER_SOCKET");
    expect(composeProd).toContain("JARVIS_CLI_RUNNER_RPC_SECRET");
    expect(composeProd).toContain("jarv1s-cli-auth:/data/cli-auth");
    expect(composeProd).toContain("jarv1s-cli-tools:/data/cli-tools");
  });
});

describe("prod deploy config — seed service drops root before touching the vault (#1217)", () => {
  it("the seed service runs as the runtime uid/gid, not root", () => {
    // #1217: seed has no user: override, so it runs fully as root (no USER directive in
    // the Dockerfile). tests/uat/seed/chunks/notes.ts creates the actor's vault dir via
    // VaultContextRunner while seed is running — root-owned — and start-jarv1s.ts's
    // prepareRuntimeDirs chown only ever reaches the top-level /data/vaults, and only
    // before seed runs, never after. Seed must run as the same uid/gid the jarv1s
    // service already uses so seeded vault content is never root-owned to begin with.
    const seedBlock = composeProd.match(/^ {2}seed:\n([\s\S]*?)(?=^ {2}\S)/m)?.[1];
    expect(seedBlock).toBeDefined();
    expect(seedBlock).toContain('user: "${JARVIS_HOST_UID:-1000}:${JARVIS_HOST_GID:-1000}"');
  });
});

describe("prod deploy config — systemd ExecStart uses docker --env-file (branch-review #2)", () => {
  it("ExecStart/ExecStop pass --env-file to docker instead of systemd EnvironmentFile", () => {
    const envFilePath = "~/Jarv1s/infra/env.production.local";

    const execStart = stackService.split("\n").find((line) => line.startsWith("ExecStart="));
    const execStop = stackService.split("\n").find((line) => line.startsWith("ExecStop="));
    expect(execStart).toBeDefined();
    expect(execStop).toBeDefined();

    // docker reads the env file directly (matches the documented manual deploy and
    // avoids systemd's `$`-mangling of generated secrets).
    expect(execStart).toContain(`--env-file ${envFilePath}`);
    expect(execStop).toContain(`--env-file ${envFilePath}`);

    // The brittle systemd EnvironmentFile= directive (the `$`-mangling source) is gone.
    expect(stackService).not.toMatch(/^EnvironmentFile=/m);
  });
});

describe("prod deploy config — superuser password single-source callout (branch-review #1)", () => {
  it("env example warns that POSTGRES_PASSWORD and the bootstrap URL password must match", () => {
    // The two places that carry the superuser secret must each cross-reference the
    // other so an operator cannot silently rotate one and break migrate auth.
    expect(envExample).toMatch(
      /MUST EQUAL the `postgres:<\.\.\.>` password in JARVIS_BOOTSTRAP_DATABASE_URL/
    );
    expect(envExample).toMatch(/MUST equal POSTGRES_PASSWORD/);
    // The "only on first volume init" semantics must be documented (the rotation trap).
    expect(envExample).toMatch(/first init|FIRST init|first volume init|FIRST volume init/i);
  });
});

describe("prod deploy config — opt-in Caddy TLS profile (#1504, part of #901)", () => {
  interface ComposeService {
    readonly image?: string;
    readonly profiles?: readonly string[];
    readonly ports?: ReadonlyArray<{ readonly published?: string; readonly target?: number }>;
    readonly environment?: Record<string, string>;
    readonly env_file?: unknown;
    readonly secrets?: unknown;
    readonly user?: string;
    readonly read_only?: boolean;
    readonly cap_drop?: readonly string[];
    readonly cap_add?: readonly string[];
    readonly security_opt?: readonly string[];
    readonly network_mode?: string;
    readonly tmpfs?: unknown;
    readonly depends_on?: Record<string, { readonly condition?: string }>;
    readonly volumes?: ReadonlyArray<{
      readonly source?: string;
      readonly target?: string;
      readonly type?: string;
      readonly read_only?: boolean;
    }>;
  }

  // The two TLS variables are deleted from the inherited environment before every
  // render, so a developer who happens to have them exported cannot turn a red test
  // green by accident.
  function renderProdCompose(args: readonly string[]): Record<string, ComposeService> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      JARVIS_IMAGE_TAG: "test",
      POSTGRES_PASSWORD: "test",
      JARVIS_CLI_RUNNER_RPC_SECRET: "test"
    };
    delete env.JARVIS_TLS_HOST;
    delete env.JARVIS_TLS_ISSUER;
    const output = execFileSync(
      "docker",
      [
        "compose",
        "-f",
        resolve(import.meta.dirname, "../../infra/docker-compose.prod.yml"),
        ...args,
        "config",
        "--format",
        "json"
      ],
      { encoding: "utf8", env }
    );
    return (JSON.parse(output) as { services: Record<string, ComposeService> }).services;
  }

  const caddyfilePath = resolve(import.meta.dirname, "../../infra/caddy/Caddyfile");

  it("test case 1: the profile-free service list is exactly the pre-existing four services", () => {
    const services = renderProdCompose([]);
    expect(Object.keys(services).sort()).toEqual(
      ["jarv1s", "postgres", "sports-browser-socket-init", "sports-source-renderer"].sort()
    );
  });

  it("test case 2: profile-free port and env requirements are unchanged", () => {
    const services = renderProdCompose([]);
    expect(services.jarv1s?.ports).toContainEqual(
      expect.objectContaining({ published: "1533", target: 3000 })
    );
    for (const service of Object.values(services)) {
      expect(service.ports?.some((p) => p.target === 80 || p.target === 443)).not.toBe(true);
    }
  });

  it("test case 3: --profile tls renders both new services with none of the forbidden settings", () => {
    const services = renderProdCompose(["--profile", "tls"]);
    expect(services.caddy).toBeDefined();
    expect(services["caddy-init"]).toBeDefined();
    for (const service of Object.values(services)) {
      expect(service.image).not.toMatch(/:latest$/);
      expect(service).not.toMatchObject({ privileged: true });
      expect(service.network_mode).not.toBe("host");
      expect(service.volumes?.some((v) => v.source === "/var/run/docker.sock")).not.toBe(true);
      expect(service.ports?.some((p) => p.published === "2019")).not.toBe(true);
    }
  });

  it("test case 4: the rendered caddy service is non-root, read-only and correctly capped", () => {
    const services = renderProdCompose(["--profile", "tls"]);
    const caddy = services.caddy;
    expect(caddy?.user).toBe("1000:1000");
    expect(caddy?.read_only).toBe(true);
    expect(caddy?.cap_drop).toEqual(["ALL"]);
    expect(caddy?.cap_add).toEqual(["NET_BIND_SERVICE"]);
    expect(caddy?.security_opt).toEqual(["no-new-privileges:true"]);
    expect(caddy?.tmpfs).toBeUndefined();
    expect(caddy?.volumes?.filter((v) => v.type === "volume")).toEqual([
      expect.objectContaining({ target: "/data" }),
      expect.objectContaining({ target: "/config" })
    ]);
    const caddyfileMount = caddy?.volumes?.find((v) => v.target === "/etc/caddy/Caddyfile");
    expect(caddyfileMount?.read_only).toBe(true);
  });

  it("test case 5: caddy receives no application secrets, exactly its three declared variables", () => {
    const services = renderProdCompose(["--profile", "tls"]);
    const caddy = services.caddy;
    expect(caddy?.env_file).toBeUndefined();
    expect(caddy?.secrets).toBeUndefined();
    expect(Object.keys(caddy?.environment ?? {}).sort()).toEqual(
      ["HOME", "JARVIS_TLS_HOST", "JARVIS_TLS_ISSUER"].sort()
    );
  });

  it("test case 6: caddy-init runs before caddy and is the root-but-CHOWN-only ownership fix", () => {
    const services = renderProdCompose(["--profile", "tls"]);
    const caddy = services.caddy;
    const init = services["caddy-init"];
    expect(caddy?.depends_on?.["caddy-init"]?.condition).toBe("service_completed_successfully");
    expect(caddy?.depends_on?.jarv1s?.condition).toBe("service_healthy");
    expect(init?.user).toBe("0:0");
    expect(init?.cap_drop).toEqual(["ALL"]);
    expect(init?.cap_add).toEqual(["CHOWN"]);
  });

  it("test case 7: the setup service receives exactly the two TLS values and nothing else new", () => {
    const services = renderProdCompose(["--profile", "setup"]);
    expect(services.setup?.environment?.JARVIS_TLS_HOST).toBe("");
    expect(services.setup?.environment?.JARVIS_TLS_ISSUER).toBe("internal");
  });

  // A fresh named volume is pre-populated from the image's own /data/caddy and
  // /config/caddy directories (root-owned), so `caddy validate` with the internal
  // issuer needs the same ownership fix caddy-init performs before it can write the
  // local CA's root certificate — exercising the two services together, not
  // `caddy validate` in isolation, which is the only way this passes for the
  // `internal` issuer on a fresh volume.
  function runCaddyInitChown(dataVolume: string, configVolume: string): number | null {
    const chownCommand = [
      "for p in /data /config /data/caddy /config/caddy; do",
      '  if [ -e "$p" ]; then',
      '    owner=$(stat -c %u "$p")',
      '    if [ "$owner" != "1000" ]; then chown 1000:1000 "$p"; fi',
      "  fi",
      "done"
    ].join("\n");
    return spawnSync("docker", [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--network",
      "none",
      "-v",
      `${dataVolume}:/data`,
      "-v",
      `${configVolume}:/config`,
      "caddy:2.10.0-alpine",
      "sh",
      "-c",
      chownCommand
    ]).status;
  }

  function runCaddyValidate(
    issuer: string,
    dataVolume: string,
    configVolume: string
  ): { status: number | null; stderr: string } {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_BIND_SERVICE",
        "-e",
        "HOME=/config",
        "-e",
        "JARVIS_TLS_HOST=moss.lan",
        "-e",
        `JARVIS_TLS_ISSUER=${issuer}`,
        "-v",
        `${dataVolume}:/data`,
        "-v",
        `${configVolume}:/config`,
        "-v",
        `${caddyfilePath}:/etc/caddy/Caddyfile:ro`,
        "caddy:2.10.0-alpine",
        "caddy",
        "validate",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile"
      ],
      { encoding: "utf8" }
    );
    return { status: result.status, stderr: result.stderr ?? "" };
  }

  it("test case 8: both issuer modes adapt cleanly and a bad issuer is rejected", () => {
    const dataVolume = `1504-test8-data-${process.pid}`;
    const configVolume = `1504-test8-config-${process.pid}`;
    try {
      expect(spawnSync("docker", ["volume", "create", dataVolume]).status).toBe(0);
      expect(spawnSync("docker", ["volume", "create", configVolume]).status).toBe(0);
      expect(runCaddyInitChown(dataVolume, configVolume)).toBe(0);

      expect(runCaddyValidate("internal", dataVolume, configVolume).status).toBe(0);
      expect(runCaddyValidate("acme", dataVolume, configVolume).status).toBe(0);
      expect(runCaddyValidate("bogus", dataVolume, configVolume).status).not.toBe(0);
    } finally {
      spawnSync("docker", ["volume", "rm", dataVolume]);
      spawnSync("docker", ["volume", "rm", configVolume]);
    }
  }, 60_000);

  function runHostGuard(host: string, issuer: string): number | null {
    const guard = [
      'case "$JARVIS_TLS_HOST" in',
      '  "") echo "JARVIS_TLS_HOST must not be empty" >&2; exit 1 ;;',
      '  *[!A-Za-z0-9.-]*) echo "JARVIS_TLS_HOST has characters other than letters, digits, dots and hyphens" >&2; exit 1 ;;',
      "esac",
      'case "$JARVIS_TLS_ISSUER" in',
      "  internal|acme) : ;;",
      '  *) echo "JARVIS_TLS_ISSUER must be internal or acme" >&2; exit 1 ;;',
      "esac",
      'case "$JARVIS_TLS_HOST" in',
      "  *[!0-9.]*) : ;;",
      '  *) if [ "$JARVIS_TLS_ISSUER" = "acme" ]; then echo "IPv4 host cannot use acme" >&2; exit 1; fi ;;',
      "esac"
    ].join("\n");
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-e",
        `JARVIS_TLS_HOST=${host}`,
        "-e",
        `JARVIS_TLS_ISSUER=${issuer}`,
        "caddy:2.10.0-alpine",
        "sh",
        "-c",
        guard
      ],
      { encoding: "utf8" }
    );
    return result.status;
  }

  it("test case 9: the host guard rejects values caddy's own validator accepts", () => {
    expect(runHostGuard("moss.lan", "internal")).toBe(0);
    expect(runHostGuard("10.0.0.5", "internal")).toBe(0);
    for (const host of [
      "",
      "moss.lan evil.com",
      "http://moss.lan/path",
      "moss.lan:8443",
      "*.moss.lan",
      "::1",
      "[::1]"
    ]) {
      expect(runHostGuard(host, "internal")).not.toBe(0);
    }
    expect(runHostGuard("10.0.0.5", "acme")).not.toBe(0);
  }, 60_000);

  it("test case 10: the ownership fix still succeeds on a second start, after caddy has already run once", () => {
    const dataVolume = `1504-test-data-${process.pid}`;
    const configVolume = `1504-test-config-${process.pid}`;
    let containerId: string | undefined;
    const initCommand = [
      'case "$JARVIS_TLS_HOST" in',
      '  "") exit 1 ;;',
      "  *[!A-Za-z0-9.-]*) exit 1 ;;",
      "esac",
      'case "$JARVIS_TLS_ISSUER" in',
      "  internal|acme) : ;;",
      "  *) exit 1 ;;",
      "esac",
      "for p in /data /config /data/caddy /config/caddy; do",
      '  if [ -e "$p" ]; then',
      '    owner=$(stat -c %u "$p")',
      '    if [ "$owner" != "1000" ]; then chown 1000:1000 "$p"; fi',
      "  fi",
      "done"
    ].join("\n");

    try {
      expect(spawnSync("docker", ["volume", "create", dataVolume]).status).toBe(0);
      expect(spawnSync("docker", ["volume", "create", configVolume]).status).toBe(0);

      const firstInit = spawnSync("docker", [
        "run",
        "--rm",
        "--user",
        "0:0",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--network",
        "none",
        "-e",
        "JARVIS_TLS_HOST=moss.lan",
        "-e",
        "JARVIS_TLS_ISSUER=internal",
        "-v",
        `${dataVolume}:/data`,
        "-v",
        `${configVolume}:/config`,
        "caddy:2.10.0-alpine",
        "sh",
        "-c",
        initCommand
      ]);
      expect(firstInit.status).toBe(0);

      const run = spawnSync(
        "docker",
        [
          "run",
          "-d",
          "--user",
          "1000:1000",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "NET_BIND_SERVICE",
          "-e",
          "HOME=/config",
          "-e",
          "JARVIS_TLS_HOST=moss.lan",
          "-e",
          "JARVIS_TLS_ISSUER=internal",
          "-v",
          `${dataVolume}:/data`,
          "-v",
          `${configVolume}:/config`,
          "-v",
          `${caddyfilePath}:/etc/caddy/Caddyfile:ro`,
          "caddy:2.10.0-alpine",
          "caddy",
          "run",
          "--config",
          "/etc/caddy/Caddyfile",
          "--adapter",
          "caddyfile"
        ],
        { encoding: "utf8" }
      );
      containerId = run.stdout.trim();
      expect(run.status).toBe(0);

      // Give Caddy a few seconds to create its owner-only certificate folders
      // (finding 10's regression is only visible once those folders exist).
      spawnSync("sleep", ["3"]);
      spawnSync("docker", ["stop", containerId]);
      spawnSync("docker", ["rm", containerId]);
      containerId = undefined;

      const secondInit = spawnSync("docker", [
        "run",
        "--rm",
        "--user",
        "0:0",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--network",
        "none",
        "-e",
        "JARVIS_TLS_HOST=moss.lan",
        "-e",
        "JARVIS_TLS_ISSUER=internal",
        "-v",
        `${dataVolume}:/data`,
        "-v",
        `${configVolume}:/config`,
        "caddy:2.10.0-alpine",
        "sh",
        "-c",
        initCommand
      ]);
      expect(secondInit.status).toBe(0);
    } finally {
      if (containerId) {
        spawnSync("docker", ["stop", containerId]);
        spawnSync("docker", ["rm", containerId]);
      }
      spawnSync("docker", ["volume", "rm", dataVolume]);
      spawnSync("docker", ["volume", "rm", configVolume]);
    }
  }, 60_000);
});
