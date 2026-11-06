import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveRealPaths } from "../../packages/cli-runner/src/acp-resolve-paths.js";

describe("resolveRealPaths (#3557)", () => {
  it("follows a link inside the session folder to where it really points", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-resolve-")));
    try {
      const cwd = join(dir, "session");
      mkdirSync(cwd);
      writeFileSync(join(dir, "outside.txt"), "x");
      symlinkSync("/proc/self/environ", join(cwd, "env-link"));
      symlinkSync(join(dir, "outside.txt"), join(cwd, "out-link"));
      symlinkSync(dir, join(cwd, "dir-link"));
      const [env, out, viaDir, plain, missing] = await resolveRealPaths(cwd, [
        "env-link",
        "out-link",
        "dir-link/outside.txt",
        "plain.txt",
        "dir-link/not-yet/new.txt"
      ]);
      expect(env).toMatch(/^\/proc\/\d+\/environ$/);
      expect(out).toBe(join(dir, "outside.txt"));
      expect(viaDir).toBe(join(dir, "outside.txt"));
      expect(plain).toBe(join(cwd, "plain.txt"));
      expect(missing).toBe(join(dir, "not-yet", "new.txt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends .. through a link to the link's target, not back up the session folder", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-resolve-")));
    try {
      const cwd = join(dir, "session");
      mkdirSync(cwd);
      mkdirSync(join(dir, "home", "inner"), { recursive: true });
      symlinkSync(join(dir, "home", "inner"), join(cwd, "jump"));
      const [up] = await resolveRealPaths(cwd, ["jump/../credentials"]);
      expect(up).toBe(join(dir, "home", "credentials"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses instead of guessing when a folder cannot be entered",
    async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-resolve-")));
      try {
        const locked = join(dir, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        await expect(resolveRealPaths(dir, ["locked/inner/env-link"])).rejects.toThrow();
      } finally {
        chmodSync(join(dir, "locked"), 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it("looks paths up as the session account and rejects an odd answer", async () => {
    const calls: string[][] = [];
    const run = async (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return "/proc/1/environ\0/tmp/x\0";
    };
    const out = await resolveRealPaths("/s", ["env-link", "/tmp/x"], { uid: 4001, gid: 4002 }, run);
    expect(out).toEqual(["/proc/1/environ", "/tmp/x"]);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["setpriv", "--reuid=4001", "--regid=4002", process.execPath])
    );
    expect(calls[0]).toEqual(expect.arrayContaining(["/s/env-link", "/tmp/x"]));
    await expect(
      resolveRealPaths("/s", ["a", "b"], { uid: 1, gid: 1 }, async () => "only-one\0")
    ).rejects.toThrow();
    await expect(
      resolveRealPaths("/s", ["a"], { uid: 1, gid: 1 }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});
