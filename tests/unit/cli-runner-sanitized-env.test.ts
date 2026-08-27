/**
 * §7.2 sanitized-env allowlist: the CLI-subprocess env contains ONLY the allowlist and
 * NONE of the excluded secrets — crucially NOT the socket path or the RPC secret, and
 * not any app secret / DB URL / role password / vault path.
 */
import { describe, expect, it } from "vitest";

import { createSanitizedTmuxIo } from "../../packages/cli-runner/src/runner-io.js";
import { buildSanitizedCliEnv } from "../../packages/cli-runner/src/sanitized-env.js";
import { buildCliRunnerChildEnv } from "../../packages/cli-runner/src/main.js";

describe("buildSanitizedCliEnv (§7.2)", () => {
  const source: NodeJS.ProcessEnv = {
    // allowed
    HOME: "/data/cli-auth",
    PATH: "/usr/bin:/data/cli-tools/bin",
    NPM_CONFIG_PREFIX: "/data/cli-tools",
    JARVIS_CLI_TOOLS_PREFIX: "/data/cli-tools",
    JARVIS_CLI_HOME: "/data/cli-auth",
    JARVIS_CLI_HOME_BASE: "/data/cli-auth",
    JARVIS_CLI_NEUTRAL_BASE: "/data/cli-auth/chat",
    JARVIS_HOST_UID: "1000",
    JARVIS_HOST_GID: "1000",
    TERM: "xterm",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: "/tmp",
    JARVIS_UAT_SEED_CHAT_SCRIPT: "1252-audit-truth-livepath",
    JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/app/tests/uat/fixtures/scripted-provider/bin",
    // EXCLUDED — socket + RPC secret + single-user flag (server-only)
    JARVIS_CLI_RUNNER_SOCKET: "/run/jarv1s/cli-runner.sock",
    JARVIS_CLI_RUNNER_RPC_SECRET: "super-secret",
    JARVIS_CLI_RUNNER_SINGLE_USER: "1",
    // EXCLUDED — app secrets
    BETTER_AUTH_SECRET: "x",
    JARVIS_AI_SECRET_KEY: "x",
    JARVIS_CONNECTOR_SECRET_KEY: "x",
    POSTGRES_PASSWORD: "x",
    JARVIS_APP_DATABASE_URL: "postgres://...",
    JARVIS_VAULT_ROOT: "/data/vaults"
  };

  it("keeps the allowlist (incl. LC_* prefix) and drops everything else", () => {
    const env = buildSanitizedCliEnv(source);
    // allowed
    expect(env.HOME).toBe("/data/cli-auth");
    expect(env.PATH).toContain("/data/cli-tools/bin");
    expect(env.JARVIS_CLI_NEUTRAL_BASE).toBe("/data/cli-auth/chat");
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm");
    expect(env.JARVIS_UAT_SEED_CHAT_SCRIPT).toBe("1252-audit-truth-livepath");
    expect(env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN).toBe(
      "/app/tests/uat/fixtures/scripted-provider/bin"
    );

    // EXCLUDED: socket path + RPC secret + single-user flag
    expect(env.JARVIS_CLI_RUNNER_SOCKET).toBeUndefined();
    expect(env.JARVIS_CLI_RUNNER_RPC_SECRET).toBeUndefined();
    expect(env.JARVIS_CLI_RUNNER_SINGLE_USER).toBeUndefined();

    // EXCLUDED: every app secret / DB URL / role password / vault path
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.JARVIS_AI_SECRET_KEY).toBeUndefined();
    expect(env.JARVIS_CONNECTOR_SECRET_KEY).toBeUndefined();
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
    expect(env.JARVIS_APP_DATABASE_URL).toBeUndefined();
    expect(env.JARVIS_VAULT_ROOT).toBeUndefined();
  });

  it("does not leak unknown vars by default (deny-by-default)", () => {
    const env = buildSanitizedCliEnv({ SOME_RANDOM_VAR: "v", JARVIS_MULTIPLEXER: "tmux" });
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
    // JARVIS_MULTIPLEXER is server spawn config, NOT for the CLI child (§7.2).
    expect(env.JARVIS_MULTIPLEXER).toBeUndefined();
  });

  it("drops JARVIS_UAT_SEED_CHAT_SCRIPT / JARVIS_UAT_SCRIPTED_PROVIDER_BIN when the bin path isn't the exact fixture value", () => {
    // A production operator (or an attacker who can set an env var on the container) setting
    // these two vars must not reach the CLI subprocess unless JARVIS_UAT_SCRIPTED_PROVIDER_BIN
    // is exactly the one path the UAT fixture ever uses — JARVIS_UAT_SCRIPTED_PROVIDER_BIN in
    // particular names a folder the Dockerfile puts first on the CLI's own PATH, so any other
    // value (real or attacker-chosen) is worthless to set.
    const env = buildSanitizedCliEnv({
      JARVIS_UAT_SEED_CHAT_SCRIPT: "1252-audit-truth-livepath",
      JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/tmp/attacker-controlled-bin"
    });
    expect(env.JARVIS_UAT_SEED_CHAT_SCRIPT).toBeUndefined();
    expect(env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN).toBeUndefined();
  });

  it("drops both when JARVIS_UAT_SCRIPTED_PROVIDER_BIN is entirely unset", () => {
    const env = buildSanitizedCliEnv({
      JARVIS_UAT_SEED_CHAT_SCRIPT: "1252-audit-truth-livepath"
    });
    expect(env.JARVIS_UAT_SEED_CHAT_SCRIPT).toBeUndefined();
    expect(env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN).toBeUndefined();
  });
});

describe("buildCliRunnerChildEnv", () => {
  it("uses the configured auth volume as HOME even when the runner inherited the host HOME", async () => {
    const authHome = "/tmp/jarv1s-test-cli-auth";
    const source: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: "/home/ben",
      JARVIS_CLI_HOME: authHome,
      JARVIS_CLI_HOME_BASE: authHome,
      JARVIS_CLI_RUNNER_RPC_SECRET: "must-not-leak"
    };

    const env = buildCliRunnerChildEnv({ homeBase: authHome }, source);
    expect(env.HOME).toBe(authHome);
    expect(env.JARVIS_CLI_HOME).toBe(authHome);
    expect(env.JARVIS_CLI_HOME_BASE).toBe(authHome);
    expect(env.JARVIS_CLI_RUNNER_RPC_SECRET).toBeUndefined();

    const io = createSanitizedTmuxIo(env);
    const result = await io.run(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify({home: process.env.HOME, cliHome: process.env.JARVIS_CLI_HOME}))"
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ home: authHome, cliHome: authHome });
  });

  it("SETS NO_BROWSER on the child env, not merely allowlisting the name (#2027)", async () => {
    // The allowlist is a passthrough FILTER, not a setter: naming NO_BROWSER in sanitized-env.ts
    // without setting a value delivers nothing, and gemini then tries to open a browser instead of
    // printing the authorization URL the sign-in dialog needs. Source env deliberately omits it.
    const authHome = "/tmp/jarv1s-test-cli-auth";
    const env = buildCliRunnerChildEnv({ homeBase: authHome }, { PATH: process.env.PATH });
    expect(env.NO_BROWSER).toBe("1");

    const io = createSanitizedTmuxIo(env);
    const result = await io.run(process.execPath, [
      "-e",
      "process.stdout.write(String(process.env.NO_BROWSER))"
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("1");
  });
});

/**
 * UNPROVEN-3 (§7.2): the LIVE child env that createSanitizedTmuxIo actually spawns a
 * subprocess with — not just buildSanitizedCliEnv in isolation — must contain ONLY the
 * allowlist. We spawn a real `node -e` that serializes its own process.env and assert the
 * socket path, the RPC secret, the single-user flag, and every app/DB/vault secret are
 * ABSENT from the spawned child (allowlist-only, deny-by-default). This proves the seam
 * end to end: the secret never even reaches the child's environment block.
 */
describe("UNPROVEN-3: createSanitizedTmuxIo spawns the CLI child with the §7.2 allowlist ONLY", () => {
  it("the actually-spawned subprocess env excludes the socket path, RPC secret, and all app/DB/vault secrets", async () => {
    // A source env loaded with the secrets a real cli-runner-server process would hold,
    // plus a usable PATH so `node` resolves in the (sanitized) child.
    const source: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: "/data/cli-auth",
      JARVIS_CLI_NEUTRAL_BASE: "/data/cli-auth/chat",
      LANG: "en_US.UTF-8",
      // EXCLUDED — must NOT cross into the child
      JARVIS_CLI_RUNNER_SOCKET: "/run/jarv1s/cli-runner.sock",
      JARVIS_CLI_RUNNER_RPC_SECRET: "rpc-secret-value",
      JARVIS_CLI_RUNNER_SINGLE_USER: "1",
      BETTER_AUTH_SECRET: "auth-secret",
      JARVIS_AI_SECRET_KEY: "ai-secret",
      JARVIS_CONNECTOR_SECRET_KEY: "connector-secret",
      POSTGRES_PASSWORD: "pg-password",
      JARVIS_APP_DATABASE_URL: "postgres://app:pw@db/app",
      JARVIS_VAULT_ROOT: "/data/vaults"
    };

    const io = createSanitizedTmuxIo(source);
    // Spawn a REAL subprocess (node) that prints ITS OWN env as JSON — this is the env the
    // CLI child would inherit. process.execPath is an absolute path, so PATH is not relied
    // upon to resolve it.
    const result = await io.run(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.env))"
    ]);
    expect(result.code).toBe(0);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;

    // Allowlisted keys survive into the live child.
    expect(childEnv.HOME).toBe("/data/cli-auth");
    expect(childEnv.JARVIS_CLI_NEUTRAL_BASE).toBe("/data/cli-auth/chat");
    expect(childEnv.LANG).toBe("en_US.UTF-8");

    // EXCLUDED — the socket path, RPC secret, and single-user flag never reach the child.
    expect(childEnv.JARVIS_CLI_RUNNER_SOCKET).toBeUndefined();
    expect(childEnv.JARVIS_CLI_RUNNER_RPC_SECRET).toBeUndefined();
    expect(childEnv.JARVIS_CLI_RUNNER_SINGLE_USER).toBeUndefined();

    // EXCLUDED — every app secret / DB URL / vault path is absent from the live child env.
    expect(childEnv.BETTER_AUTH_SECRET).toBeUndefined();
    expect(childEnv.JARVIS_AI_SECRET_KEY).toBeUndefined();
    expect(childEnv.JARVIS_CONNECTOR_SECRET_KEY).toBeUndefined();
    expect(childEnv.POSTGRES_PASSWORD).toBeUndefined();
    expect(childEnv.JARVIS_APP_DATABASE_URL).toBeUndefined();
    expect(childEnv.JARVIS_VAULT_ROOT).toBeUndefined();

    // Belt-and-suspenders: no secret VALUE appears anywhere in the serialized child env.
    const serialized = result.stdout;
    expect(serialized).not.toContain("rpc-secret-value");
    expect(serialized).not.toContain("auth-secret");
    expect(serialized).not.toContain("pg-password");
    expect(serialized).not.toContain("/run/jarv1s/cli-runner.sock");
  });

  it("does NOT pass CLAUDE_CODE_OAUTH_TOKEN through the global allowlist (claude-scoped, #363)", () => {
    // The captured claude credential is injected PER-CALL (the auth probe + the claude launch),
    // never via the §7.2 passthrough — so it can never leak into a codex/gemini CLI child's env.
    const childEnv = buildSanitizedCliEnv({
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-SHOULD-NOT-LEAK"
    });
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
