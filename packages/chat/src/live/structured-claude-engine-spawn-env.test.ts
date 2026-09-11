import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, afterEach, vi } from "vitest";

import type { TmuxIo } from "@moss/ai";
import type * as NodeChildProcess from "node:child_process";

/**
 * #2348 — proves the two spawns in this file (submit() and launchStructured()) pass the
 * engine's configured home folder into the child's own environment, instead of silently
 * letting the child inherit whatever HOME the server process happens to have. That mismatch
 * is exactly what made the app and the model program disagree about where the answer file
 * lives in production.
 */
const spawnCalls: Array<{ command: string; options: Record<string, unknown> }> = [];

function fakeChild(): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdout.setEncoding = () => {};
  child.stdout = stdout;
  const stderr = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stderr.setEncoding = () => {};
  stderr.resume = () => {};
  child.stderr = stderr;
  child.stdin = { destroyed: false, write: () => {}, end: () => {} };
  child.unref = () => {};
  child.kill = () => true;
  return child;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command: [command, ...args].join(" "), options });
      return fakeChild();
    }
  };
});

const { ClaudePrintChatEngine } = await import("./structured-claude-engine.js");

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
  spawnCalls.length = 0;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("ClaudePrintChatEngine passes the configured home folder into every spawn", () => {
  it("submit() sets the child's HOME to the engine's homeBase", async () => {
    const homeBase = tempDir("cpce-home-");
    const neutralDir = tempDir("cpce-neutral-");
    const engine = new ClaudePrintChatEngine("thread", stubIo(), { homeBase });
    await engine.launch({ neutralDir, personaPath: join(neutralDir, "persona.md") });

    await engine.submit("hello");

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]!.options.env as Record<string, string> | undefined;
    expect(env).toBeDefined();
    expect(env!.HOME).toBe(homeBase);
  });

  it("launchStructured() sets the child's HOME to the engine's homeBase", async () => {
    const homeBase = tempDir("cpce-home-");
    const neutralDir = tempDir("cpce-neutral-");
    const engine = new ClaudePrintChatEngine("thread", stubIo(), { homeBase });

    await engine.launchStructured({
      neutralDir,
      personaPath: join(neutralDir, "persona.md"),
      schema: { type: "object", properties: {} }
    });

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]!.options.env as Record<string, string> | undefined;
    expect(env).toBeDefined();
    expect(env!.HOME).toBe(homeBase);
  });

  it("submit() leaves env unset (inherits the parent's) when no homeBase was configured", async () => {
    const neutralDir = tempDir("cpce-neutral-");
    const engine = new ClaudePrintChatEngine("thread", stubIo(), {});
    await engine.launch({ neutralDir, personaPath: join(neutralDir, "persona.md") });

    await engine.submit("hello");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.options.env).toBeUndefined();
  });
});
