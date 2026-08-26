import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as WriteToolsModule from "../../packages/notes/src/write-tools.js";

const resolveSourceMock = vi.fn<() => Promise<string>>();

vi.mock("../../packages/notes/src/write-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof WriteToolsModule>();
  return { ...actual, resolveSource: resolveSourceMock };
});

const { writeDailyChatArchive } = await import("../../packages/notes/src/daily-archive-writer.js");

const ACTOR_ID = "11111111-1111-1111-1111-111111111111";

function session(threadId: string, createdAt: string, body: string) {
  return {
    threadId,
    messages: [{ role: "user" as const, body, createdAt }]
  };
}

describe("writeDailyChatArchive (#1951)", () => {
  let root: string;
  let enqueued: Array<{ actorUserId: string; sourcePath: string }>;
  const notesSync = {
    enqueue: async (actorUserId: string, sourcePath: string) => {
      enqueued.push({ actorUserId, sourcePath });
      return null;
    }
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "jarv1s-archive-")));
    enqueued = [];
    resolveSourceMock.mockReset();
    resolveSourceMock.mockResolvedValue(root);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes nothing for an empty sessions array", async () => {
    const result = await writeDailyChatArchive(
      {} as never,
      ACTOR_ID,
      "2026-08-25",
      "Moss/Chats",
      [],
      notesSync
    );
    expect(result).toEqual({ written: false, path: null, reason: "no-sessions" });
    expect(enqueued).toHaveLength(0);
  });

  it("writes the marker, one heading per session, messages in order", async () => {
    const sessions = [
      session("thread-1", "2026-08-25T09:00:00.000Z", "hello"),
      session("thread-2", "2026-08-25T10:00:00.000Z", "world")
    ];
    const result = await writeDailyChatArchive(
      {} as never,
      ACTOR_ID,
      "2026-08-25",
      "Moss/Chats",
      sessions,
      notesSync
    );
    expect(result.written).toBe(true);
    expect(result.path).toBe(join("Moss/Chats", "2026-08-25.md"));
    const content = await readFile(join(root, "Moss/Chats", "2026-08-25.md"), "utf-8");
    const markerLine = content.split("\n")[0];
    expect(markerLine).toBe("<!-- moss-chat-archive:v1 -->");
    expect(content.indexOf("2026-08-25T09:00:00.000Z")).toBeLessThan(
      content.indexOf("2026-08-25T10:00:00.000Z")
    );
    expect(content.indexOf("hello")).toBeLessThan(content.indexOf("world"));
    expect(enqueued).toEqual([{ actorUserId: ACTOR_ID, sourcePath: root }]);
  });

  it("reports bad-folder without writing when the folder fails validation", async () => {
    const result = await writeDailyChatArchive(
      {} as never,
      ACTOR_ID,
      "2026-08-25",
      "/etc/passwd",
      [session("thread-1", "2026-08-25T09:00:00.000Z", "hello")],
      notesSync
    );
    expect(result).toEqual({ written: false, path: null, reason: "bad-folder" });
    expect(enqueued).toHaveLength(0);
  });

  it("reports no-notes-source without writing when resolveSource throws", async () => {
    resolveSourceMock.mockRejectedValue(new Error("Notes source is not configured"));
    const result = await writeDailyChatArchive(
      {} as never,
      ACTOR_ID,
      "2026-08-25",
      "Moss/Chats",
      [session("thread-1", "2026-08-25T09:00:00.000Z", "hello")],
      notesSync
    );
    expect(result).toEqual({ written: false, path: null, reason: "no-notes-source" });
    expect(enqueued).toHaveLength(0);
  });

  it("overwrites the primary path when it already holds a marked Moss file", async () => {
    await mkdir(join(root, "Moss/Chats"), { recursive: true });
    await writeFile(
      join(root, "Moss/Chats", "2026-08-25.md"),
      "<!-- moss-chat-archive:v1 -->\nold content",
      "utf-8"
    );
    const result = await writeDailyChatArchive(
      {} as never,
      ACTOR_ID,
      "2026-08-25",
      "Moss/Chats",
      [session("thread-1", "2026-08-25T09:00:00.000Z", "fresh")],
      notesSync
    );
    expect(result.path).toBe(join("Moss/Chats", "2026-08-25.md"));
    const content = await readFile(join(root, "Moss/Chats", "2026-08-25.md"), "utf-8");
    expect(content).toContain("fresh");
    expect(content).not.toContain("old content");
  });

  it("leaves a foreign primary file untouched and falls back to the (moss) path", async () => {
    await mkdir(join(root, "Moss/Chats"), { recursive: true });
    await writeFile(join(root, "Moss/Chats", "2026-08-25.md"), "# my own journal entry", "utf-8");
    const result = await writeDailyChatArchive(
      {} as never,
      ACTOR_ID,
      "2026-08-25",
      "Moss/Chats",
      [session("thread-1", "2026-08-25T09:00:00.000Z", "fresh")],
      notesSync
    );
    expect(result.path).toBe(join("Moss/Chats", "2026-08-25 (moss).md"));
    const original = await readFile(join(root, "Moss/Chats", "2026-08-25.md"), "utf-8");
    expect(original).toBe("# my own journal entry");
    const fallback = await readFile(join(root, "Moss/Chats", "2026-08-25 (moss).md"), "utf-8");
    expect(fallback).toContain("fresh");
  });

  it("throws when both the primary and fallback paths are occupied by foreign files", async () => {
    await mkdir(join(root, "Moss/Chats"), { recursive: true });
    await writeFile(join(root, "Moss/Chats", "2026-08-25.md"), "foreign primary", "utf-8");
    await writeFile(join(root, "Moss/Chats", "2026-08-25 (moss).md"), "foreign fallback", "utf-8");
    await expect(
      writeDailyChatArchive(
        {} as never,
        ACTOR_ID,
        "2026-08-25",
        "Moss/Chats",
        [session("thread-1", "2026-08-25T09:00:00.000Z", "fresh")],
        notesSync
      )
    ).rejects.toThrow();
  });
});
