/**
 * provider-first-run (#342 chat): seed claude's first-run state so the engine-launched REPL
 * skips its onboarding wizard (login-method/theme) + per-folder trust dialog. Non-claude no-op.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureClaudeOnboarded,
  ensureGeminiOnboarded,
  ensureProviderLaunchReady,
  trustClaudeProject,
  trustCodexProject
} from "../../packages/cli-runner/src/provider-first-run.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "jarv1s-firstrun-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const readCfg = async () =>
  JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8")) as Record<string, unknown>;

describe("provider-first-run (#342 chat)", () => {
  it("seeds the global onboarding flags into a fresh ~/.claude.json", async () => {
    await ensureClaudeOnboarded(home);
    const cfg = await readCfg();
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(cfg.bypassPermissionsModeAccepted).toBe(true);
    expect(cfg.theme).toBe("dark");
  });

  it("preserves claude's existing keys (only adds the missing onboarding flags)", async () => {
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ userID: "abc", theme: "light" }),
      "utf8"
    );
    await ensureClaudeOnboarded(home);
    const cfg = await readCfg();
    expect(cfg.userID).toBe("abc");
    expect(cfg.theme).toBe("light"); // not overwritten when already set
    expect(cfg.hasCompletedOnboarding).toBe(true);
  });

  it("pre-trusts a working dir under projects[dir].hasTrustDialogAccepted", async () => {
    await trustClaudeProject(home, "/data/cli-auth/chat/session-xyz");
    const cfg = await readCfg();
    const projects = cfg.projects as Record<string, Record<string, unknown>>;
    expect(projects["/data/cli-auth/chat/session-xyz"]!.hasTrustDialogAccepted).toBe(true);
  });

  it("ensureProviderLaunchReady seeds onboarding + trust for anthropic", async () => {
    await ensureProviderLaunchReady(home, "anthropic", "/data/cli-auth/chat/s1");
    const cfg = await readCfg();
    expect(cfg.hasCompletedOnboarding).toBe(true);
    const projects = cfg.projects as Record<string, Record<string, unknown>>;
    expect(projects["/data/cli-auth/chat/s1"]!.hasTrustDialogAccepted).toBe(true);
  });

  it("ensureProviderLaunchReady never touches claude's config for another provider", async () => {
    // #2027 gave google its own seeding (.gemini/settings.json). It must still leave claude alone.
    await ensureProviderLaunchReady(home, "google", "/data/cli-auth/chat/s3");
    await expect(readFile(path.join(home, ".claude.json"), "utf8")).rejects.toThrow();
  });
});

describe("codex first-run trust (#342 chat)", () => {
  const readCodexCfg = async () => readFile(path.join(home, ".codex", "config.toml"), "utf8");

  it("creates .codex/config.toml with a trusted project when missing", async () => {
    await trustCodexProject(home, "/data/cli-auth/chat/s1");
    const cfg = await readCodexCfg();
    expect(cfg).toContain('[projects."/data/cli-auth/chat/s1"]');
    expect(cfg).toContain('trust_level = "trusted"');
  });

  it("preserves the installer's check_for_update_on_startup key", async () => {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      "check_for_update_on_startup = false\n",
      "utf8"
    );
    await trustCodexProject(home, "/data/cli-auth/chat/s1");
    const cfg = await readCodexCfg();
    expect(cfg).toContain("check_for_update_on_startup = false");
    expect(cfg).toContain('[projects."/data/cli-auth/chat/s1"]');
    expect(cfg).toContain('trust_level = "trusted"');
  });

  it("does not duplicate the same project section on repeated calls", async () => {
    await trustCodexProject(home, "/data/cli-auth/chat/s1");
    await trustCodexProject(home, "/data/cli-auth/chat/s1");
    const cfg = await readCodexCfg();
    const matches = cfg.match(/\[projects\."\/data\/cli-auth\/chat\/s1"\]/g);
    expect(matches).toHaveLength(1);
  });

  it("can trust multiple distinct dirs without colliding", async () => {
    await trustCodexProject(home, "/data/cli-auth/chat/s1");
    await trustCodexProject(home, "/data/cli-auth/chat/s2");
    const cfg = await readCodexCfg();
    expect(cfg).toContain('[projects."/data/cli-auth/chat/s1"]');
    expect(cfg).toContain('[projects."/data/cli-auth/chat/s2"]');
  });

  it("ensureProviderLaunchReady trusts the dir for openai-compatible", async () => {
    await ensureProviderLaunchReady(home, "openai-compatible", "/data/cli-auth/chat/u1");
    const cfg = await readCodexCfg();
    expect(cfg).toContain('[projects."/data/cli-auth/chat/u1"]');
    expect(cfg).toContain('trust_level = "trusted"');
  });

  it("writes .codex dir 0700 and config.toml 0600", async () => {
    await trustCodexProject(home, "/data/cli-auth/chat/s1");
    const dirMode = (await stat(path.join(home, ".codex"))).mode & 0o777;
    const fileMode = (await stat(path.join(home, ".codex", "config.toml"))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});

describe("gemini first-run: the sign-in-method setting (#2027)", () => {
  const geminiPath = () => path.join(home, ".gemini", "settings.json");
  interface GeminiSettings {
    readonly general?: { enableAutoUpdate?: boolean; enableAutoUpdateNotification?: boolean };
    readonly security?: {
      readonly auth?: { selectedType?: string };
      readonly folderTrust?: { enabled?: boolean };
    };
    readonly ui?: { theme?: string };
  }
  const readGeminiCfg = async () =>
    JSON.parse(await readFile(geminiPath(), "utf8")) as GeminiSettings;

  it("seeds the sign-in method into a fresh settings file", async () => {
    await ensureGeminiOnboarded(home);
    expect((await readGeminiCfg()).security?.auth?.selectedType).toBe("oauth-personal");
  });

  it("PRESERVES the installer's self-update keys in the same file", async () => {
    // #2026 writes general.enableAutoUpdate / enableAutoUpdateNotification here to stop the tool
    // replacing its own pinned bytes. A naive whole-file write would silently re-enable that.
    await mkdir(path.join(home, ".gemini"), { recursive: true });
    await writeFile(
      geminiPath(),
      JSON.stringify(
        { general: { enableAutoUpdate: false, enableAutoUpdateNotification: false } },
        null,
        2
      )
    );

    await ensureGeminiOnboarded(home);

    const cfg = await readGeminiCfg();
    expect(cfg.general?.enableAutoUpdate).toBe(false);
    expect(cfg.general?.enableAutoUpdateNotification).toBe(false);
    expect(cfg.security?.auth?.selectedType).toBe("oauth-personal");
  });

  it("never overwrites a sign-in method that is already set", async () => {
    await mkdir(path.join(home, ".gemini"), { recursive: true });
    await writeFile(
      geminiPath(),
      JSON.stringify({ security: { auth: { selectedType: "vertex-ai" } } }, null, 2)
    );

    await ensureGeminiOnboarded(home);

    expect((await readGeminiCfg()).security?.auth?.selectedType).toBe("vertex-ai");
  });

  it("preserves unrelated keys nested beside the one it sets", async () => {
    await mkdir(path.join(home, ".gemini"), { recursive: true });
    await writeFile(
      geminiPath(),
      JSON.stringify(
        { ui: { theme: "Default" }, security: { folderTrust: { enabled: true } } },
        null,
        2
      )
    );

    await ensureGeminiOnboarded(home);

    const cfg = await readGeminiCfg();
    expect(cfg.ui?.theme).toBe("Default");
    expect(cfg.security?.folderTrust?.enabled).toBe(true);
    expect(cfg.security?.auth?.selectedType).toBe("oauth-personal");
  });

  it("is a no-op on a second call (same bytes)", async () => {
    await ensureGeminiOnboarded(home);
    const first = await readFile(geminiPath(), "utf8");
    await ensureGeminiOnboarded(home);
    expect(await readFile(geminiPath(), "utf8")).toBe(first);
  });

  it("writes .gemini dir 0700 and settings.json 0600", async () => {
    await ensureGeminiOnboarded(home);
    expect((await stat(path.join(home, ".gemini"))).mode & 0o777).toBe(0o700);
    expect((await stat(geminiPath())).mode & 0o777).toBe(0o600);
  });

  it("ensureProviderLaunchReady seeds it for google", async () => {
    await ensureProviderLaunchReady(home, "google", "/data/cli-auth/chat/s3");
    expect((await readGeminiCfg()).security?.auth?.selectedType).toBe("oauth-personal");
  });
});
