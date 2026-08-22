import { describe, expect, it } from "vitest";

import { buildSanitizedCliEnv } from "../../packages/cli-runner/src/sanitized-env.js";
import {
  buildChildEnv,
  buildStartupPlan,
  runtimeUidGid,
  type ChildRole
} from "../../scripts/start-jarv1s.js";

describe("start-jarv1s startup plan", () => {
  it("runs migrate then module reconcile before resident processes", () => {
    const plan = buildStartupPlan({
      NODE_ENV: "production",
      JARVIS_HOST_UID: "1234",
      JARVIS_HOST_GID: "1235",
      JARVIS_CLI_RUNNER_RPC_SECRET: "rpc-secret"
    } as NodeJS.ProcessEnv);

    expect(plan.oneShots.map((oneShot) => oneShot.command)).toEqual([
      ["node_modules/.bin/tsx", "scripts/migrate.ts"],
      ["node_modules/.bin/tsx", "scripts/module-reconcile.ts"]
    ]);
    expect(plan.oneShots[0]!.uid).toBe(1234);
    expect(plan.oneShots[0]!.gid).toBe(1235);
    expect(plan.resident.map((p) => p.role)).toEqual(["cli-runner", "worker", "api"]);
  });

  it("always appends module reconcile after migrate (#996 always-on)", () => {
    const plan = buildStartupPlan({
      NODE_ENV: "production",
      JARVIS_HOST_UID: "1234",
      JARVIS_HOST_GID: "1235",
      JARVIS_CLI_RUNNER_RPC_SECRET: "rpc-secret"
    } as NodeJS.ProcessEnv);

    expect(plan.oneShots.map((oneShot) => oneShot.command)).toEqual([
      ["node_modules/.bin/tsx", "scripts/migrate.ts"],
      ["node_modules/.bin/tsx", "scripts/module-reconcile.ts"]
    ]);
  });

  it("spawns resident processes as the configured runtime uid/gid", () => {
    expect(
      runtimeUidGid({ JARVIS_HOST_UID: "501", JARVIS_HOST_GID: "20" } as NodeJS.ProcessEnv)
    ).toEqual({
      uid: 501,
      gid: 20
    });
  });

  it("rejects invalid runtime uid/gid", () => {
    expect(() =>
      runtimeUidGid({ JARVIS_HOST_UID: "abc", JARVIS_HOST_GID: "20" } as NodeJS.ProcessEnv)
    ).toThrow("JARVIS_HOST_UID must be a positive integer");
    expect(() =>
      runtimeUidGid({ JARVIS_HOST_UID: "501", JARVIS_HOST_GID: "0" } as NodeJS.ProcessEnv)
    ).toThrow("JARVIS_HOST_GID must be a positive integer");
  });

  it("does not pass DB or app encryption secrets to cli-runner", () => {
    const env = buildChildEnv("cli-runner", {
      PATH: "/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/tmp",
      DISABLE_AUTOUPDATER: "1",
      NODE_ENV: "production",
      SHELL: "/bin/bash",
      JARVIS_APP_DATABASE_URL: "postgres://secret",
      BETTER_AUTH_SECRET: "auth-secret",
      JARVIS_AI_SECRET_KEY: "ai-secret",
      JARVIS_CONNECTOR_SECRET_KEY: "connector-secret",
      JARVIS_CLI_RUNNER_SOCKET: "/run/jarv1s/cli-runner.sock",
      JARVIS_CLI_RUNNER_RPC_SECRET: "rpc-secret"
    } as NodeJS.ProcessEnv);

    expect(env.JARVIS_CLI_RUNNER_RPC_SECRET).toBe("rpc-secret");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.SHELL).toBeUndefined();
    expect(env.JARVIS_APP_DATABASE_URL).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.JARVIS_AI_SECRET_KEY).toBeUndefined();
    expect(env.JARVIS_CONNECTOR_SECRET_KEY).toBeUndefined();
  });

  it("keeps cli-runner server env as a superset of the CLI subprocess allowlist", () => {
    const source = {
      HOME: "/data/cli-auth",
      PATH: "/bin",
      NPM_CONFIG_PREFIX: "/data/cli-tools",
      JARVIS_CLI_TOOLS_PREFIX: "/data/cli-tools",
      JARVIS_CLI_HOME: "/data/cli-auth",
      JARVIS_CLI_HOME_BASE: "/data/cli-auth",
      JARVIS_CLI_NEUTRAL_BASE: "/data/cli-auth/chat",
      JARVIS_HOST_UID: "1000",
      JARVIS_HOST_GID: "1000",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      LC_ALL: "C.UTF-8",
      DISABLE_AUTOUPDATER: "1",
      JARVIS_CLI_RUNNER_RPC_SECRET: "rpc-secret",
      JARVIS_UAT_SEED_CONFIRM: "1",
      JARVIS_UAT_SEED_CHAT_SCRIPT: "1252-audit-truth-livepath",
      JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/app/tests/uat/fixtures/scripted-provider/bin"
    } as NodeJS.ProcessEnv;

    const expectedForCli = buildSanitizedCliEnv(source);
    const cliRunnerServerEnv = buildChildEnv("cli-runner", source);

    for (const [key, value] of Object.entries(expectedForCli)) {
      if (key === "PATH") {
        expect(cliRunnerServerEnv.PATH).toBe(`/data/cli-tools/bin:${value}`);
        continue;
      }
      expect(cliRunnerServerEnv[key]).toBe(value);
    }
  });

  it("never forwards the UAT scripted-provider vars to cli-runner without the UAT confirm marker", () => {
    // The production case: JARVIS_UAT_SEED_CONFIRM is never set outside a real UAT run, so
    // these two vars — JARVIS_UAT_SCRIPTED_PROVIDER_BIN in particular, which the Dockerfile
    // puts first on the CLI subprocess's own PATH — must not reach the cli-runner child even
    // if somehow present on the supervisor's own env.
    const env = buildChildEnv("cli-runner", {
      PATH: "/usr/bin:/bin",
      JARVIS_UAT_SEED_CHAT_SCRIPT: "1252-audit-truth-livepath",
      JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/app/tests/uat/fixtures/scripted-provider/bin"
    } as NodeJS.ProcessEnv);

    expect(env.JARVIS_UAT_SEED_CHAT_SCRIPT).toBeUndefined();
    expect(env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN).toBeUndefined();
  });

  it("forwards the UAT scripted-provider vars to cli-runner only with JARVIS_UAT_SEED_CONFIRM=1", () => {
    const env = buildChildEnv("cli-runner", {
      PATH: "/usr/bin:/bin",
      JARVIS_UAT_SEED_CONFIRM: "1",
      JARVIS_UAT_SEED_CHAT_SCRIPT: "1252-audit-truth-livepath",
      JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/app/tests/uat/fixtures/scripted-provider/bin"
    } as NodeJS.ProcessEnv);

    expect(env.JARVIS_UAT_SEED_CHAT_SCRIPT).toBe("1252-audit-truth-livepath");
    expect(env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN).toBe(
      "/app/tests/uat/fixtures/scripted-provider/bin"
    );
  });

  it("puts installed provider tools on the cli-runner PATH", () => {
    const env = buildChildEnv("cli-runner", {
      PATH: "/usr/bin:/bin",
      JARVIS_CLI_TOOLS_PREFIX: "/custom/cli-tools"
    });

    expect(env.PATH).toBe("/custom/cli-tools/bin:/usr/bin:/bin");
  });

  it.each<ChildRole>(["api", "worker"])("%s keeps app runtime env", (role) => {
    const env = buildChildEnv(role, {
      PATH: "/bin",
      NODE_ENV: "production",
      JARVIS_APP_DATABASE_URL: "postgres://app",
      BETTER_AUTH_SECRET: "auth-secret"
    } as NodeJS.ProcessEnv);

    expect(env.JARVIS_APP_DATABASE_URL).toBe("postgres://app");
    expect(env.BETTER_AUTH_SECRET).toBe("auth-secret");
  });
});
