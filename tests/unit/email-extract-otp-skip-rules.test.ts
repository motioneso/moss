import { describe, expect, it, vi } from "vitest";

import {
  extractEmailSignals,
  extractEmailSignalsBatch,
  looksLikeOneTimeCodeEmail,
  otpSkippedResult,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

// Second half of the sign-in code skip specification (the first half is
// email-extract-otp-skip.test.ts); split so neither file passes the 1000-line cap.

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

/**
 * The messages a live run over a real inbox found still getting through. Every one of them is
 * a genuine sign-in code, and every one arrived from an ordinary-looking mailbox: a hiring
 * site sending from login@, a newspaper sending from ordercs@, a pet insurer sending from
 * hello@. That is why the sender address is no longer part of the decision.
 */
describe("real sign-in code mail from ordinary-looking senders is hidden", () => {
  const realExamples: Array<[string, { from: string; subject: string; body: string }]> = [
    [
      "a hiring site sending from a login mailbox",
      {
        from: "MyGreenhouse <login@hiring.example.invalid>",
        subject: "Here's your MyGreenhouse security code",
        body: "Your security code is 481920. It expires in 10 minutes."
      }
    ],
    [
      "a newspaper sending from a customer service mailbox",
      {
        from: "The Example Times <ordercs@newspaper.example.invalid>",
        subject: "220250 is your verification code",
        body: "220250 is your verification code. Do not share it with anyone."
      }
    ],
    [
      "a pet insurer sending from a hello mailbox",
      {
        from: "Pumpkin <hello@petinsurer.example.invalid>",
        subject: "Your Pumpkin verification code",
        body: "Your verification code is 730915. Enter it to finish signing in."
      }
    ]
  ];

  for (const [label, message] of realExamples) {
    it(`hides ${label}`, async () => {
      expect(looksLikeOneTimeCodeEmail(message)).toBe(true);

      const runChat = vi.fn(async () => ({
        text: JSON.stringify({ category: "unknown", confidence: 0.4 })
      }));

      const result = await extractEmailSignals(fixture(message), { runChat });

      expect(runChat).not.toHaveBeenCalled();
      expect(result).toEqual(otpSkippedResult());
    });
  }
});

/**
 * Round 7 review: with the sender no longer read, three ordinary messages were being hidden.
 * A subject that replies to or forwards an earlier message, or that asks about a code, is a
 * conversation and not a delivery. A number that follows "rejects", "case" or "call" is not a
 * handed-over code, and a telephone number written with brackets is not one either.
 */
describe("ordinary talk about a code is never hidden", () => {
  const conversations: Array<[string, { from: string; subject: string; body: string }]> = [
    [
      "a forwarded request for help whose code the website refused",
      {
        from: "mum@example.invalid",
        subject: "Fwd: Your Google verification code",
        body: "Can you help me sign in? The website rejects 482910 and I need access before Monday."
      }
    ],
    [
      "a support reply carrying a case number",
      {
        from: "alex@support.example.invalid",
        subject: "Re: Your verification code",
        body: "We have resolved case 583921. Please try signing in again and reply if you still need help."
      }
    ],
    [
      "a support message whose only number is a telephone number in brackets",
      {
        from: "alex@support.example.invalid",
        subject: "About your security code",
        body: "Please call me on (415) 555-4829 so I can help you regain access."
      }
    ]
  ];

  for (const [label, message] of conversations) {
    it(`keeps ${label}`, async () => {
      expect(looksLikeOneTimeCodeEmail(message)).toBe(false);

      const runChat = vi.fn(async () => ({
        text: JSON.stringify({ category: "unknown", confidence: 0.4 })
      }));

      const result = await extractEmailSignals(fixture(message), { runChat });

      expect(runChat).toHaveBeenCalledTimes(1);
      expect(result.signals.skipped).toBeUndefined();
    });
  }

  const telephoneShapes: Array<[string, string]> = [
    ["brackets round the area code", "Please call me on (415) 555-4829 if you need a hand."],
    ["brackets and no hyphen", "Please call me on (415) 555 4829 if you need a hand."],
    ["dots between the groups", "Please call me on 415.555.4829 if you need a hand."],
    ["hyphens between the groups", "Please call me on 415-555-4829 if you need a hand."],
    ["a country code in brackets", "Please call me on (+44) 20 7946 0958 if you need a hand."]
  ];

  for (const [label, body] of telephoneShapes) {
    it(`does not read a telephone number with ${label} as a code`, () => {
      expect(
        looksLikeOneTimeCodeEmail({
          from: "alex@support.example.invalid",
          subject: "Your verification code",
          body
        })
      ).toBe(false);
    });
  }

  const numbersThatBelongElsewhere: Array<[string, string]> = [
    ["a case number", "We have resolved case 583921 and closed it."],
    ["a ticket number", "Your ticket 583921 is now with the sign-in team."],
    ["a reference number", "Quote reference 583921 when you write back to us."],
    ["a number the website refused", "The website rejects 482910 every time I try."]
  ];

  for (const [label, body] of numbersThatBelongElsewhere) {
    it(`does not read ${label} as a handed-over code`, () => {
      expect(
        looksLikeOneTimeCodeEmail({
          from: "alex@support.example.invalid",
          subject: "Your verification code",
          body
        })
      ).toBe(false);
    });
  }

  const conversationSubjects = [
    "Re: Your verification code",
    "RE: your sign-in code",
    "Fwd: Your Google verification code",
    "FW: your login code",
    "Fw: your one-time passcode",
    "About your security code",
    "Regarding your verification code",
    "Question about your sign-in code",
    "Help with your verification code",
    "Problem with your login code",
    "Issue with your one-time passcode"
  ];

  for (const subject of conversationSubjects) {
    it(`keeps a message whose subject reads "${subject}"`, () => {
      expect(
        looksLikeOneTimeCodeEmail({
          from: "alex@support.example.invalid",
          subject,
          body: "Your verification code is 482910. Enter it to finish signing in."
        })
      ).toBe(false);
    });
  }

  it("keeps a message whose code is only mentioned, never handed over", () => {
    expect(
      looksLikeOneTimeCodeEmail({
        from: "alex@support.example.invalid",
        subject: "Your verification code",
        body: "I never received it. My colleague on desk 482910 said the same thing happened."
      })
    ).toBe(false);
  });

  it("still hides a code that sits on its own line under a sentence naming it", () => {
    expect(
      looksLikeOneTimeCodeEmail({
        from: "no-reply@accounts.example.invalid",
        subject: "Your verification code",
        body: "Here is your verification code\n\n482910\n\nIt expires in ten minutes."
      })
    ).toBe(true);
  });
});

/**
 * Re-review 8 and Ben's ruling: when the deterministic rule is not sure, the model decides.
 * The subject of each message below names a verification code, so the strict rule stops short
 * and the message goes through the same analysis pass every ordinary email gets. One extra
 * yes/no answer in that pass says whether the message really hands a code over.
 */
describe("when the rule is unsure, the model decides", () => {
  const unclearMessages: Array<[string, { from: string; subject: string; body: string }]> = [
    [
      "a request for help whose code has expired",
      {
        from: "person@example.invalid",
        subject: "Your verification code doesn't work",
        body: "When I enter 482910, the website says it has expired. Can you help me sign in before Monday?"
      }
    ],
    [
      "a support request quoting an error code",
      {
        from: "person@example.invalid",
        subject: "Your verification code",
        body: "The error code is 482910. Please send us a screenshot so we can restore your access."
      }
    ],
    [
      "a request for help with the code on its own line",
      {
        from: "person@example.invalid",
        subject: "Your verification code",
        body: "I cannot sign in with this code:\n\n482910\n\nCan you help me regain access before Monday?"
      }
    ]
  ];

  for (const [label, message] of unclearMessages) {
    it(`asks the model about ${label} and keeps it when the answer is no`, async () => {
      expect(signInCodeDecision(message)).toBe("unclear");

      const runChat = vi.fn(async () => ({
        text: JSON.stringify({
          category: "needs_reply",
          confidence: 0.6,
          deliversSignInCode: false
        })
      }));

      const result = await extractEmailSignals(fixture(message), { runChat });

      expect(runChat).toHaveBeenCalledTimes(1);
      expect(result.signals.skipped).toBeUndefined();
      expect(result.summary).not.toBeNull();
    });

    it(`sets ${label} aside when the model answers yes`, async () => {
      const runChat = vi.fn(async () => ({
        text: JSON.stringify({
          category: "noise",
          confidence: 0.9,
          deliversSignInCode: true
        })
      }));

      const result = await extractEmailSignals(fixture(message), { runChat });

      expect(runChat).toHaveBeenCalledTimes(1);
      expect(result).toEqual(otpSkippedResult());
    });

    it(`sets ${label} aside in a batch when the model answers yes`, async () => {
      const runChat = vi.fn(async () => ({
        text: JSON.stringify({
          category: "noise",
          confidence: 0.9,
          deliversSignInCode: true
        })
      }));

      const results = await extractEmailSignalsBatch([fixture(message)], { runChat });

      expect(runChat).toHaveBeenCalledTimes(1);
      expect(results[0]).toEqual(otpSkippedResult());
    });
  }

  it("never asks the model about a message the strict rule is sure about", () => {
    expect(
      signInCodeDecision({
        from: "Pumpkin <hello@petinsurer.example.invalid>",
        subject: "Your Pumpkin verification code",
        body: "Your verification code is 730915. Enter it to finish signing in."
      })
    ).toBe("hands-over-a-code");
  });

  it("leaves an ordinary message alone even if the model answers yes", async () => {
    const message = {
      from: "sarah.jones@example.invalid",
      subject: "Dinner Saturday",
      body: "The door code is 482910. Please bring dessert and come round about seven."
    };

    expect(signInCodeDecision(message)).toBe("ordinary");

    const runChat = vi.fn(async () => ({
      text: JSON.stringify({
        category: "fyi",
        confidence: 0.8,
        deliversSignInCode: true
      })
    }));

    const result = await extractEmailSignals(fixture(message), { runChat });

    expect(runChat).toHaveBeenCalledTimes(1);
    expect(result.signals.skipped).toBeUndefined();
    expect(result.summary).not.toBeNull();
  });

  it("keeps the yes/no answer out of the stored signals", async () => {
    const runChat = vi.fn(async () => ({
      text: JSON.stringify({
        category: "needs_reply",
        confidence: 0.6,
        deliversSignInCode: false
      })
    }));

    const result = await extractEmailSignals(
      fixture({
        from: "person@example.invalid",
        subject: "Your verification code",
        body: "The error code is 482910. Please send us a screenshot so we can restore your access."
      }),
      { runChat }
    );

    expect(JSON.stringify(result.signals)).not.toContain("deliversSignInCode");
  });
});
