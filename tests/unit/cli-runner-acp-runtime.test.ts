import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultResolveAdapterTarget } from "../../packages/cli-runner/src/acp-host.js";
import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";

// Exercise the installed vendor package, not a fake adapter or a hardcoded lockfile path.
// An empty PATH and isolated HOME represent a connected deployment without a managed CLI.
// Startup uses no credentials and makes no model/prompt request.
describe("Codex ACP bundled runtime", () => {
  it("ships the same pinned Codex version as model discovery", () => {
    const target = defaultResolveAdapterTarget("openai");
    const bundledPackage = createRequire(target.args[0]!).resolve("@openai/codex/package.json");
    const bundled = JSON.parse(readFileSync(bundledPackage, "utf8")) as { version: string };
    expect(bundled.version).toBe(PROVIDER_CATALOG["openai-compatible"].recipe?.version);
  });

  it("runs the aligned bundled executable without a managed Codex on PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "acp-bundled-version-"));
    try {
      const target = defaultResolveAdapterTarget("openai");
      const result = spawnSync(target.command, [...target.args, "cli", "-V"], {
        env: { HOME: home, PATH: home },
        encoding: "utf8",
        timeout: 5000
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        `codex-cli ${PROVIDER_CATALOG["openai-compatible"].recipe?.version}`
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("initializes the real ACP adapter without a managed Codex on PATH", async () => {
    const home = mkdtempSync(join(tmpdir(), "acp-bundled-initialize-"));
    const target = defaultResolveAdapterTarget("openai");
    const child = spawn(target.command, target.args, {
      env: { HOME: home, PATH: home },
      stdio: "pipe"
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const initialized = new Promise<unknown>((resolve, reject) => {
        let buffered = "";
        timeout = setTimeout(() => reject(new Error("ACP initialize timed out")), 5000);
        child.once("error", reject);
        child.once("exit", () => reject(new Error("ACP exited before initialize completed")));
        child.stdout.on("data", (data: Buffer) => {
          buffered += data.toString();
          let newline: number;
          while ((newline = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            const message = JSON.parse(line) as { id?: number };
            if (message.id === 1) resolve(message);
          }
        });
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "moss-test", version: "1" }
          }
        })}\n`
      );
      expect(await initialized).toMatchObject({ result: { protocolVersion: 1 } });
    } finally {
      clearTimeout(timeout);
      try {
        // A failed spawn has no pid; an early exit has already emitted its event.
        // A running adapter closes its Codex child when stdin ends.
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.stdin.end();
          await closed;
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }, 10000);
});
