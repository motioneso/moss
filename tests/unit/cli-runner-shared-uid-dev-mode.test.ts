/**
 * Development-only shared-account mode (MOSS_CLI_ALLOW_SHARED_UID). With per-user mode off, the
 * runner refuses chat launches and logins. The opt-in lets a development host run them as the
 * runner's own account instead. It is honoured only with NODE_ENV=development, so production
 * stays exactly as strict as before.
 *
 * These tests run unprivileged on purpose: in shared mode no step may need setpriv, so the real
 * home-preparation step and the real purge run here without any fake.
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AcpHost } from "../../packages/cli-runner/src/acp-host.js";
import { writeAcpPrivateMarker } from "../../packages/cli-runner/src/acp-private-markers.js";
import {
  readConfig,
  readSharedUidOptIn,
  resolveIsolatedUserRuntime,
  sharedUidStartupWarning
} from "../../packages/cli-runner/src/main.js";

const BASE_ENV: NodeJS.ProcessEnv = { JARVIS_CLI_RUNNER_RPC_SECRET: "x" };
const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: (): void => undefined };
  kill(): boolean {
    return true;
  }
}

function makeSharedHost(dir: string, allowSharedUid: boolean | undefined) {
  const spawns: { uid?: number; gid?: number; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const homeBase = join(dir, "homes");
  mkdirSync(homeBase, { recursive: true });
  const host = new AcpHost({
    neutralBase: dir,
    homeBase,
    perUserUid: false,
    allowSharedUid,
    resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
    spawnChild: (opts) => {
      spawns.push({ uid: opts.uid, gid: opts.gid, env: opts.env, cwd: opts.cwd });
      return new FakeChild() as never;
    }
  });
  return { host, homeBase, spawns };
}

describe("shared-account opt-in is honoured only in development", () => {
  it("honours the opt-in with NODE_ENV=development", () => {
    const env = { ...BASE_ENV, NODE_ENV: "development", MOSS_CLI_ALLOW_SHARED_UID: "1" };
    expect(readSharedUidOptIn(env)).toBe("honoured");
    expect(readConfig(env).allowSharedUid).toBe(true);
    expect(sharedUidStartupWarning(env)).toMatch(/WARNING: MOSS_CLI_ALLOW_SHARED_UID=1/);
  });

  it("ignores the opt-in in production, and says so at startup", () => {
    const env = { ...BASE_ENV, NODE_ENV: "production", MOSS_CLI_ALLOW_SHARED_UID: "1" };
    expect(readSharedUidOptIn(env)).toBe("ignored");
    expect(readConfig(env).allowSharedUid).toBe(false);
    expect(sharedUidStartupWarning(env)).toMatch(/ignored.*NODE_ENV is production/);
  });

  it("ignores the opt-in when NODE_ENV is unset", () => {
    const env = { ...BASE_ENV, MOSS_CLI_ALLOW_SHARED_UID: "1" };
    expect(readConfig(env).allowSharedUid).toBe(false);
    expect(sharedUidStartupWarning(env)).toMatch(/NODE_ENV is unset/);
  });

  it("is off, silently, when not set", () => {
    const env = { ...BASE_ENV, NODE_ENV: "development" };
    expect(readConfig(env).allowSharedUid).toBe(false);
    expect(sharedUidStartupWarning(env)).toBeNull();
  });

  it("leaves per-user mode in charge when both are set", () => {
    const env = {
      ...BASE_ENV,
      NODE_ENV: "development",
      MOSS_CLI_ALLOW_SHARED_UID: "1",
      JARVIS_CLI_PER_USER_UID: "1"
    };
    const config = readConfig(env);
    expect(config.perUserUid).toBe(true);
    expect(config.allowSharedUid).toBe(false);
  });
});

describe("chat launch without per-user mode", () => {
  it("refuses in production even with the opt-in set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-shared-"));
    try {
      const config = readConfig({
        ...BASE_ENV,
        NODE_ENV: "production",
        MOSS_CLI_ALLOW_SHARED_UID: "1"
      });
      const { host, spawns } = makeSharedHost(dir, config.allowSharedUid);
      await expect(host.spawn("chat:u:p", "p", "anthropic", "user-1", "chat")).rejects.toThrow(
        /refusing the shared home/
      );
      expect(spawns).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("launches in development as the runner's own account, in the person's own home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-shared-"));
    try {
      const config = readConfig({
        ...BASE_ENV,
        NODE_ENV: "development",
        MOSS_CLI_ALLOW_SHARED_UID: "1"
      });
      const { host, homeBase, spawns } = makeSharedHost(dir, config.allowSharedUid);
      const spawned = await host.spawn("chat:u:p", "p", "anthropic", "user-1", "chat");

      // No identity switch: the child is spawned directly, never through setpriv.
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.uid).toBeUndefined();
      expect(spawns[0]?.gid).toBeUndefined();
      // The result names the account the agent really runs as.
      expect({ uid: spawned.uid, gid: spawned.gid }).toEqual(self);
      // Each person keeps their own home, never the shared base.
      const agentHome = join(homeBase, "agents", "user-1");
      expect(spawned.home).toBe(agentHome);
      expect(spawns[0]?.env.HOME).toBe(agentHome);
      // The real home-preparation step ran unprivileged and made the session folder.
      expect(statSync(spawned.cwd).isDirectory()).toBe(true);

      // A second launch for the same person reuses the home they already own.
      const again = await host.spawn("chat:u:p2", "p", "anthropic", "user-1", "chat");
      expect(again.home).toBe(agentHome);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boot sweep purges a shared-mode leftover without setpriv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-shared-"));
    try {
      const orphan = join(dir, "orphan-scratch");
      mkdirSync(orphan, { recursive: true });
      writeFileSync(join(orphan, "leftover.txt"), "stale");
      const gone = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      await writeAcpPrivateMarker(dir, "chat:orphan:p", {
        sessionKey: "chat:orphan:p",
        cwd: orphan,
        home: join(dir, "homes", "agents", "user-1"),
        provider: "anthropic",
        pid: gone.pid ?? -1,
        startTime: String(gone.pid),
        ...self
      });
      const host = new AcpHost({
        neutralBase: dir,
        homeBase: join(dir, "homes"),
        perUserUid: false,
        allowSharedUid: true,
        readProcStatus: () => ({ kind: "gone" })
      });
      expect(await host.sweepPrivateMarkers()).toBe(true);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("login runtime without per-user mode", () => {
  it("refuses without the opt-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-shared-"));
    try {
      await expect(
        resolveIsolatedUserRuntime({ perUserUid: false, homeBase: dir }, "user-1")
      ).rejects.toThrow(/refusing shared-home login/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs as the runner's own account in the person's own home with the opt-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-shared-"));
    try {
      const runtime = await resolveIsolatedUserRuntime(
        { perUserUid: false, allowSharedUid: true, homeBase: dir },
        "user-1"
      );
      expect({ uid: runtime.uid, gid: runtime.gid }).toEqual(self);
      expect(runtime.homeBase).toBe(join(dir, "agents", "user-1"));
      const probe = await runtime.io.run("id", ["-u"]);
      expect(probe.stdout.trim()).toBe(String(self.uid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
