import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
});
