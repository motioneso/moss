/**
 * #2687 — reading another user's Codex login runs a process as that user, who controls both the
 * file and the process. A read must end on time and hold a bounded amount of output.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCodexAuthFileReader } from "../../packages/cli-runner/src/acp-codex-auth.js";
import { runBounded } from "../../packages/cli-runner/src/per-user-structured.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runBounded", () => {
  it("gives up on a process that outlives its deadline", async () => {
    const started = Date.now();
    const result = await runBounded(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {},
      "",
      {
        timeoutMs: 300,
        maxOutputBytes: 1024
      }
    );
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops a process whose output passes the cap", async () => {
    const result = await runBounded(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1 << 20)); setInterval(() => {}, 1000)"],
      {},
      "",
      { timeoutMs: 10_000, maxOutputBytes: 1024 }
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + 65_536);
  });
});

describe("Codex login reader", () => {
  it("refuses a login file too large to be one", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-reader-"));
    dirs.push(home);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), "x".repeat(1 << 20));
    const read = createCodexAuthFileReader({
      homeBase: home,
      userId: "",
      io: {
        run: (cmd, args) =>
          new Promise((resolve) => {
            const child = spawn(cmd, [...args]);
            let stdout = "";
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => (stdout += chunk));
            child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
          })
      }
    });
    await expect(read(join(home, ".codex", "auth.json"))).rejects.toThrow();
  });
});
