import { describe, expect, it, vi } from "vitest";

import type { EmailMessage } from "@moss/db";

import {
  extractEmailSignals,
  extractEmailSignalsBatch,
  looksLikeOneTimeCodeEmail,
  otpSkippedResult,
  type EmailExtractDeps,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";
import { emailContextItemFromCache } from "../../packages/connectors/src/source-context/email.js";
import { planEmailTasks } from "../../packages/connectors/src/source-context/email-tasks.js";

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

describe("looksLikeOneTimeCodeEmail", () => {
  const positives: Array<[string, string, string]> = [
    ["a verification code phrase", "Your verification code", "Use 482910 to finish signing in."],
    ["a login code phrase", "Login code", "123456 is your login code."],
    ["a two-factor phrase", "Two-factor authentication required", "Enter the code we texted you."],
    ["a passcode phrase", "Your one-time passcode", "Passcode: 9081"],
    ["a bare 2FA mention", "2FA code", "Your 2FA code is 774411."],
    ["a code word next to a short number", "Sign in", "482910 is your code. Do not share it."],
    ["a confirm-sign-in phrase", "Confirm your sign-in", "We noticed a new sign-in attempt."]
  ];

  for (const [label, subject, body] of positives) {
    it(`matches ${label}`, () => {
      expect(looksLikeOneTimeCodeEmail(subject, body)).toBe(true);
    });
  }

  const negatives: Array<[string, string, string]> = [
    [
      "an ordinary email that merely contains a number",
      "Your order has shipped",
      "Order #482910 has shipped and should arrive Thursday."
    ],
    [
      "a normal request with no code language",
      "Q2 numbers",
      "Could you send the Q2 numbers by Friday afternoon?"
    ],
    [
      "a newsletter",
      "August product newsletter",
      "Read our latest product news and customer stories."
    ],
    [
      "an appointment confirmation without a code",
      "Your appointment is confirmed",
      "This confirms your appointment for next Tuesday at 10 AM."
    ]
  ];

  for (const [label, subject, body] of negatives) {
    it(`does not match ${label}`, () => {
      expect(looksLikeOneTimeCodeEmail(subject, body)).toBe(false);
    });
  }
});

describe("one-time-code emails skip the model call", () => {
  it("extractEmailSignals never calls the model and returns the skip marker", async () => {
    const runChat = vi.fn();
    const deps: EmailExtractDeps = { runChat };
    const parsed = fixture({
      subject: "Your verification code",
      body: "Use 482910 to finish signing in. If you did not request this, ignore this email."
    });

    const result = await extractEmailSignals(parsed, deps);

    expect(runChat).not.toHaveBeenCalled();
    expect(result).toEqual(otpSkippedResult());
    expect(result.summary).toBeNull();
    expect(result.signals.actionability).toBeUndefined();
  });

  it("extractEmailSignalsBatch never calls the model for an all-OTP batch", async () => {
    const runChat = vi.fn();
    const deps: EmailExtractDeps = { runChat };
    const otpMessages = [
      fixture({
        externalId: "otp-1",
        subject: "Security code",
        body: "123456 is your security code. It expires in 10 minutes."
      }),
      fixture({
        externalId: "otp-2",
        subject: "Login code",
        body: "Your login code is 654321."
      })
    ];

    const results = await extractEmailSignalsBatch(otpMessages, deps);

    expect(runChat).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toEqual(otpSkippedResult());
    }
  });

  it("extractEmailSignalsBatch only calls the model for the non-OTP messages, in order", async () => {
    // Only one message survives the one-time-code filter here, so extractEmailSignalsBatch
    // takes its single-message path (a plain signals object), not the multi-message batch
    // path (a { results: [...] } wrapper) — see extractEmailSignalsBatch in email-extract.ts.
    const runChat = vi.fn(async () => ({
      text: JSON.stringify({ category: "unknown", confidence: 0.4 })
    }));
    const deps: EmailExtractDeps = { runChat };
    const messages = [
      fixture({ externalId: "otp-1", subject: "Passcode", body: "Passcode: 5551" }),
      fixture({
        externalId: "ordinary-1",
        subject: "Q2 numbers",
        body: "Could you send the Q2 numbers by Friday afternoon?"
      })
    ];

    const results = await extractEmailSignalsBatch(messages, deps);

    expect(runChat).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(otpSkippedResult());
    expect(results[1]?.signals.skipped).toBeUndefined();
  });
});

describe("a skipped message creates no task", () => {
  it("never becomes an actionable item or a planned task", () => {
    const row = {
      id: "cache-otp-1",
      connector_account_id: "account-1",
      owner_user_id: "user-1",
      sender: "noreply@example.invalid",
      recipients: ["ben@example.invalid"],
      subject: "Your verification code",
      snippet: "Use 482910 to finish signing in.",
      body_excerpt: null,
      received_at: new Date("2026-08-03T12:00:00.000Z"),
      external_id: "otp-msg-1",
      external_metadata: { threadId: "thread-otp-1" },
      summary: null,
      signals: otpSkippedResult().signals,
      created_at: new Date("2026-08-03T12:00:00.000Z"),
      updated_at: new Date("2026-08-03T12:00:00.000Z")
    } as unknown as EmailMessage;

    const item = emailContextItemFromCache(
      row,
      { connectorAccountId: "account-1", providerId: "google", providerLabel: "Gmail" },
      null
    );

    expect(item.actionability).toBe("unknown");
    expect(item.inferredSubject ?? null).toBeNull();
    expect(item.suggestedTasks).toEqual([]);

    const planned = planEmailTasks({
      mode: "suggest",
      now: "2026-08-03T12:10:00.000Z",
      items: [item]
    });

    expect(planned).toEqual([]);
  });
});
