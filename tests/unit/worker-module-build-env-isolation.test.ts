/**
 * #1860 — module-build subprocess environment isolation.
 *
 * The worker used to hand every module-build subprocess (tmux, the provider CLI, post-write
 * build commands) its own complete environment, including secrets. `createModuleBuildIo` closes
 * that gap by routing those subprocesses through the same sanitized allowlist the chat path
 * already uses. These tests exercise the real factory through a real child process so a revert to
 * the old, unsanitized composition fails case 1.
 */

import { describe, expect, it } from "vitest";

import { createModuleBuildIo } from "../../apps/worker/src/worker.js";

async function deliveredEnv(source: NodeJS.ProcessEnv, moduleBuildCliHome: string) {
  const io = createModuleBuildIo(moduleBuildCliHome, source);
  const printEnvScript = "process.stdout.write(JSON.stringify(process.env))";
  const result = await io.run(process.execPath, ["-e", printEnvScript]);
  return JSON.parse(result.stdout) as Record<string, string | undefined>;
}

describe("createModuleBuildIo (#1860 env isolation)", () => {
  it("drops secrets and attacker-controlled UAT values, and overrides HOME", async () => {
    const source: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: "/root",
      JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/tmp/evil-bin",
      JARVIS_UAT_SEED_CHAT_SCRIPT: "/tmp/evil.script",
      MOSS_DATABASE_URL: "postgres://x",
      POSTGRES_PASSWORD: "pw",
      BETTER_AUTH_SECRET: "s",
      JARVIS_AI_SECRET_KEY: "k",
      JARVIS_VAULT_DIR: "/v"
    };

    const env = await deliveredEnv(source, "/tmp/mb-home");

    expect(env.HOME).toBe("/tmp/mb-home");
    expect(env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN).toBeUndefined();
    expect(env.JARVIS_UAT_SEED_CHAT_SCRIPT).toBeUndefined();
    expect(env.MOSS_DATABASE_URL).toBeUndefined();
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.JARVIS_AI_SECRET_KEY).toBeUndefined();
    expect(env.JARVIS_VAULT_DIR).toBeUndefined();
  });

  it("still passes through the shipped UAT fixture pin", async () => {
    const source: NodeJS.ProcessEnv = {
      ...process.env,
      JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/app/tests/uat/fixtures/scripted-provider/bin",
      JARVIS_UAT_SEED_CHAT_SCRIPT: "seed-script-value"
    };

    const env = await deliveredEnv(source, "/tmp/mb-home");

    expect(env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN).toBe(
      "/app/tests/uat/fixtures/scripted-provider/bin"
    );
    expect(env.JARVIS_UAT_SEED_CHAT_SCRIPT).toBe("seed-script-value");
  });

  it("drops a paired seed script when the fixture bin is rejected", async () => {
    const source: NodeJS.ProcessEnv = {
      ...process.env,
      JARVIS_UAT_SCRIPTED_PROVIDER_BIN: "/tmp/evil-bin",
      JARVIS_UAT_SEED_CHAT_SCRIPT: "seed-script-value"
    };

    const env = await deliveredEnv(source, "/tmp/mb-home");

    expect(env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN).toBeUndefined();
    expect(env.JARVIS_UAT_SEED_CHAT_SCRIPT).toBeUndefined();
  });
});
