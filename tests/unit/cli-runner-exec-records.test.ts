/**
 * Exec deadline records (#2413 item 3): the recorded process start time is
 * an opaque boot-relative tick. It is stored verbatim and only ever compared
 * for equality against the live process — never parsed, never assumed unique
 * across restarts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  execRecordPath,
  readExecRecord,
  writeExecRecord
} from "../../packages/cli-runner/src/exec-records.js";

const KEY = "workshop:user:proj";

describe("exec deadline records", () => {
  it("round-trips the boot-relative start time verbatim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-records-"));
    try {
      await writeExecRecord(dir, KEY, 3, {
        pid: 4242,
        deadlineAt: Date.now() + 60_000,
        sessionKey: KEY,
        projectId: "proj",
        startedAt: Date.now(),
        startTime: "12345"
      });
      const record = await readExecRecord(execRecordPath(dir, KEY, 3));
      expect(record?.pid).toBe(4242);
      expect(record?.startTime).toBe("12345");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a missing start time as null, never acted on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-records-"));
    try {
      await writeExecRecord(dir, KEY, 4, {
        pid: 4243,
        deadlineAt: Date.now() + 60_000,
        sessionKey: KEY,
        projectId: "proj",
        startedAt: Date.now(),
        startTime: null
      });
      const record = await readExecRecord(execRecordPath(dir, KEY, 4));
      expect(record?.startTime).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects records that are not what we wrote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-records-"));
    try {
      expect(await readExecRecord(join(dir, "missing.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
