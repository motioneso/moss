import { describe, expect, it, vi } from "vitest";

import type { EmailMessage } from "@moss/db";

import {
  extractEmailSignals,
  extractEmailSignalsBatch,
  looksLikeOneTimeCodeEmail,
  otpSkippedResult,
  type EmailExtractDeps,
  type EmailExtractResult,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";
import { emailContextItemFromCache } from "../../packages/connectors/src/source-context/email.js";
import {
  sortFetchedEmails,
  type SavedEmailMarker
} from "../../packages/connectors/src/google-sync-phases.js";
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

/**
 * The skip is deliberately four separate signals ANDed together: an automated sender, a subject
 * line that itself names a sign-in / verification / one-time / security code, a short code
 * standing on its own, and nothing anywhere in the message about a door, a stay, an order, a
 * delivery, a booking or a money-off code. Any one signal alone appears in ordinary mail all
 * the time, so the negatives below are the real specification: they are the messages a person
 * actually wants to see.
 */
describe("looksLikeOneTimeCodeEmail: ordinary mail is never skipped", () => {
  const negatives: Array<[string, { from: string; subject: string; body: string }]> = [
    [
      "a door code from a friend",
      {
        from: "sarah.jones@example.invalid",
        subject: "Dinner Saturday",
        body: "The door code is 482910. Please bring dessert and come round about seven."
      }
    ],
    [
      "a shop newsletter offering a discount code",
      {
        from: "no-reply@shop.example.invalid",
        subject: "20% off this weekend only",
        body: "Your discount code is 123456. Use it on your next order before Sunday."
      }
    ],
    [
      "a parcel tracking notice",
      {
        from: "tracking@parcels.example.invalid",
        subject: "Your parcel is on its way",
        body: "Tracking number 482910 should arrive Thursday. Track it any time online."
      }
    ],
    [
      "a dinner invitation whose menu word contains the OTP letters",
      {
        from: "dave@example.invalid",
        subject: "Friday plans",
        body: "Please book the hotpot restaurant for Friday, table for 6 at 7pm."
      }
    ],
    [
      "a colleague asking for the wifi code",
      {
        from: "priya@work.example.invalid",
        subject: "Wifi",
        body: "What is the wifi code for the meeting room? I think it is 48291086 but it fails."
      }
    ],
    [
      "a receipt carrying an order number",
      {
        from: "receipts@shop.example.invalid",
        subject: "Your receipt",
        body: "Thanks for your order. Order number 482910, total 42.50, shipping Thursday."
      }
    ],
    [
      "a request to confirm an invoice",
      {
        from: "finance@work.example.invalid",
        subject: "Invoice due",
        body: "Please confirm invoice 482910 by Friday."
      }
    ],
    [
      "a request to verify a budget",
      {
        from: "cfo@work.example.invalid",
        subject: "Budget review",
        body: "Please verify the 2026 budget before Monday."
      }
    ],
    [
      "a request to turn two-factor on for a team, not a code delivery",
      {
        from: "it@work.example.invalid",
        subject: "Security rollout",
        body: "Please enable two-factor authentication for the team by Friday."
      }
    ],
    [
      "an automated sender with a code phrase but no code standing alone",
      {
        from: "no-reply@accounts.example.invalid",
        subject: "About your security code",
        body: "We are changing how security codes are delivered from next month."
      }
    ],
    [
      "an automated sender with a short number but no code phrase",
      {
        from: "no-reply@billing.example.invalid",
        subject: "Statement ready",
        body: "Your statement 482910 is ready to view in your account."
      }
    ],
    [
      "an automated message whose subject never mentions a code",
      {
        from: "noreply@service.example.invalid",
        subject: "Please review your account",
        body: "Verification code: 123456\n\nThis code expires in 15 minutes."
      }
    ],
    [
      "apartment check-in instructions carrying a one-time passcode",
      {
        from: "notifications@hotel.example.invalid",
        subject: "Your apartment check-in instructions",
        body: "Your one-time passcode is 482910.\nUse it at the apartment door. Please bring photo ID."
      }
    ],
    [
      "a discount voucher carrying a single-use code",
      {
        from: "no-reply@shop.example.invalid",
        subject: "Your discount voucher",
        body: "Your single-use code is 482910.\nApply this discount at checkout before Sunday."
      }
    ],
    [
      "a person forwarding their own sign-in code text",
      {
        from: "mum@example.invalid",
        subject: "Can you help?",
        body: "It says my verification code is 482910 but the website will not take it."
      }
    ]
  ];

  for (const [label, message] of negatives) {
    it(`does not skip ${label}`, () => {
      expect(looksLikeOneTimeCodeEmail(message)).toBe(false);
    });
  }
});

describe("looksLikeOneTimeCodeEmail: automated sign-in code mail is skipped", () => {
  const positives: Array<[string, { from: string; subject: string; body: string }]> = [
    [
      "a Google style verification code",
      {
        from: "Google <no-reply@accounts.google.com>",
        subject: "Your Google verification code",
        body: "482910 is your Google verification code. Do not share it with anyone."
      }
    ],
    [
      "a GitHub style device verification",
      {
        from: "noreply@github.com",
        subject: "[GitHub] Your verification code",
        body: "Verification code: 123456\n\nThis code expires in 15 minutes."
      }
    ],
    [
      "a bank style one-time passcode",
      {
        from: "alerts@notifications.examplebank.com",
        subject: "Your one-time passcode",
        body: "Your one-time passcode is 774411. We will never ask you for it by phone."
      }
    ],
    [
      "an Apple style ID verification code",
      {
        from: "Apple <no_reply@email.apple.com>",
        subject: "Your Apple ID verification code",
        body: "Your Apple ID verification code is: 908134. Do not share it."
      }
    ],
    [
      "an OTP written as the abbreviation",
      {
        from: "otp@auth.example.invalid",
        subject: "Your OTP",
        body: "Your OTP is 482910. It expires in ten minutes."
      }
    ],
    [
      "a Microsoft account single-use code",
      {
        from: "Microsoft account team <account-security-noreply@accountprotection.microsoft.com>",
        subject: "Microsoft account single-use code",
        body: "Please use this code to sign in: 748219. If you did not request it, ignore this."
      }
    ],
    [
      "a high-street bank log-in code",
      {
        from: "no.reply@notifications.examplebank.co.uk",
        subject: "774411 is your log-in code",
        body: "Use 774411 to log in to online banking. We will never phone you to ask for it."
      }
    ],
    [
      "a shop account sign-in code",
      {
        from: "no-reply@account.exampleshop.invalid",
        subject: "Your Example Shop sign-in code",
        body: "Enter 391847 to sign in to your Example Shop account. It expires in 10 minutes."
      }
    ],
    [
      "a letters-and-digits sign-in code",
      {
        from: "security@notifications.example.invalid",
        subject: "Your sign-in code",
        body: "Enter A4B7C9 to finish signing in. This login code expires in 5 minutes."
      }
    ]
  ];

  for (const [label, message] of positives) {
    it(`skips ${label}`, () => {
      expect(looksLikeOneTimeCodeEmail(message)).toBe(true);
    });
  }
});

describe("one-time-code emails skip the model call", () => {
  it("extractEmailSignals never calls the model and returns the skip marker", async () => {
    const runChat = vi.fn();
    const deps: EmailExtractDeps = { runChat };
    const parsed = fixture({
      from: "no-reply@accounts.google.com",
      subject: "Your Google verification code",
      body: "482910 is your Google verification code. If you did not request it, ignore this."
    });

    const result = await extractEmailSignals(parsed, deps);

    expect(runChat).not.toHaveBeenCalled();
    expect(result).toEqual(otpSkippedResult());
    expect(result.summary).toBeNull();
    expect(result.signals.actionability).toBeUndefined();
  });

  it("extractEmailSignalsBatch never calls the model for an all-code batch", async () => {
    const runChat = vi.fn();
    const deps: EmailExtractDeps = { runChat };
    const otpMessages = [
      fixture({
        externalId: "otp-1",
        from: "no-reply@accounts.google.com",
        subject: "Your security code",
        body: "123456 is your security code. It expires in 10 minutes."
      }),
      fixture({
        externalId: "otp-2",
        from: "noreply@github.com",
        subject: "[GitHub] Your verification code",
        body: "Verification code: 654321"
      })
    ];

    const results = await extractEmailSignalsBatch(otpMessages, deps);

    expect(runChat).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toEqual(otpSkippedResult());
    }
  });

  it("extractEmailSignalsBatch only calls the model for the ordinary messages, in order", async () => {
    // Only one message survives the one-time-code filter here, so extractEmailSignalsBatch
    // takes its single-message path (a plain signals object), not the multi-message batch
    // path (a { results: [...] } wrapper) — see extractEmailSignalsBatch in email-extract.ts.
    const runChat = vi.fn(async () => ({
      text: JSON.stringify({ category: "unknown", confidence: 0.4 })
    }));
    const deps: EmailExtractDeps = { runChat };
    const messages = [
      fixture({
        externalId: "otp-1",
        from: "no_reply@email.apple.com",
        subject: "Your Apple ID verification code",
        body: "Your Apple ID verification code is: 5551."
      }),
      fixture({
        externalId: "ordinary-1",
        from: "sarah.jones@example.invalid",
        subject: "Dinner Saturday",
        body: "The door code is 482910. Please bring dessert."
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
      sender: "no-reply@accounts.google.com",
      recipients: ["ben@example.invalid"],
      subject: "Your Google verification code",
      snippet: "482910 is your Google verification code.",
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

  it("a code email saved with a full analysis before this filter existed is skipped once it re-syncs", async () => {
    // Simulates a row saved before this feature shipped: a real sign-in code email that the
    // model triaged as actionable, with a complete summary and a suggested task already
    // stored. The next sync decides sign-in code messages before the unchanged check, so it
    // saves the message again with the skip marker; reading it after that shows nothing.
    const parsed = fixture({
      externalId: "otp-msg-2",
      from: "no-reply@accounts.google.com",
      subject: "Your login code",
      body: "123456 is your login code. It expires in 10 minutes."
    });
    const saved: EmailExtractResult[] = [];

    const sorted = await sortFetchedEmails({
      parsedMessages: [parsed],
      seen: new Map<string, SavedEmailMarker>([
        ["otp-msg-2", { historyId: "history-1", hasSummary: true, hasCompleteTriage: true }]
      ]),
      persistEmail: async (_message, extracted) => {
        saved.push(extracted);
      },
      progress: { emailUpserted: 0, emailFailures: 0, errors: [] },
      onFailure: () => {}
    });

    expect(sorted.otpKeys).toEqual(["otp-msg-2"]);
    expect(saved).toHaveLength(1);

    const row = {
      id: "cache-otp-2",
      connector_account_id: "account-1",
      owner_user_id: "user-1",
      sender: parsed.from,
      recipients: ["ben@example.invalid"],
      subject: parsed.subject,
      snippet: parsed.body,
      body_excerpt: parsed.body,
      received_at: new Date("2026-08-03T12:00:00.000Z"),
      external_id: "otp-msg-2",
      external_metadata: { threadId: "thread-otp-2" },
      summary: saved[0]!.summary,
      signals: saved[0]!.signals,
      created_at: new Date("2026-08-03T12:00:00.000Z"),
      updated_at: new Date("2026-08-03T12:00:00.000Z")
    } as unknown as EmailMessage;

    const item = emailContextItemFromCache(
      row,
      { connectorAccountId: "account-1", providerId: "google", providerLabel: "Gmail" },
      null
    );

    expect(item.actionability).toBe("unknown");
    expect(item.summary).toBeNull();
    expect(item.suggestedTasks).toEqual([]);

    const planned = planEmailTasks({
      mode: "suggest",
      now: "2026-08-03T12:10:00.000Z",
      items: [item]
    });

    expect(planned).toEqual([]);
  });

  it("an ordinary saved message with a door code keeps its summary and its task", () => {
    const row = {
      id: "cache-ordinary-1",
      connector_account_id: "account-1",
      owner_user_id: "user-1",
      sender: "sarah.jones@example.invalid",
      recipients: ["ben@example.invalid"],
      subject: "Dinner Saturday",
      snippet: "The door code is 482910. Please bring dessert.",
      body_excerpt: "The door code is 482910. Please bring dessert.",
      received_at: new Date("2026-08-03T12:00:00.000Z"),
      external_id: "ordinary-msg-1",
      external_metadata: { threadId: "thread-ordinary-1" },
      summary: "Sarah invited you to dinner on Saturday and asked you to bring dessert.",
      signals: {
        confidence: 0.9,
        actionability: {
          category: "needs_action",
          inferredSubject: "Bring dessert to Sarah's on Saturday",
          suggestedTasks: [{ text: "Buy dessert for Saturday" }]
        }
      },
      created_at: new Date("2026-08-03T12:00:00.000Z"),
      updated_at: new Date("2026-08-03T12:00:00.000Z")
    } as unknown as EmailMessage;

    const item = emailContextItemFromCache(
      row,
      { connectorAccountId: "account-1", providerId: "google", providerLabel: "Gmail" },
      null
    );

    expect(item.actionability).toBe("needs_action");
    expect(item.summary).toBe(
      "Sarah invited you to dinner on Saturday and asked you to bring dessert."
    );
    expect(item.suggestedTasks.length).toBeGreaterThan(0);
  });
});

/**
 * The reviewer's own examples, run the way a real sync runs them: through extractEmailSignals
 * with a counting fake model. Each case says whether the message is skipped, and a skipped
 * message must never reach the model at all.
 */
describe("reviewer examples, end to end through extractEmailSignals", () => {
  const cases: Array<[string, { from: string; subject: string; body: string }, boolean]> = [
    [
      "an apartment check-in email carrying a door passcode",
      {
        from: "notifications@hotel.example.invalid",
        subject: "Your apartment check-in instructions",
        body: "Your door passcode is 482910. Check-in is after 3pm; please bring photo ID."
      },
      false
    ],
    [
      "apartment check-in instructions whose passcode sits on its own line",
      {
        from: "notifications@hotel.example.invalid",
        subject: "Your apartment check-in instructions",
        body: "Your one-time passcode is 482910.\nUse it at the apartment door. Please bring photo ID."
      },
      false
    ],
    [
      "a discount voucher whose code sits on its own line",
      {
        from: "no-reply@shop.example.invalid",
        subject: "Your discount voucher",
        body: "Your single-use code is 482910.\nApply this discount at checkout before Sunday."
      },
      false
    ],
    [
      "a bank notice about how security codes will be delivered in a future year",
      {
        from: "no-reply@bank.example.invalid",
        subject: "Security code policy update",
        body:
          "Starting in 2026, we are changing how security codes are delivered. " +
          "Please review the new policy."
      },
      false
    ],
    [
      "a realistic Google sign-in code",
      {
        from: "Google <no-reply@accounts.google.com>",
        subject: "Your Google verification code",
        body: "482910 is your Google verification code. Do not share it with anyone."
      },
      true
    ],
    [
      "a realistic bank log-in code",
      {
        from: "no.reply@notifications.examplebank.co.uk",
        subject: "774411 is your log-in code",
        body: "Use 774411 to log in to online banking. We will never phone you to ask for it."
      },
      true
    ],
    [
      "a realistic shop account sign-in code",
      {
        from: "no-reply@account.exampleshop.invalid",
        subject: "Your Example Shop sign-in code",
        body: "Enter 391847 to sign in to your Example Shop account. It expires in 10 minutes."
      },
      true
    ],
    [
      "a friend's door code",
      {
        from: "sarah.jones@example.invalid",
        subject: "Dinner Saturday",
        body: "The door code is 482910. Please bring dessert and come round about seven."
      },
      false
    ],
    [
      "an automated discount offer",
      {
        from: "no-reply@shop.example.invalid",
        subject: "20% off this weekend only",
        body: "Your discount code is 123456. Use it on your next order before Sunday."
      },
      false
    ],
    [
      "a parcel tracking number",
      {
        from: "tracking@parcels.example.invalid",
        subject: "Your parcel is on its way",
        body: "Tracking number 482910 should arrive Thursday. Track it any time online."
      },
      false
    ],
    [
      "a hotpot invitation",
      {
        from: "dave@example.invalid",
        subject: "Friday plans",
        body: "Please book the hotpot restaurant for Friday, table for 6 at 7pm."
      },
      false
    ],
    [
      "an ordinary human request",
      {
        from: "priya@work.example.invalid",
        subject: "Wifi",
        body: "What is the wifi code for the meeting room? I think it is 48291086 but it fails."
      },
      false
    ]
  ];

  for (const [label, message, skipped] of cases) {
    it(`${skipped ? "skips" : "analyses"} ${label}`, async () => {
      expect(looksLikeOneTimeCodeEmail(message)).toBe(skipped);

      const runChat = vi.fn(async () => ({
        text: JSON.stringify({ category: "unknown", confidence: 0.4 })
      }));
      const deps: EmailExtractDeps = { runChat };

      const result = await extractEmailSignals(fixture(message), deps);

      if (skipped) {
        expect(runChat).not.toHaveBeenCalled();
        expect(result).toEqual(otpSkippedResult());
      } else {
        expect(runChat).toHaveBeenCalledTimes(1);
        expect(result.signals.skipped).toBeUndefined();
      }
    });
  }
});

/**
 * The saved record keeps a preview of at most 500 characters, so words that explain a number
 * another way can sit past the end of it. The decision about a sign-in code is therefore made
 * once, during sync, from the whole message, and stored on the record; reading must honour
 * that stored decision and never work it out again from the preview.
 */
describe("the saved decision, not the preview, decides what a reader sees", () => {
  const doorInstructions = fixture({
    externalId: "door-msg-1",
    from: "notifications@hotel.example.invalid",
    subject: "Your one-time passcode",
    body:
      "Your one-time passcode is 482910.\n" +
      "x".repeat(520) +
      "\nUse this at the apartment door. Bring photo ID."
  });

  async function saveThenRead(
    parsed: ParsedEmail,
    analysis: { summary: string | null; signals: Record<string, unknown> }
  ) {
    const saved: EmailExtractResult[] = [];
    const sorted = await sortFetchedEmails({
      parsedMessages: [parsed],
      seen: new Map<string, SavedEmailMarker>(),
      persistEmail: async (_message, extracted) => {
        saved.push(extracted);
      },
      progress: { emailUpserted: 0, emailFailures: 0, errors: [] },
      onFailure: () => {}
    });
    const skippedOnSave = sorted.otpKeys.includes(parsed.externalId);
    // What the store actually keeps: a preview of the body, capped at 500 characters, plus
    // whichever analysis the message ended up with.
    const finalAnalysis = skippedOnSave ? saved[0]! : analysis;
    const row = {
      id: `cache-${parsed.externalId}`,
      connector_account_id: "account-1",
      owner_user_id: "user-1",
      sender: parsed.from,
      recipients: ["ben@example.invalid"],
      subject: parsed.subject,
      snippet: parsed.body.slice(0, 200),
      body_excerpt: parsed.body.slice(0, 500),
      received_at: new Date("2026-08-03T12:00:00.000Z"),
      external_id: parsed.externalId,
      external_metadata: { threadId: "thread-1" },
      summary: finalAnalysis.summary,
      signals: finalAnalysis.signals,
      created_at: new Date("2026-08-03T12:00:00.000Z"),
      updated_at: new Date("2026-08-03T12:00:00.000Z")
    } as unknown as EmailMessage;
    return {
      skippedOnSave,
      item: emailContextItemFromCache(
        row,
        { connectorAccountId: "account-1", providerId: "google", providerLabel: "Gmail" },
        null
      )
    };
  }

  it("keeps the summary and the suggested task when the door wording falls past the preview", async () => {
    const { skippedOnSave, item } = await saveThenRead(doorInstructions, {
      summary: "The apartment passcode and door instructions for your arrival.",
      signals: {
        confidence: 0.9,
        actionability: {
          category: "needs_action",
          inferredSubject: "Use the apartment passcode on arrival",
          suggestedTasks: [{ text: "Bring photo ID to the apartment" }]
        }
      }
    });

    expect(skippedOnSave).toBe(false);
    expect(item.summary).toBe("The apartment passcode and door instructions for your arrival.");
    expect(item.actionability).toBe("needs_action");
    expect(item.suggestedTasks.length).toBeGreaterThan(0);
  });

  it("hides a real sign-in code through the same save-and-read path", async () => {
    const { skippedOnSave, item } = await saveThenRead(
      fixture({
        externalId: "otp-save-1",
        from: "Google <no-reply@accounts.google.com>",
        subject: "Your Google verification code",
        body: "482910 is your Google verification code. Do not share it with anyone."
      }),
      { summary: null, signals: {} }
    );

    expect(skippedOnSave).toBe(true);
    expect(item.summary).toBeNull();
    expect(item.actionability).toBe("unknown");
    expect(item.suggestedTasks).toEqual([]);
  });
});

/** The two examples the reviewer ran that were wrongly hidden in the previous round. */
describe("messages the previous round wrongly hid", () => {
  it("keeps a hotel message that mentions a stay", () => {
    expect(
      looksLikeOneTimeCodeEmail({
        from: "notifications@hotel.example.invalid",
        subject: "Your one-time passcode",
        body: "Your one-time passcode is 581496. Enjoy your stay with us this weekend"
      })
    ).toBe(false);
  });

  it("keeps a bank policy notice whose only number is a support telephone line", async () => {
    const message = {
      from: "no-reply@bank.example.invalid",
      subject: "Security code policy update",
      body:
        "We are changing how security codes are delivered. Please review the new policy. " +
        "For help, call 0800 123 4567."
    };

    expect(looksLikeOneTimeCodeEmail(message)).toBe(false);

    const runChat = vi.fn(async () => ({
      text: JSON.stringify({ category: "unknown", confidence: 0.4 })
    }));

    const result = await extractEmailSignals(fixture(message), { runChat });

    expect(runChat).toHaveBeenCalledTimes(1);
    expect(result.signals.skipped).toBeUndefined();
  });

  it("does not treat a telephone number on its own as a sign-in code", () => {
    expect(
      looksLikeOneTimeCodeEmail({
        from: "no-reply@accounts.example.invalid",
        subject: "Your verification code",
        body: "If you did not ask for this, call us on 0800 123 4567."
      })
    ).toBe(false);
  });
});
