import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  handOverOwnedFile,
  handOverOwnedPath,
  prepareOwnedPath,
  prepareOwnedPathWithOwnership,
  writeOwnedFile
} from "../../packages/cli-runner/src/owned-fs.js";

// A plain unprivileged process can never chown to a uid/gid it does not own — real EPERM,
// no fs mock needed. That is exactly the failure task 5b's checkpoint hit on the box.
const UNREACHABLE_UID = 65534;
const UNREACHABLE_GID = 65534;

describe("owned-fs stops rather than warns on a failed ownership handover", () => {
  it("handOverOwnedPath throws and removes the folder it could not hand over", async () => {
    const base = mkdtempSync(join(tmpdir(), "owned-fs-dir-"));
    try {
      const { levels } = await prepareOwnedPathWithOwnership(base, "test", ["agent-home"]);
      await expect(
        handOverOwnedPath("test", levels, UNREACHABLE_UID, UNREACHABLE_GID)
      ).rejects.toThrow(/could not hand the project folder to its owner, launch refused/);
      expect(existsSync(join(base, "agent-home"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("handOverOwnedFile throws and removes the file it could not hand over", async () => {
    const base = mkdtempSync(join(tmpdir(), "owned-fs-file-"));
    const target = join(base, "deny.json");
    try {
      const createdHere = await writeOwnedFile("test", target, "{}");
      await expect(
        handOverOwnedFile("test", target, createdHere, UNREACHABLE_UID, UNREACHABLE_GID)
      ).rejects.toThrow(/could not hand .* to its owner, launch refused/);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves a pre-existing folder in place when a later handover fails (task 5b finding 1)", async () => {
    const base = mkdtempSync(join(tmpdir(), "owned-fs-reuse-dir-"));
    const target = join(base, "agent-home");
    mkdirSync(target);
    try {
      const { levels } = await prepareOwnedPathWithOwnership(base, "test", ["agent-home"]);
      await expect(
        handOverOwnedPath("test", levels, UNREACHABLE_UID, UNREACHABLE_GID)
      ).rejects.toThrow(/could not hand the project folder to its owner, launch refused/);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves a pre-existing file in place when a later handover fails (task 5b finding 1)", async () => {
    const base = mkdtempSync(join(tmpdir(), "owned-fs-reuse-file-"));
    const target = join(base, "deny.json");
    mkdirSync(base, { recursive: true });
    await writeOwnedFile("test", target, '{"already":"here"}');
    try {
      const createdHere = await writeOwnedFile("test", target, "{}");
      expect(createdHere).toBe(false);
      await expect(
        handOverOwnedFile("test", target, createdHere, UNREACHABLE_UID, UNREACHABLE_GID)
      ).rejects.toThrow(/could not hand .* to its owner, launch refused/);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("owned-fs splits shared parents from a per-person leaf (task 5b finding 3)", () => {
  it("leaves a shared prefix segment launcher-owned, pass-through mode, unchowned", async () => {
    const base = mkdtempSync(join(tmpdir(), "owned-fs-shared-"));
    try {
      const { path } = await prepareOwnedPathWithOwnership(base, "test", ["agents", "user-1"], 1);
      expect(path).toBe(join(base, "agents", "user-1"));
      const sharedMode = statSync(join(base, "agents")).mode & 0o777;
      const leafMode = statSync(path).mode & 0o777;
      expect(sharedMode).toBe(0o711);
      expect(leafMode).toBe(0o700);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never attempts to hand a shared prefix segment over, even against an unreachable id", async () => {
    const base = mkdtempSync(join(tmpdir(), "owned-fs-shared-safe-"));
    try {
      // Only the leaf ("user-1") is owner-handed; the shared "agents" segment
      // must be created successfully even though the uid/gid given could
      // never actually be chowned to, proving the shared segment never goes
      // through applyOwnership at all.
      const { levels } = await prepareOwnedPathWithOwnership(base, "test", ["agents", "user-1"], 1);
      await expect(
        handOverOwnedPath("test", levels, UNREACHABLE_UID, UNREACHABLE_GID)
      ).rejects.toThrow(/could not hand the project folder to its owner, launch refused/);
      expect(existsSync(join(base, "agents"))).toBe(true);
      expect((statSync(join(base, "agents")).mode & 0o777) >>> 0).toBe(0o711);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("owned-fs create/handover ordering (task 5b finding 2)", () => {
  it("prepareOwnedPath creates without chowning; the caller writes files before handing over", async () => {
    const base = mkdtempSync(join(tmpdir(), "owned-fs-order-"));
    try {
      const dir = await prepareOwnedPath(base, "test", "agent-home");
      // The launcher itself can still write into the tree: nothing was handed over yet.
      const filePath = join(dir, "opencode.json");
      const createdHere = await writeOwnedFile("test", filePath, "{}");
      expect(createdHere).toBe(true);
      expect(existsSync(filePath)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
