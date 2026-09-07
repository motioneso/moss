/**
 * Record write versus orphan sweep (#2416 round one): the session folder sits
 * empty between being built and the record file landing in it. A sweep in
 * that window deletes the folder, and the write must rebuild it and try
 * again instead of losing the deadline.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { execRecordPath, readExecRecord } from "../../packages/cli-runner/src/exec-records.js";
import type * as ownedFs from "../../packages/cli-runner/src/owned-fs.js";

/** Base dir handed to the real sweep the mocked write runs mid-write. */
let sweepBase = "";

vi.mock("../../packages/cli-runner/src/owned-fs.js", async (importOriginal) => {
  const real = await importOriginal<typeof ownedFs>();
  return {
    ...real,
    writeOwnedFile: async (...args: Parameters<typeof real.writeOwnedFile>) => {
      if (sweepBase.length > 0) {
        const base = sweepBase;
        sweepBase = "";
        // The real sweep, landing exactly in the empty-folder window.
        const { AcpHost } = await import("../../packages/cli-runner/src/acp-host.js");
        await new AcpHost({ neutralBase: base }).reapOrphanedExecs();
      }
      return real.writeOwnedFile(...args);
    }
  };
});

const KEY = "workshop:user:proj";

describe("record write versus sweep race", () => {
  it("still lands the record when the sweep takes the folder mid-write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-record-race-"));
    try {
      sweepBase = dir;
      const { writeExecRecord } = await import("../../packages/cli-runner/src/exec-records.js");
      await writeExecRecord(dir, KEY, 21, {
        pid: 4242,
        deadlineAt: Date.now() + 60_000,
        sessionKey: KEY,
        projectId: "proj",
        startedAt: Date.now(),
        startTime: null
      });
      const record = await readExecRecord(execRecordPath(dir, KEY, 21));
      expect(record?.pid).toBe(4242);
    } finally {
      sweepBase = "";
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
