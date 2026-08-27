import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const HOOK_PATH = resolve(__dirname, "../../.claude/hooks/check-gate-pipe.sh");

async function runHook(command: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn("bash", [HOOK_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stderr };
}

describe("check-gate-pipe.sh", () => {
  it("blocks a piped verify:foundation and points at scripts/run-gate.sh", async () => {
    const { code, stderr } = await runHook("pnpm verify:foundation | tail -20");
    expect(code).toBe(2);
    expect(stderr).toContain("scripts/run-gate.sh");
  });

  it("blocks a piped test:integration and points at scripts/run-gate.sh", async () => {
    const { code, stderr } = await runHook("pnpm test:integration | cat");
    expect(code).toBe(2);
    expect(stderr).toContain("scripts/run-gate.sh");
  });

  it("blocks a piped db:migrate and points at scripts/run-gate.sh", async () => {
    const { code, stderr } = await runHook("pnpm db:migrate | tee /tmp/x");
    expect(code).toBe(2);
    expect(stderr).toContain("scripts/run-gate.sh");
  });

  it("blocks a piped test:uat-seed and points at scripts/run-gate.sh", async () => {
    const { code, stderr } = await runHook("pnpm test:uat-seed | cat");
    expect(code).toBe(2);
    expect(stderr).toContain("scripts/run-gate.sh");
  });

  it("blocks a piped lint with redirect-and-exit-code advice, not run-gate.sh", async () => {
    const { code, stderr } = await runHook("pnpm lint | tail -20");
    expect(code).toBe(2);
    expect(stderr).not.toContain("scripts/run-gate.sh");
    expect(stderr).toContain("EXIT=$?");
  });

  it("allows a piped gate command through when pipefail is set first", async () => {
    const { code } = await runHook("set -o pipefail; pnpm verify:foundation | tail -20");
    expect(code).toBe(0);
  });

  it("allows a piped gate command through when PIPESTATUS is checked", async () => {
    const { code } = await runHook("pnpm verify:foundation | tail -20; echo ${PIPESTATUS[0]}");
    expect(code).toBe(0);
  });

  it("allows a non-gate piped command through untouched", async () => {
    const { code } = await runHook("echo hello | wc -l");
    expect(code).toBe(0);
  });
});
