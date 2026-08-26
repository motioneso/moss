import { describe, expect, it, vi } from "vitest";

import type { PgBoss } from "pg-boss";
import type { DataContextDb, PreferencesPort } from "@moss/db";
import type * as MossNotes from "@moss/notes";
import type { ChatArchiveSession } from "@moss/notes";
import { CHAT_ARCHIVE_ENABLED_SINCE_PREF_KEY } from "@moss/settings";
import type { ChatRepository } from "./repository.js";

let capturedSessions: readonly ChatArchiveSession[] | null = null;

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
      return { written: true, path: "x.md" };
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
    upsert: vi.fn(async () => {})
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
  it("does not backfill messages sent before archiving was turned on", async () => {
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
      "chat-archive.folder": "Moss/Chats",
      [CHAT_ARCHIVE_ENABLED_SINCE_PREF_KEY]: "2026-08-20T10:00:00.000Z"
    });

    await handleArchiveDayJob(SCOPED_DB, "user-1", "2026-08-20", {
      preferencesPort,
      chatRepo: fakeChatRepo(rows),
      boss: BOSS
    });

    const sessions: readonly ChatArchiveSession[] = capturedSessions ?? [];
    expect(sessions.length).toBeGreaterThan(0);
    const allBodies = sessions.flatMap((session) => session.messages.map((m) => m.body));
    expect(allBodies).toEqual(["sent after archiving was turned on"]);
  });

  it("archives every message for the day when no enabled-since timestamp is set", async () => {
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
});
