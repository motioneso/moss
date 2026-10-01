import { describe, expect, it, vi } from "vitest";

import type { ParsedEmail } from "../../packages/connectors/src/email-extract.js";
import { cachedEmailInput } from "../../packages/connectors/src/google-sync-phases.js";
import { runImapSync } from "../../packages/connectors/src/imap-sync-jobs.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

function fixture(overrides: Partial<ParsedEmail>): ParsedEmail {
  return {
    externalId: "msg-1",
    threadId: "t1",
    historyId: "history-1",
    subject: "Hello",
    from: "someone@example.invalid",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:00:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Hello there",
    body: "Hello there",
    bodyTruncated: false,
    ...overrides
  };
}

const signInCode = {
  from: "Google <no-reply@accounts.google.com>",
  subject: "Your Google verification code",
  body: "482910 is your Google verification code. Do not share it with anyone.",
  snippet: "482910 is your Google verification code."
};

describe("Gmail sync stores no preview for a sign-in code message", () => {
  it("saves a null preview for a sign-in code", () => {
    const input = cachedEmailInput("acct-1", fixture(signInCode), { summary: null, signals: {} });
    expect(input.snippet).toBeNull();
  });
  it("keeps the preview for ordinary mail", () => {
    const input = cachedEmailInput("acct-1", fixture({}), { summary: null, signals: {} });
    expect(input.snippet).toBe("Hello there");
  });
});

describe("plain mail sync stores no preview for a sign-in code message", () => {
  async function savedPreview(parsed: ParsedEmail): Promise<unknown> {
    const upsertCachedMessage = vi.fn(
      async (_db: unknown, _input: { snippet?: string | null }) => ({})
    );
    const deps = {
      repository: {
        markSyncStarted: vi.fn(async () => {}),
        markSyncFinished: vi.fn(async () => {}),
        getActiveImapAccountSecret: vi.fn(async () => ({ encryptedSecret: "enc" }))
      },
      cipher: {
        decryptJson: () => ({
          kind: "imap-password",
          providerId: "custom",
          username: "u",
          password: "p",
          imapHost: "imap.example.invalid",
          smtpHost: "smtp.example.invalid"
        })
      },
      emailExtractDeps: { runChat: vi.fn(async () => ({ text: "{}" })) },
      emailReadProvider: {
        listMessageKeys: vi.fn(async () => ["k1"]),
        getMessage: vi.fn(async () => parsed)
      },
      emailRepository: { upsertCachedMessage },
      actorUserId: "u1"
    };
    await runImapSync(makeRecordingDb().scoped as never, "acct-1", deps as never);
    expect(upsertCachedMessage).toHaveBeenCalledTimes(1);
    return upsertCachedMessage.mock.calls[0]![1].snippet;
  }

  it("saves a null preview for a sign-in code", async () => {
    expect(await savedPreview(fixture(signInCode))).toBeNull();
  });
  it("keeps the preview for ordinary mail", async () => {
    expect(await savedPreview(fixture({}))).toBe("Hello there");
  });
});
