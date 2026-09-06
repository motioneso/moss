/**
 * #2340: resolveDefaultToolsPrefix() picks the per-user managed tools folder unless a
 * machine-root install already exists there, so a fresh unprivileged account gets a
 * folder it can actually create.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import { resolveDefaultToolsPrefix } from "../../packages/cli-runner/src/tools-prefix.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarv1s-tools-prefix-"));
  cleanup.push(dir);
  return dir;
}

describe("resolveDefaultToolsPrefix (#2340)", () => {
  it("returns the managed folder when neither folder has a bin yet", async () => {
    const managed = await freshDir();
    const machine = await freshDir();

    expect(resolveDefaultToolsPrefix(managed, machine)).toBe(managed);
  });

  it("falls back to the machine folder when only its bin exists", async () => {
    const managed = await freshDir();
    const machine = await freshDir();
    await mkdir(path.join(machine, "bin"), { recursive: true });

    expect(resolveDefaultToolsPrefix(managed, machine)).toBe(machine);
  });

  it("prefers the managed folder when its bin exists, regardless of the machine folder", async () => {
    const managed = await freshDir();
    const machine = await freshDir();
    await mkdir(path.join(managed, "bin"), { recursive: true });
    await mkdir(path.join(machine, "bin"), { recursive: true });

    expect(resolveDefaultToolsPrefix(managed, machine)).toBe(managed);
  });
});
