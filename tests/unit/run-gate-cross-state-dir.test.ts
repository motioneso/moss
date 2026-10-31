import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../scripts/test-run-gate-cross-state-dir.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Real regressions for #3672 through the real script, with a stateful fake docker and fake
 * pnpm/node/python3, so no host Docker and no database is involved. The scenario lives in the
 * script itself; this only gives it an owned root and a bound.
 */
describe("run-gate cleanup across state directories", () => {
  it("keeps another state directory's live server and removes real leftovers", () => {
    const root = mkdtempSync(join(tmpdir(), "run-gate-cross-state-"));
    roots.push(root);
    const ownedTmp = join(root, "tmp");
    mkdirSync(ownedTmp, { recursive: true, mode: 0o700 });
    const result = spawnSync("timeout", ["180s", "bash", SCRIPT], {
      encoding: "utf8",
      timeout: 200_000,
      env: { ...process.env, TMPDIR: ownedTmp, N3_GATE_MOCK_ROOT: root }
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toContain("run-gate cross-state-directory tests passed");
  }, 220_000);
});
