import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { describe, expect, it, afterEach, vi } from "vitest";

import type { TmuxIo } from "@moss/ai";

/**
 * #2348 — proves the gemini engine's one spawn passes the engine's configured home folder
 * into the child's own environment, instead of silently letting the child inherit whatever
 * HOME the server process happens to have.
 */
const spawnCalls: Array<{ command: string; options: Record<string, unknown> }> = [];

function fakeChild() {
  const child: any = new EventEmitter();
  child.unref = () => {};
  child.kill = () => true;
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

const { GeminiPrintChatEngine } = await import("./gemini-print-chat-engine.js");

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

describe("GeminiPrintChatEngine passes the configured home folder into its spawn", () => {
  it("submit() sets the child's HOME to the engine's homeBase", async () => {
    const homeBase = tempDir("gpce-home-");
    const neutralDir = tempDir("gpce-neutral-");
    const engine = new GeminiPrintChatEngine("thread", stubIo(), { homeBase });
    await engine.launch({ neutralDir, personaPath: join(neutralDir, "persona.md") });

    await engine.submit("hello");

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]!.options.env as Record<string, string> | undefined;
    expect(env).toBeDefined();
    expect(env!.HOME).toBe(homeBase);
  });

  it("leaves env unset (inherits the parent's) when no homeBase was configured", async () => {
    const neutralDir = tempDir("gpce-neutral-");
    const engine = new GeminiPrintChatEngine("thread", stubIo(), {});
    await engine.launch({ neutralDir, personaPath: join(neutralDir, "persona.md") });

    await engine.submit("hello");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.options.env).toBeUndefined();
  });
});
