/**
 * codex-transcript-purge.mjs (Astra P1, round 4): the script must propagate
 * any real failure by exiting non-zero, and only ever swallow a
 * confirmed-absence error. Run as a real subprocess, since that is how the
 * host actually invokes it and how its exit code is the only channel back.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const script = createRequire(import.meta.url).resolve(
  "../../packages/cli-runner/src/codex-transcript-purge.mjs"
);

function runPurge(root: string, cwd: string) {
  return spawnSync(process.execPath, [script, JSON.stringify({ root, cwd })], {
    encoding: "utf8"
  });
}

describe("codex-transcript-purge.mjs", () => {
  let dir: string | undefined;
  let unreadableFolder: string | undefined;

  afterEach(() => {
    // A folder left unreadable by a test must be restored before cleanup can scan into it.
    if (unreadableFolder) {
      chmodSync(unreadableFolder, 0o700);
      unreadableFolder = undefined;
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("exits 0 when the sessions root does not exist (confirmed absence)", () => {
    dir = mkdtempSync(join(tmpdir(), "codex-purge-"));
    const result = runPurge(join(dir, "no-such-root"), "/some/project");
    expect(result.status).toBe(0);
  });

  it("exits non-zero and reports the failure when a dated folder cannot be read (Astra finding 3)", () => {
    dir = mkdtempSync(join(tmpdir(), "codex-purge-"));
    const root = join(dir, "sessions");
    const dated = join(root, "2026", "09", "09");
    mkdirSync(dated, { recursive: true });
    writeFileSync(
      join(dated, "rollout.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/some/project" } })}\n`
    );
    chmodSync(dated, 0o000);
    unreadableFolder = dated;
    const result = runPurge(root, "/some/project");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/codex transcript purge/);
  });
});
