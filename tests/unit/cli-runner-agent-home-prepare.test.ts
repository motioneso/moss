import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("agent-home-prepare", () => {
  it("writes the OpenCode deny file from the table, preserving the rest", async () => {
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const existingDir = join(home, "agents", "user-1", ".config", "opencode");
      mkdirSync(existingDir, { recursive: true });
      writeFileSync(
        join(existingDir, "opencode.json"),
        JSON.stringify({ model: "keep-me", permission: { read: "allow" } })
      );
      const { opencodeDenyPermissionKeys } = await import("../../packages/acp/src/providers.js");
      const expected = opencodeDenyPermissionKeys();
      const scriptPath = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");
      const request = JSON.stringify({
        dirs: [existingDir],
        denyFile: { path: join(existingDir, "opencode.json"), permissionKeys: expected }
      });
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(process.execPath, [scriptPath, request], { encoding: "utf8" });
      expect(result.status).toBe(0);
      const written = JSON.parse(
        readFileSync(join(home, "agents", "user-1", ".config", "opencode", "opencode.json"), "utf8")
      ) as { model?: string; permission?: Record<string, string> };
      expect(expected).toEqual(expect.arrayContaining(["bash", "edit", "write"]));
      for (const key of expected) expect(written.permission?.[key]).toBe("deny");
      expect(written.model).toBe("keep-me");
      expect(written.permission?.read).toBe("allow");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes secret preparation files from stdin with owner-only mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const target = join(home, "agents", "user-1", ".codex", "auth.json");
      const scriptPath = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");
      const { spawnSync } = await import("node:child_process");
      mkdirSync(join(home, "agents", "user-1", ".codex"), { recursive: true });
      writeFileSync(target, "old-auth", { mode: 0o644 });
      const result = spawnSync(
        process.execPath,
        [scriptPath, JSON.stringify({ dirs: [], denyFile: null })],
        {
          encoding: "utf8",
          input: JSON.stringify([{ path: target, content: "fixture-auth" }])
        }
      );
      expect(result.status).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("fixture-auth");
      expect((statSync(target).mode & 0o777).toString(8)).toBe("600");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails loudly and preserves malformed existing settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const configDir = join(home, "config");
      const configPath = join(configDir, "opencode.json");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, "{ not-json");
      const scriptPath = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");
      const request = JSON.stringify({
        dirs: [configDir],
        denyFile: { path: configPath, permissionKeys: ["bash"] }
      });
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(process.execPath, [scriptPath, request], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe("{ not-json");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
