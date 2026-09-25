/**
 * AcpHost refusals: a launch that cannot run safely fails before any slot, folder or file work.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AcpHost } from "../../packages/cli-runner/src/acp-host.js";
import type { CodexHomeAccess } from "../../packages/cli-runner/src/codex-shared-login.js";

const selfSlot = (): { uid: number; gid: number } => ({
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0
});

const noCodexLogin = (): CodexHomeAccess => ({
  read: async () => null,
  write: async () => undefined
});

describe("identity off refuses before any slot or file work", () => {
  it("refuses the launch and writes no file anywhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const child = new EventEmitter();
      const host = new AcpHost({
        neutralBase: dir,
        homeBase: home,
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        spawnChild: () => child as never
      });
      await expect(
        host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat")
      ).rejects.toThrow(/per-user identity/);
      // No slot was allocated and no deny file was written, here or anywhere.
      expect(existsSync(join(home, "uid-slots.json"))).toBe(false);
      expect(existsSync(join(home, "agents"))).toBe(false);
      expect(existsSync(join(dir, "chat:user-1:a"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("not-ready rows refuse at the launcher", () => {
  it("refuses a not-ready row with Not logged in and no side effects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const host = new AcpHost({
        neutralBase: dir,
        homeBase: home,
        perUserUid: true,
        allocateUidSlot: selfSlot,
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        runAgentHomePrepare: async () => {
          throw new Error("Not logged in (no usable Codex credential in your runner home)");
        },
        codexHomeAccess: noCodexLogin
      });
      await expect(host.spawn("chat:user-1:a", "proj", "openai", "user-1", "chat")).rejects.toThrow(
        /Not logged in \(no usable Codex credential in your runner home\)/
      );
      expect(existsSync(join(home, "uid-slots.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
