process.env.TZ = "UTC";

import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, DataContextRunner } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import { PreferencesRepository } from "@moss/structured-state";

const { writeDailyChatArchive } = await import("../../packages/notes/src/daily-archive-writer.js");

const ACTOR_ID = ids.userA;
const prefs = new PreferencesRepository();
const UTC_12H = { timezone: "UTC", region: "en-US", dateFormat: "12" } as const;
const LA_12H = { timezone: "America/Los_Angeles", region: "en-US", dateFormat: "12" } as const;

function session(threadId: string, createdAt: string, body: string, title = "Chat") {
  return {
    threadId,
    title,
    messages: [{ role: "user" as const, body, createdAt }]
  };
}

const db = createDatabase({ connectionString: connectionStrings.app });
const runner = new DataContextRunner(db);
type ArchiveArgs = Parameters<typeof writeDailyChatArchive>;
async function archive(
  actorUserId: ArchiveArgs[1],
  localDate: ArchiveArgs[2],
  folder: ArchiveArgs[3],
  sessions: ArchiveArgs[4],
  locale: ArchiveArgs[5],
  sync: ArchiveArgs[6]
) {
  return runner.withDataContext({ actorUserId }, (scopedDb) =>
    writeDailyChatArchive(scopedDb, actorUserId, localDate, folder, sessions, locale, sync)
  );
}
beforeAll(() => resetFoundationDatabase());
afterAll(() => db.destroy());

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
    process.env.JARVIS_NOTES_ROOTS = root;
    enqueued = [];
    await runner.withDataContext({ actorUserId: ACTOR_ID }, (scoped) =>
      prefs.upsert(scoped, NOTES_SOURCE_PREFERENCE_KEY, root)
    );
  });

  afterEach(async () => {
    delete process.env.JARVIS_NOTES_ROOTS;
    await rm(root, { recursive: true, force: true });
  });

  it("writes nothing for an empty sessions array", async () => {
    const result = await archive(ACTOR_ID, "2026-08-25", "Moss/Chats", [], UTC_12H, notesSync);
    expect(result).toEqual({ written: false, path: null, reason: "no-sessions" });
    expect(enqueued).toHaveLength(0);
  });

  it("writes the marker, one heading per session, messages in order", async () => {
    const sessions = [
      session("thread-1", "2026-08-25T09:00:00.000Z", "hello"),
      session("thread-2", "2026-08-25T10:00:00.000Z", "world")
    ];
    const result = await archive(
      ACTOR_ID,
      "2026-08-25",
      "Moss/Chats",
      sessions,
      UTC_12H,
      notesSync
    );
    expect(result.written).toBe(true);
    expect(result.path).toBe(join("Moss/Chats", "2026-08-25.md"));
    const content = await readFile(join(root, "Moss/Chats", "2026-08-25.md"), "utf-8");
    const markerLine = content.split("\n")[0];
    expect(markerLine).toBe("<!-- moss-chat-archive:v1 -->");
    expect(content.indexOf("hello")).toBeLessThan(content.indexOf("world"));
    expect(enqueued).toEqual([{ actorUserId: ACTOR_ID, sourcePath: root }]);
  });

  it("titles each session heading with the local time and the conversation title", async () => {
    const sessions = [
      session("thread-1", "2026-08-25T09:00:00.000Z", "hello", "Vacation planning")
    ];
    await archive(ACTOR_ID, "2026-08-25", "Moss/Chats", sessions, UTC_12H, notesSync);
    const content = await readFile(join(root, "Moss/Chats", "2026-08-25.md"), "utf-8");
    expect(content).toContain("## 9:00 AM — Vacation planning");
  });

  it("falls back to just the local time when the conversation has no usable title", async () => {
    const sessions = [session("thread-1", "2026-08-25T09:00:00.000Z", "hello", "   ")];
    await archive(ACTOR_ID, "2026-08-25", "Moss/Chats", sessions, UTC_12H, notesSync);
    const content = await readFile(join(root, "Moss/Chats", "2026-08-25.md"), "utf-8");
    expect(content).toContain("## 9:00 AM\n");
    expect(content).not.toContain("—");
  });

  it("renders the heading time in the timezone passed in, not raw UTC", async () => {
    const sessions = [session("thread-1", "2026-08-25T09:00:00.000Z", "hello", "Standup")];
    await archive(ACTOR_ID, "2026-08-25", "Moss/Chats", sessions, LA_12H, notesSync);
    const content = await readFile(join(root, "Moss/Chats", "2026-08-25.md"), "utf-8");
    expect(content).toContain("## 2:00 AM — Standup");
  });

  it("renders the heading in the person's timezone, region and 24-hour choice (#3395)", async () => {
    const sessions = [session("thread-1", "2026-10-10T03:30:00.000Z", "hello", "Late call")];
    await archive(
      ACTOR_ID,
      "2026-10-09",
      "Moss/Chats",
      sessions,
      { timezone: "America/Los_Angeles", region: "en-GB", dateFormat: "24" },
      notesSync
    );
    const content = await readFile(join(root, "Moss/Chats", "2026-10-09.md"), "utf-8");
    expect(content).toContain("## 20:30 — Late call");
  });

  it("reports bad-folder without writing when the folder fails validation", async () => {
    const result = await archive(
      ACTOR_ID,
      "2026-08-25",
      "/etc/passwd",
      [session("thread-1", "2026-08-25T09:00:00.000Z", "hello")],
      UTC_12H,
      notesSync
    );
    expect(result).toEqual({ written: false, path: null, reason: "bad-folder" });
    expect(enqueued).toHaveLength(0);
  });

  it("reports no-notes-source without writing when resolveSource throws", async () => {
    await runner.withDataContext({ actorUserId: ACTOR_ID }, (scoped) =>
      prefs.upsert(scoped, NOTES_SOURCE_PREFERENCE_KEY, null)
    );
    const result = await archive(
      ACTOR_ID,
      "2026-08-25",
      "Moss/Chats",
      [session("thread-1", "2026-08-25T09:00:00.000Z", "hello")],
      UTC_12H,
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
    const result = await archive(
      ACTOR_ID,
      "2026-08-25",
      "Moss/Chats",
      [session("thread-1", "2026-08-25T09:00:00.000Z", "fresh")],
      UTC_12H,
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
    const result = await archive(
      ACTOR_ID,
      "2026-08-25",
      "Moss/Chats",
      [session("thread-1", "2026-08-25T09:00:00.000Z", "fresh")],
      UTC_12H,
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
      archive(
        ACTOR_ID,
        "2026-08-25",
        "Moss/Chats",
        [session("thread-1", "2026-08-25T09:00:00.000Z", "fresh")],
        UTC_12H,
        notesSync
      )
    ).rejects.toThrow();
  });
});
