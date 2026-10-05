import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const RUN_GATE = resolve(__dirname, "../../scripts/run-gate.sh");
const tempDirs: string[] = [];

function fixture(logContents: string, psScript = "exit 1") {
  const dir = mkdtempSync(join(tmpdir(), "run-gate-wait-"));
  tempDirs.push(dir);
  const bin = join(dir, "bin");
  const log = join(dir, "gate.log");
  mkdirSync(bin);
  writeFileSync(log, logContents);
  writeFileSync(join(bin, "ps"), `#!/usr/bin/env bash\n${psScript}\n`, { mode: 0o755 });

  return (args: string[]) =>
    spawnSync("bash", [RUN_GATE, "wait", "--log", log, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_GATE_LOG: log }
    });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("run-gate wait verdicts (synthetic logs, no services)", () => {
  it.each([
    [0, 0],
    [7, 1]
  ])("returns %i's terminal sentinel status %i", (gateRc, expectedStatus) => {
    const wait = fixture(`### FINAL rc=${gateRc}\n`);
    const result = wait(["--follow"]);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain(`DONE rc=${gateRc}`);
    expect(result.status).toBe(expectedStatus);
  });

  it.each([
    [0, 0],
    [7, 1]
  ])("uses rc=%i written during the PID probe instead of stale DEAD status", (gateRc, status) => {
    // Reproduce runner completion between the quiet verdict's sentinel read and
    // PID check. The next verdict prints DONE, so its exit status must agree.
    const wait = fixture(
      "### PID 999999\n",
      `printf '### FINAL rc=${gateRc}\\n' >>"$TEST_GATE_LOG"\nexit 1`
    );
    const result = wait(["--follow"]);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain(`DONE rc=${gateRc}`);
    expect(result.status).toBe(status);
  });

  it.each([
    [0, 0],
    [7, 1]
  ])("uses rc=%i observed when a bounded wait reaches its deadline", (gateRc, status) => {
    // The initial probe sees a live runner, then its sentinel lands before the
    // timeout's reporting verdict. Completion takes precedence over timeout.
    const wait = fixture(
      "### PID 999999\n",
      `if [ "$2" = "sid=" ]; then
  printf '999999\\n'
else
  printf '### FINAL rc=${gateRc}\\n' >>"$TEST_GATE_LOG"
  printf 'bash run-gate.sh __run %s\\n' "$TEST_GATE_LOG"
fi`
    );
    const result = wait(["--timeout", "0"]);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain(`DONE rc=${gateRc}`);
    expect(result.stdout).not.toContain("timeout");
    expect(result.status).toBe(status);
  });

  it("still reports DEAD when the runner disappeared without a sentinel", () => {
    const result = fixture("### PID 999999\n")(["--follow"]);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain("DEAD");
    expect(result.status).toBe(2);
  });

  it("still reports RUNNING at a bounded timeout without a terminal verdict", () => {
    const result = fixture("### GATE pnpm synthetic-gate\n")(["--timeout", "0"]);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain("RUNNING");
    expect(result.stdout).toContain("timeout after 0s");
    expect(result.status).toBe(3);
  });
});
