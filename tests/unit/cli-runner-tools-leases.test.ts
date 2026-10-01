/**
 * Release leases (#2689 slice 4, spec 6.5): a running session keeps its release folder.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireLeases,
  hasLiveLease,
  readProcStartTime
} from "../../packages/cli-runner/src/tools-leases.js";

let prefix: string;
beforeEach(async () => {
  prefix = await mkdtemp(path.join(tmpdir(), "jarv1s-leases-"));
});
afterEach(async () => {
  await rm(prefix, { recursive: true, force: true });
});

const target = { slot: "anthropic", release: "abc123" };
const leaseDir = () => path.join(prefix, "providers", "anthropic", "leases", "abc123");

describe("tools leases", () => {
  it("reads the start time of a live process and null for a missing one", async () => {
    expect(await readProcStartTime(process.pid)).toMatch(/^\d+$/);
    expect(await readProcStartTime(2 ** 22 + 12345)).toBeNull();
  });

  it("writes a lease named pid-starttime and removes it on release", async () => {
    const handle = await acquireLeases(prefix, [target]);
    const start = await readProcStartTime(process.pid);
    expect(await readdir(leaseDir())).toEqual([`${process.pid}-${start}`]);
    expect(await hasLiveLease(prefix, target)).toBe(true);
    await handle.release();
    expect(await hasLiveLease(prefix, target)).toBe(false);
  });

  it("holds a lease on every release it is given", async () => {
    const other = { slot: "anthropic-adapter", release: "zzz" };
    const handle = await acquireLeases(prefix, [target, other]);
    expect(await hasLiveLease(prefix, target)).toBe(true);
    expect(await hasLiveLease(prefix, other)).toBe(true);
    await handle.release();
  });

  it("moves the lease to the launched process on adopt", async () => {
    const child = spawn("sleep", ["30"]);
    try {
      const handle = await acquireLeases(prefix, [target]);
      await handle.adopt(child.pid as number);
      const names = await readdir(leaseDir());
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(new RegExp(`^${child.pid}-`));
      await handle.release();
    } finally {
      child.kill();
    }
  });

  it("deletes a lease whose process is gone, and one whose pid was reused", async () => {
    await mkdir(leaseDir(), { recursive: true });
    await writeFile(path.join(leaseDir(), `${2 ** 22 + 99}-1`), "");
    await writeFile(path.join(leaseDir(), `${process.pid}-1`), "");
    expect(await hasLiveLease(prefix, target)).toBe(false);
    await expect(readdir(leaseDir())).rejects.toThrow();
  });

  it("calls onIdle when the last lease goes and not while another remains", async () => {
    const onIdle = vi.fn();
    const child = spawn("sleep", ["30"]);
    try {
      const first = await acquireLeases(prefix, [target], onIdle);
      await first.adopt(process.pid);
      const second = await acquireLeases(prefix, [target], onIdle);
      await second.adopt(child.pid as number);
      await first.release();
      expect(onIdle).not.toHaveBeenCalled();
      await second.release();
      expect(onIdle).toHaveBeenCalledWith(target);
    } finally {
      child.kill();
    }
  });
});
