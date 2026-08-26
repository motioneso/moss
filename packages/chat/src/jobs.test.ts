import { describe, expect, it, vi } from "vitest";

import type { PgBoss } from "pg-boss";
import type { DataContextDb, PreferencesPort } from "@moss/db";
import type * as MossNotes from "@moss/notes";
import type { ChatArchiveSession } from "@moss/notes";
import type { ChatRepository } from "./repository.js";

let capturedSessions: readonly ChatArchiveSession[] | null = null;
let writeResult: { written: boolean; path: string | null; reason?: string } = {
  written: true,
  path: "x.md"
};
let writeThrows: false | "conflict" | "other" = false;

vi.mock("@moss/notes", async () => {
  const actual = await vi.importActual<typeof MossNotes>("@moss/notes");
  return {
    ...actual,
    writeDailyChatArchive: async (
      _scopedDb: unknown,
      _actorUserId: string,
      _localDate: string,
      _folder: string,
      sessions: readonly ChatArchiveSession[]
    ) => {
      capturedSessions = sessions;
      if (writeThrows === "conflict") {
        throw new actual.ChatArchiveConflictError("both today's file and its fallback are taken");
      }
      if (writeThrows === "other") {
        throw new Error("EACCES: permission denied, open '/some/path'");
      }
      return writeResult;
    }
  };
});

// Imported after the mock so jobs.ts picks up the mocked writeDailyChatArchive.
const { handleArchiveDayJob } = await import("./jobs.js");

type StoredMessageRow = {
  threadId: string;
  threadTitle: string;
  threadFirstMessageAt: string;
  role: "user" | "assistant";
  body: string;
  createdAt: string;
};

function fakePreferencesPort(values: Record<string, unknown>): PreferencesPort {
  return {
    get: vi.fn(async (_scopedDb: DataContextDb, key: string) => values[key] ?? null),
    getWithMetadata: vi.fn(async () => null),
    upsert: vi.fn(async (_scopedDb: DataContextDb, key: string, value: unknown) => {
      values[key] = value;
    })
  };
}

function fakeChatRepo(rows: StoredMessageRow[]): ChatRepository {
  return {
    listStoredMessagesInRange: vi.fn(async () => rows)
  } as unknown as ChatRepository;
}

const SCOPED_DB = {} as DataContextDb;
const BOSS = {} as PgBoss;

describe("handleArchiveDayJob", () => {
  it("includes messages from before and after archiving was turned on, same day", async () => {
    capturedSessions = null;

    const rows: StoredMessageRow[] = [
      {
        threadId: "thread-1",
        threadTitle: "Morning chat",
        threadFirstMessageAt: "2026-08-20T09:00:00.000Z",
        role: "user",
        body: "sent before archiving was turned on",
        createdAt: "2026-08-20T09:00:00.000Z"
      },
      {
        threadId: "thread-1",
        threadTitle: "Morning chat",
        threadFirstMessageAt: "2026-08-20T09:00:00.000Z",
        role: "user",
        body: "sent after archiving was turned on",
        createdAt: "2026-08-20T11:00:00.000Z"
      }
    ];

    const preferencesPort = fakePreferencesPort({
      "chat-archive.enabled": true,
      "chat-archive.folder": "Moss/Chats"
    });

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(rows),
      boss: BOSS
    });

    const sessions: readonly ChatArchiveSession[] = capturedSessions ?? [];
    expect(sessions.length).toBeGreaterThan(0);
    const allBodies = sessions.flatMap((session) => session.messages.map((m) => m.body));
    expect(allBodies).toEqual([
      "sent before archiving was turned on",
      "sent after archiving was turned on"
    ]);
  });

  it("archives every message for the day", async () => {
    capturedSessions = null;

    const rows: StoredMessageRow[] = [
      {
        threadId: "thread-1",
        threadTitle: "Morning chat",
        threadFirstMessageAt: "2026-08-20T09:00:00.000Z",
        role: "user",
        body: "first message",
        createdAt: "2026-08-20T09:00:00.000Z"
      }
    ];

    const preferencesPort = fakePreferencesPort({
      "chat-archive.enabled": true,
      "chat-archive.folder": "Moss/Chats"
    });

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(rows),
      boss: BOSS
    });

    const sessions: readonly ChatArchiveSession[] = capturedSessions ?? [];
    expect(sessions.length).toBeGreaterThan(0);
    const allBodies = sessions.flatMap((session) => session.messages.map((m) => m.body));
    expect(allBodies).toEqual(["first message"]);
  });

  it("still excludes a message from a different day", async () => {
    capturedSessions = null;

    const rows: StoredMessageRow[] = [
      {
        threadId: "thread-1",
        threadTitle: "Yesterday chat",
        threadFirstMessageAt: "2026-08-19T23:00:00.000Z",
        role: "user",
        body: "sent the day before",
        createdAt: "2026-08-19T23:00:00.000Z"
      },
      {
        threadId: "thread-1",
        threadTitle: "Yesterday chat",
        threadFirstMessageAt: "2026-08-19T23:00:00.000Z",
        role: "user",
        body: "sent today",
        createdAt: "2026-08-20T09:00:00.000Z"
      }
    ];

    const preferencesPort = fakePreferencesPort({
      "chat-archive.enabled": true,
      "chat-archive.folder": "Moss/Chats"
    });

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(rows),
      boss: BOSS
    });

    const sessions: readonly ChatArchiveSession[] = capturedSessions ?? [];
    const allBodies = sessions.flatMap((session) => session.messages.map((m) => m.body));
    expect(allBodies).toEqual(["sent today"]);
  });

  const oneRow: StoredMessageRow[] = [
    {
      threadId: "thread-1",
      threadTitle: "Chat",
      threadFirstMessageAt: "2026-08-20T09:00:00.000Z",
      role: "user",
      body: "hello",
      createdAt: "2026-08-20T09:00:00.000Z"
    }
  ];

  it("clears a previously-set status once a write succeeds", async () => {
    capturedSessions = null;
    writeThrows = false;
    writeResult = { written: true, path: "x.md" };

    const values: Record<string, unknown> = {
      "chat-archive.enabled": true,
      "chat-archive.folder": "Moss/Chats",
      "chat-archive.status": { state: "failed", reason: "old problem" }
    };
    const preferencesPort = fakePreferencesPort(values);

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(oneRow),
      boss: BOSS
    });

    expect(values["chat-archive.status"]).toBeNull();
  });

  it("records a paused status when no notes folder is connected", async () => {
    capturedSessions = null;
    writeThrows = false;
    writeResult = { written: false, path: null, reason: "no-notes-source" };

    const values: Record<string, unknown> = {
      "chat-archive.enabled": true,
      "chat-archive.folder": "Moss/Chats"
    };
    const preferencesPort = fakePreferencesPort(values);

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(oneRow),
      boss: BOSS
    });

    expect(values["chat-archive.status"]).toEqual({
      state: "paused",
      reason: "No notes folder is connected."
    });
  });

  it("records a failed status when the folder setting is invalid", async () => {
    capturedSessions = null;
    writeThrows = false;
    writeResult = { written: false, path: null, reason: "bad-folder" };

    const values: Record<string, unknown> = {
      "chat-archive.enabled": true,
      "chat-archive.folder": "../nope"
    };
    const preferencesPort = fakePreferencesPort(values);

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(oneRow),
      boss: BOSS
    });

    const status = values["chat-archive.status"] as { state: string; reason: string };
    expect(status.state).toBe("failed");
    expect(status.reason).not.toContain("/");
  });

  it("records the file-conflict message when today's file and its backup are both already taken", async () => {
    capturedSessions = null;
    writeThrows = "conflict";

    const values: Record<string, unknown> = {
      "chat-archive.enabled": true,
      "chat-archive.folder": "Moss/Chats"
    };
    const preferencesPort = fakePreferencesPort(values);

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(oneRow),
      boss: BOSS
    });

    expect(values["chat-archive.status"]).toEqual({
      state: "failed",
      reason: "Today's note already exists and wasn't written by chat archiving."
    });
  });

  it("records a generic failed status, not the file-conflict message, for any other write error", async () => {
    capturedSessions = null;
    writeThrows = "other";

    const values: Record<string, unknown> = {
      "chat-archive.enabled": true,
      "chat-archive.folder": "Moss/Chats"
    };
    const preferencesPort = fakePreferencesPort(values);

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(oneRow),
      boss: BOSS
    });

    const status = values["chat-archive.status"] as { state: string; reason: string };
    expect(status.state).toBe("failed");
    expect(status.reason).not.toBe("Today's note already exists and wasn't written by chat archiving.");
    expect(status.reason).not.toContain("Moss/Chats");
    expect(status.reason).not.toContain("hello");
  });

  it("leaves an existing status untouched when archiving is turned off", async () => {
    capturedSessions = null;
    writeThrows = false;

    const values: Record<string, unknown> = {
      "chat-archive.enabled": false,
      "chat-archive.folder": "Moss/Chats",
      "chat-archive.status": { state: "paused", reason: "No notes folder is connected." }
    };
    const preferencesPort = fakePreferencesPort(values);

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(oneRow),
      boss: BOSS
    });

    expect(values["chat-archive.status"]).toEqual({
      state: "paused",
      reason: "No notes folder is connected."
    });
  });

  it("leaves an existing status untouched when there is nothing to archive that day", async () => {
    capturedSessions = null;
    writeThrows = false;

    const yesterdayRow: StoredMessageRow[] = [
      {
        threadId: "thread-1",
        threadTitle: "Chat",
        threadFirstMessageAt: "2026-08-19T09:00:00.000Z",
        role: "user",
        body: "sent the day before",
        createdAt: "2026-08-19T09:00:00.000Z"
      }
    ];
    const values: Record<string, unknown> = {
      "chat-archive.enabled": true,
      "chat-archive.folder": "Moss/Chats",
      "chat-archive.status": { state: "failed", reason: "old problem" }
    };
    const preferencesPort = fakePreferencesPort(values);

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(yesterdayRow),
      boss: BOSS
    });

    expect(values["chat-archive.status"]).toEqual({ state: "failed", reason: "old problem" });
  });
});
