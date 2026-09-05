import { describe, expect, it, vi } from "vitest";

import {
  sortFetchedEmails,
  type SavedEmailMarker
} from "../../packages/connectors/src/google-sync-phases.js";
import type {
  EmailExtractResult,
  ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

type PersistEmail = (parsed: ParsedEmail, extracted: EmailExtractResult) => Promise<void>;

function fixture(overrides: Partial<ParsedEmail>): ParsedEmail {
  return {
    externalId: "msg-1",
    threadId: "thread-1",
    historyId: "history-1",
    subject: "Hello",
    from: "someone@example.invalid",
    recipients: ["ben@example.invalid"],
    receivedAt: "2026-08-03T12:00:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Hello",
    body: "Hello",
    bodyTruncated: false,
    ...overrides
  };
}

const signInCode = fixture({
  externalId: "otp-1",
  from: "Google <no-reply@accounts.google.com>",
  subject: "Your Google verification code",
  body: "482910 is your Google verification code. Do not share it with anyone."
});

function newProgress() {
  return { emailUpserted: 0, emailFailures: 0, errors: [] as string[] };
}

describe("sortFetchedEmails", () => {
  it("saves a sign-in code message exactly once and never queues it for the model", async () => {
    const persistEmail = vi.fn<PersistEmail>(async () => {});
    const progress = newProgress();

    const result = await sortFetchedEmails({
      parsedMessages: [signInCode],
      seen: new Map<string, SavedEmailMarker>(),
      persistEmail,
      progress,
      onFailure: () => {}
    });

    expect(persistEmail).toHaveBeenCalledTimes(1);
    expect(persistEmail.mock.calls[0]![1]).toEqual({
      summary: null,
      signals: { skipped: "otp", confidence: 0 }
    });
    expect(result.otpKeys).toEqual(["otp-1"]);
    expect(result.pending).toEqual([]);
    expect(progress.emailUpserted).toBe(1);
  });

  it("saves an already-analysed sign-in code message once and does not count it again", async () => {
    const persistEmail = vi.fn<PersistEmail>(async () => {});
    const progress = newProgress();

    const result = await sortFetchedEmails({
      parsedMessages: [signInCode],
      seen: new Map<string, SavedEmailMarker>([
        ["otp-1", { historyId: "history-1", hasSummary: true, hasCompleteTriage: true }]
      ]),
      persistEmail,
      progress,
      onFailure: () => {}
    });

    expect(persistEmail).toHaveBeenCalledTimes(1);
    expect(result.otpKeys).toEqual(["otp-1"]);
    expect(result.unchangedKeys).toEqual([]);
    expect(progress.emailUpserted).toBe(0);
  });

  it("leaves an unchanged ordinary message alone and queues changed ones newest first", async () => {
    const older = fixture({ externalId: "b", receivedAt: "2026-08-01T00:00:00.000Z" });
    const newer = fixture({ externalId: "c", receivedAt: "2026-08-02T00:00:00.000Z" });
    const unchanged = fixture({ externalId: "a" });
    const persistEmail = vi.fn<PersistEmail>(async () => {});
    const progress = newProgress();

    const result = await sortFetchedEmails({
      parsedMessages: [unchanged, older, newer],
      seen: new Map<string, SavedEmailMarker>([
        ["a", { historyId: "history-1", hasSummary: true, hasCompleteTriage: true }]
      ]),
      persistEmail,
      progress,
      onFailure: () => {}
    });

    expect(result.unchangedKeys).toEqual(["a"]);
    expect(result.pending.map((message) => message.externalId)).toEqual(["c", "b"]);
    expect(persistEmail).toHaveBeenCalledTimes(2);
    expect(progress.emailUpserted).toBe(2);
  });

  it("records one error label when saving fails", async () => {
    const persistEmail = vi.fn<PersistEmail>(async () => {
      throw new Error("save failed");
    });
    const progress = newProgress();
    const onFailure = vi.fn();

    const result = await sortFetchedEmails({
      parsedMessages: [signInCode, fixture({ externalId: "plain" })],
      seen: new Map<string, SavedEmailMarker>(),
      persistEmail,
      progress,
      onFailure
    });

    expect(progress.emailFailures).toBe(2);
    expect(progress.errors).toEqual(["email-message-error"]);
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(result.pending).toEqual([]);
    expect(result.otpKeys).toEqual([]);
  });
});
