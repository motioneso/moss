import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, afterEach, vi } from "vitest";

import type { TmuxIo } from "@moss/ai";

/**
 * #2348 — proves the default (non-test-injected) spawnChild factory passes the runtime's
 * configured home folder into the child's own environment, instead of silently letting the
 * child inherit whatever HOME the server process happens to have. Does not use the
 * spawnChild injection seam on purpose — that seam would bypass the exact factory this
 * fix lives in. Codex spawns its child inside submitTurn(), not launch(), so the test
 * drives both.
 */
const spawnCalls: Array<{ command: string; options: Record<string, unknown> }> = [];

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.resume = () => {};
  child.stdin = { write: (_d: unknown, _e: unknown, cb: (e?: Error) => void) => cb() };
  child.kill = () => true;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command: [command, ...args].join(" "), options });
      return fakeChild();
    }
  };
});

const { CodexPersistentRuntime } = await import("./codex-persistent-runtime.js");

function stubIo(): Pick<TmuxIo, "run" | "writeFile"> {
  return {
    async run() {
      return { code: 0, stdout: "" };
    },
    async writeFile() {}
  };
}

const cleanupDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  spawnCalls.length = 0;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("CodexPersistentRuntime's default spawn passes the configured home folder", () => {
  it("sets the child's HOME to the runtime's homeBase", async () => {
    const homeBase = tempDir("cxpr-home-");
    const neutralDir = tempDir("cxpr-neutral-");
    const runtime = new CodexPersistentRuntime({ io: stubIo(), homeBase });

    await runtime.launch({
      neutralDir,
      personaPath: join(neutralDir, "persona.md"),
      mcpToken: "tok",
      mcpServerUrl: "http://localhost:1",
      mcpReadiness: async () => undefined
    } as never);
    await runtime.submitTurn("turn-1", "hello");

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]!.options.env as Record<string, string> | undefined;
    expect(env).toBeDefined();
    expect(env!.HOME).toBe(homeBase);
  });

  it("leaves env unset (inherits the parent's) when no homeBase was configured", async () => {
    const neutralDir = tempDir("cxpr-neutral-");
    const runtime = new CodexPersistentRuntime({ io: stubIo() });

    await runtime.launch({
      neutralDir,
      personaPath: join(neutralDir, "persona.md"),
      mcpToken: "tok",
      mcpServerUrl: "http://localhost:1",
      mcpReadiness: async () => undefined
    } as never);
    await runtime.submitTurn("turn-1", "hello");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.options.env).toBeUndefined();
  });
});
