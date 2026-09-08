import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  prepareOwnedPath,
  prepareOwnedPathWithOwnership,
  writeOwnedFile
} from "../../packages/cli-runner/src/owned-fs.js";

// A plain unprivileged process can never chown to a uid/gid it does not own — real EPERM,
// no fs mock needed. That is exactly the failure task 5b's checkpoint hit on the box.
const UNREACHABLE_UID = 65534;
const UNREACHABLE_GID = 65534;

describe("owned-fs stops rather than warns on a failed ownership handover", () => {
  it("prepareOwnedPath throws and removes the folder it could not hand over", async () => {
    const base = mkdtempSync(join(tmpdir(), "owned-fs-dir-"));
    try {
      await expect(
        prepareOwnedPath(base, "test", UNREACHABLE_UID, UNREACHABLE_GID, "agent-home")
      ).rejects.toThrow(/could not hand the project folder to its owner, launch refused/);
      expect(existsSync(join(base, "agent-home"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("writeOwnedFile throws and removes the file it could not hand over", async () => {
    const base = mkdtempSync(join(tmpdir(), "owned-fs-file-"));
    const target = join(base, "deny.json");
    try {
      await expect(
        writeOwnedFile("test", target, "{}", UNREACHABLE_UID, UNREACHABLE_GID)
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
      await expect(
        prepareOwnedPath(base, "test", UNREACHABLE_UID, UNREACHABLE_GID, "agent-home")
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
    await writeOwnedFile("test", target, '{"already":"here"}', undefined, undefined);
    try {
      await expect(
        writeOwnedFile("test", target, "{}", UNREACHABLE_UID, UNREACHABLE_GID)
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
      const path = await prepareOwnedPathWithOwnership(
        base,
        "test",
        undefined,
        undefined,
        ["agents", "user-1"],
        undefined,
        1
      );
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
      await expect(
        prepareOwnedPathWithOwnership(
          base,
          "test",
          UNREACHABLE_UID,
          UNREACHABLE_GID,
          ["agents", "user-1"],
          undefined,
          1
        )
      ).rejects.toThrow(/could not hand the project folder to its owner, launch refused/);
      expect(existsSync(join(base, "agents"))).toBe(true);
      expect((statSync(join(base, "agents")).mode & 0o777) >>> 0).toBe(0o711);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
