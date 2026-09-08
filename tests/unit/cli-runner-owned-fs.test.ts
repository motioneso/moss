import { mkdtempSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareOwnedPath, writeOwnedFile } from "../../packages/cli-runner/src/owned-fs.js";

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
});
