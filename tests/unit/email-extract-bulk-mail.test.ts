import { describe, expect, it } from "vitest";

import {
  looksLikeBulkMail,
  extractEmailSignals,
  parseEmail,
  type EmailExtractDeps,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

function parsedEmail(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    externalId: "msg-1",
    threadId: null,
    historyId: null,
    subject: "A Refresh On Your Favorite Run Gear",
    from: "Roark <news@roark.example>",
    recipients: ["ben@example.com"],
    receivedAt: "2026-09-01T12:00:00.000Z",
    labelIds: ["INBOX", "IMPORTANT"],
    snippet: "New colours just dropped",
    body: "New colours just dropped. Act now, this ends tonight.",
    bodyTruncated: false,
    ...overrides
  };
}

const REPLY = {
  summary: "A clothing sale.",
  billsDue: [],
  actionItems: [],
  deadlines: [],
  mayGetLostInShuffle: false,
  importance: "normal",
  confidence: 0.9,
  actionability: { category: "noise" }
};

/** Runs one extraction and hands back the prompt the model was given. */
async function promptFor(parsed: ParsedEmail): Promise<string> {
  let seen = "";
  const deps: EmailExtractDeps = {
    runChat: async (prompt) => {
      seen = prompt;
      return { text: JSON.stringify(REPLY) };
    }
  };
  await extractEmailSignals(parsed, deps);
  return seen;
}

describe("recognizing bulk mail", () => {
  it("counts a message that carried an unsubscribe header", () => {
    expect(looksLikeBulkMail({ hasListUnsubscribe: true, body: "Nothing here." })).toBe(true);
  });

  it("counts a message whose body offers to unsubscribe when no header was seen", () => {
    expect(looksLikeBulkMail({ body: "Not interested? Unsubscribe here." })).toBe(true);
    expect(looksLikeBulkMail({ hasListUnsubscribe: false, body: "Click to unsubscribe" })).toBe(
      true
    );
  });

  it("does not count ordinary mail, or the word buried inside a longer one", () => {
    expect(looksLikeBulkMail({ body: "Hey, are you free Thursday?" })).toBe(false);
    expect(looksLikeBulkMail({ hasListUnsubscribe: false, body: "unsubscribable_link" })).toBe(
      false
    );
  });
});

describe("reading the header off a fetched Gmail message", () => {
  const gmailMessage = (headers: Array<{ name: string; value: string }>) => ({
    id: "gmail-1",
    internalDate: "1756732800000",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Sale" }, ...headers],
      body: { data: Buffer.from("Sale on now.").toString("base64url") }
    }
  });

  it("says yes when the header is there, without keeping its value", () => {
    const parsed = parseEmail(
      gmailMessage([{ name: "List-Unsubscribe", value: "<mailto:stop@roark.example>" }])
    );
    expect(parsed.hasListUnsubscribe).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("stop@roark.example");
  });

  it("says no when it is not", () => {
    expect(parseEmail(gmailMessage([])).hasListUnsubscribe).toBe(false);
  });
});

describe("the bulk-mail line in the prompt", () => {
  it("is present when the header was there", async () => {
    const prompt = await promptFor(parsedEmail({ hasListUnsubscribe: true, body: "Sale on now." }));
    expect(prompt).toContain("Bulk mail: yes (carries an unsubscribe link)");
  });

  it("is present when only the body says unsubscribe", async () => {
    const prompt = await promptFor(
      parsedEmail({ body: "Tickets on sale now. Unsubscribe from these emails." })
    );
    expect(prompt).toContain("Bulk mail: yes");
  });

  it("is absent for a message from a person", async () => {
    const prompt = await promptFor(
      parsedEmail({
        subject: "Hey",
        from: "Sam <sam@example.com>",
        body: "Are you around this weekend?"
      })
    );
    // The rules themselves mention bulk mail, so this checks for the marker line that only ever
    // appears alongside the message's own subject and sender.
    expect(prompt).not.toContain("Bulk mail: yes (carries an unsubscribe link)");
  });
});

describe("the triage instructions", () => {
  it("say urgent wording alone is not evidence", async () => {
    const prompt = await promptFor(parsedEmail());
    expect(prompt).toContain("Urgent wording is not evidence on its own");
    expect(prompt).toContain("action required");
  });

  it("list the things that are only worth knowing about", async () => {
    const prompt = await promptFor(parsedEmail());
    expect(prompt).toContain("new-sign-in and security-alert notices where");
    expect(prompt).toContain("nothing actually failed");
    expect(prompt).toContain("terms-of-service, privacy and policy updates");
    expect(prompt).toContain("account activity");
    expect(prompt).toContain("calendar notifications");
    expect(prompt).toContain("shipping notices");
  });

  it("list the things that are not worth surfacing at all", async () => {
    const prompt = await promptFor(parsedEmail());
    expect(prompt).toContain("ticket releases and on-sale announcements");
    expect(prompt).toContain("fundraising and");
    expect(prompt).toContain("advocacy campaigns, petitions, event promos and listening parties");
    expect(prompt).toContain("newsletters and digests");
    expect(prompt).toContain("test alerts and scheduled drills");
    expect(prompt).toContain("product update and release announcements");
  });

  it("keep time-sensitive news to things that affect this person", async () => {
    const prompt = await promptFor(parsedEmail());
    expect(prompt).toContain("it affects this user directly and it expires");
    expect(prompt).toContain("Never a seller's or an artist's event");
  });

  it("tell the model a bill can still carry an unsubscribe link", async () => {
    const prompt = await promptFor(parsedEmail());
    expect(prompt).toContain("A real bill or bank alert can still carry an unsubscribe link");
  });

  it("still ask whether the message hands over a sign-in code", async () => {
    const prompt = await promptFor(parsedEmail());
    expect(prompt).toContain("deliversSignInCode: true only when this message hands the recipient");
    expect(prompt).toContain("Never repeat the code itself anywhere in your answer.");
  });
});

describe("what gets stored", () => {
  it("records bulk mail as a plain yes, and never the unsubscribe address", async () => {
    const result = await extractEmailSignals(
      parsedEmail({ hasListUnsubscribe: true, body: "Sale on now. mailto:stop@roark.example" }),
      { runChat: async () => ({ text: JSON.stringify(REPLY) }) }
    );
    expect(result.signals.bulk).toBe(true);
    expect(JSON.stringify(result.signals)).not.toContain("stop@roark.example");
  });

  it("leaves the flag off ordinary mail", async () => {
    const result = await extractEmailSignals(
      parsedEmail({ subject: "Hey", from: "Sam <sam@example.com>", body: "Free Thursday?" }),
      { runChat: async () => ({ text: JSON.stringify(REPLY) }) }
    );
    expect(result.signals.bulk).toBeUndefined();
  });

  it("does not change what a noise verdict turns into", async () => {
    const result = await extractEmailSignals(parsedEmail({ hasListUnsubscribe: true }), {
      runChat: async () => ({ text: JSON.stringify(REPLY) })
    });
    expect(result.signals.actionability?.category).toBe("noise");
    expect(result.signals.actionability?.suggestedTasks ?? []).toEqual([]);
  });
});
