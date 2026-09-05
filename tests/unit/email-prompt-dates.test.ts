import { describe, expect, it } from "vitest";

import {
  extractEmailSignalsBatch,
  type EmailExtractDeps,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

/**
 * #2271 round 3. An email asking Ben to suggest interview times came back with a due date on the
 * 10th - the interview window in the body - rather than the day his reply was owed. The prompt gave
 * the model the subject, the sender and the body and nothing else: no arrival date, no today's date,
 * and no definition of what a due date means. These tests run the real prompt builder and check that
 * both dates now reach the model and that the rule for due dates is stated.
 *
 * They prove what the code sends, not what the model answers with. Whether the model then dates the
 * reply correctly is only provable on the live re-judge run.
 */

const RECEIVED_AT = "2026-09-03T09:15:00.000Z";

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    externalId: "interview-times",
    threadId: null,
    historyId: null,
    subject: "Interview scheduling",
    from: "Recruiter <hiring@example.com>",
    recipients: ["ben@example.com"],
    receivedAt: RECEIVED_AT,
    labelIds: ["INBOX"],
    snippet: "",
    body: "Could you send a few times that suit you? We are booking the week of the 10th.",
    bodyTruncated: false,
    ...overrides
  };
}

async function capturePrompt(message: ParsedEmail): Promise<string> {
  const prompts: string[] = [];
  const deps: EmailExtractDeps = {
    runChat: async (prompt: string) => {
      prompts.push(prompt);
      return {
        text: JSON.stringify({
          category: "needs_reply",
          reason: "A recruiter is waiting on times.",
          action: "Send interview times",
          dueDate: "2026-09-04",
          confidence: 0.9
        })
      };
    }
  };
  await extractEmailSignalsBatch([message], deps);
  expect(prompts).toHaveLength(1);
  return prompts[0]!;
}

describe("what the model is told about dates", () => {
  it("gives it the date the email arrived", async () => {
    const prompt = await capturePrompt(email());
    expect(prompt).toContain("Received: 2026-09-03");
  });

  it("gives it today's date", async () => {
    const prompt = await capturePrompt(email());
    const today = new Date().toISOString().slice(0, 10);
    expect(prompt).toContain(`Today: ${today}`);
  });

  it("leaves the arrival line out rather than sending a broken date", async () => {
    const prompt = await capturePrompt(email({ receivedAt: "not a date" }));
    expect(prompt).not.toContain("Received:");
    expect(prompt).toContain("Today: ");
  });

  it("keeps the dates above the body, where the rest of the header lines are", async () => {
    const prompt = await capturePrompt(email());
    expect(prompt.indexOf("Received: ")).toBeGreaterThan(prompt.indexOf("Subject: "));
    expect(prompt.indexOf("Received: ")).toBeLessThan(prompt.indexOf("Could you send a few times"));
    expect(prompt.indexOf("Today: ")).toBeLessThan(prompt.indexOf("Could you send a few times"));
  });
});

describe("what the model is told a due date means", () => {
  it("says a due date is when the user's own answer is owed, not when the event is", async () => {
    const prompt = await capturePrompt(email());
    expect(prompt).toContain("dueDate is the date the user's own reply or action is owed");
    expect(prompt).toContain(
      "It is NOT the date of the event,\nmeeting, interview, appointment or booking window"
    );
  });

  it("says a request to suggest times is owed within a business day of arrival", async () => {
    const prompt = await capturePrompt(email());
    expect(prompt).toContain("suggest, choose or confirm times");
    expect(prompt).toContain("one business day of Received unless the sender names an earlier");
    expect(prompt).toContain("never the date of the\nslot being arranged");
  });

  it("says a deadline the sender states for the user wins", async () => {
    const prompt = await capturePrompt(email());
    expect(prompt).toContain("a payment date, a form\ncut-off, an RSVP date");
  });

  it("tells it to read the two date lines for relative wording", async () => {
    const prompt = await capturePrompt(email());
    expect(prompt).toContain("Use them to");
    expect(prompt).toContain('"tomorrow"');
  });
});
