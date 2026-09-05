import { describe, expect, it, vi } from "vitest";

import type { EmailMessage } from "@moss/db";

import { createEmailThreadProvider } from "../../packages/email/src/thread-provider.js";

const row = (o: Partial<EmailMessage>): EmailMessage =>
  ({
    id: "x",
    connector_account_id: "acct",
    owner_user_id: "u1",
    sender: "Sarah <sarah@kim.example>",
    recipients: ["ben@ben.com"],
    subject: "Addendum",
    snippet: null,
    body_excerpt: "a".repeat(5000),
    received_at: new Date("2026-09-01T10:00:00Z"),
    external_id: "m1",
    external_metadata: { threadId: "t1" },
    summary: null,
    signals: {},
    created_at: new Date("2026-09-01T10:00:00Z"),
    updated_at: new Date("2026-09-01T10:00:00Z"),
    ...o
  }) as EmailMessage;

describe("email thread provider", () => {
  it("maps rows, marks the user's own messages, caps the excerpt", async () => {
    const repo = {
      listByThread: vi.fn(async () => [
        row({}),
        row({ id: "y", external_id: "m2", sender: "ben@ben.com" })
      ]),
      listNewerInThreads: vi.fn(async () => [])
    };
    const p = createEmailThreadProvider(repo, async () => new Set(["ben@ben.com"]));
    const msgs = await p.listThreadMessages({}, "u1", "t1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.fromAddress).toBe("sarah@kim.example");
    expect(msgs[0]!.fromIsUser).toBe(false);
    expect(msgs[0]!.cacheMessageId).toBe("x");
    expect(msgs[0]!.receivedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(msgs[1]!.fromIsUser).toBe(true);
    expect(msgs[0]!.bodyExcerpt.length).toBe(4000);
    expect(repo.listByThread).toHaveBeenCalledWith({}, "u1", "t1");
  });
  it("translates the newer-message lookup both ways", async () => {
    const repo = {
      listByThread: vi.fn(async () => []),
      listNewerInThreads: vi.fn(async () => [
        { threadId: "t1", message: row({ id: "z", external_id: "m9" }) }
      ])
    };
    const p = createEmailThreadProvider(repo, async () => new Set());
    const out = await p.listThreadsWithNewerMessages({}, "u1", [
      { threadRef: "t1", afterExternalId: "m1" }
    ]);
    expect(repo.listNewerInThreads).toHaveBeenCalledWith({}, "u1", [
      { threadId: "t1", afterExternalId: "m1" }
    ]);
    expect(out).toEqual([
      { threadRef: "t1", newest: expect.objectContaining({ externalId: "m9" }) }
    ]);
  });
});
