import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import { ClaudePrintChatEngine } from "./structured-claude-engine.js";
import { CliTranscriptLocationMismatchError } from "./errors.js";
import type { TmuxIo } from "@moss/ai";

/** A TmuxIo stub: writeFile/run are no-ops, readFile always misses (real transcript reads
 * are driven by the real filesystem in these tests, via existsSync on the directories the
 * test itself creates or withholds — this stub only stands in for the prompt/persona I/O
 * submit() and launch() need to get through without a real `claude` binary). */
function stubIo(): TmuxIo {
  return {
    async run() {
      return { code: 0, stdout: "" };
    },
    async readFile() {
      throw new Error("ENOENT");
    },
    async writeFile() {},
    async sleep() {}
  };
}

const cleanupDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("ClaudePrintChatEngine readNew — genuine transcript-location mismatch", () => {
  it("does not throw while still inside the grace period, even if the folder is missing", async () => {
    const homeBase = tempDir("clh-home-");
    const neutralDir = tempDir("clh-neutral-");
    // Deliberately do NOT create <homeBase>/.claude/projects/<encoded neutralDir> — this is
    // the "app and program disagree about the folder" condition, but we check well before
    // the grace period elapses.
    const engine = new ClaudePrintChatEngine("thread", stubIo(), {
      homeBase,
      transcriptDirGraceMs: 500
    });
    await engine.launch({ neutralDir, personaPath: join(neutralDir, "persona.md") });
    await engine.submit("hello");

    const result = await engine.readNew(0);

    expect(result).toEqual({ records: [], offset: 0, complete: false });
  });

  it("throws a location-mismatch error once the grace period has passed and the folder never appeared", async () => {
    const homeBase = tempDir("clh-home-");
    const neutralDir = tempDir("clh-neutral-");
    const engine = new ClaudePrintChatEngine("thread", stubIo(), {
      homeBase,
      transcriptDirGraceMs: 20
    });
    await engine.launch({ neutralDir, personaPath: join(neutralDir, "persona.md") });
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 40));

    await expect(engine.readNew(0)).rejects.toThrow(CliTranscriptLocationMismatchError);
  });

  it("does not throw once the grace period has passed, as long as the project folder exists", async () => {
    const homeBase = tempDir("clh-home-");
    const neutralDir = tempDir("clh-neutral-");
    const engine = new ClaudePrintChatEngine("thread", stubIo(), {
      homeBase,
      transcriptDirGraceMs: 20
    });
    await engine.launch({ neutralDir, personaPath: join(neutralDir, "persona.md") });
    // Simulate the model program having created its project folder correctly — the specific
    // session .jsonl file just hasn't been written yet, which is the ordinary "still working"
    // case and must never be reported as a mismatch.
    const encoded = neutralDir.replace(/[^a-zA-Z0-9-]/g, "-");
    mkdirSync(join(homeBase, ".claude", "projects", encoded), { recursive: true });
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 40));

    const result = await engine.readNew(0);

    expect(result).toEqual({ records: [], offset: 0, complete: false });
  });
});
