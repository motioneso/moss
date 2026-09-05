import { describe, expect, it, vi } from "vitest";

import {
  looksLikeBulkMail,
  extractEmailSignals,
  extractEmailSignalsBatch,
  parseEmail,
  type EmailExtractDeps,
  type EmailExtractResult,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";
import {
  sortFetchedEmails,
  type SavedEmailMarker
} from "../../packages/connectors/src/google-sync-phases.js";

/**
 * #2271 round 2. The earlier version of this file handed the extractor a fixed "noise" answer and
 * then checked that particular words appeared in the instructions, so it proved almost nothing.
 * These tests run a set of invented emails through the real path instead: the real bulk-mail rule,
 * the real sign-in-code rule, the real sorting step that decides what reaches the model, the real
 * prompt builder, and the real code that turns a verdict into stored triage and suggested tasks.
 *
 * What a unit test cannot do is judge the model: the category itself comes back from the model, so
 * these tests supply a per-email verdict and prove the code around it behaves. Evidence that the
 * rewritten instructions actually sort a promotion into noise has to come from the live re-judge
 * run on dev, which is why the pull request still says code-complete, unverified.
 */

const OWN_ADDRESS = "ben@example.com";

interface Corpus {
  /** Plain name used in test output. */
  readonly name: string;
  readonly email: ParsedEmail;
  /** What the real bulk-mail rule should say about it. */
  readonly bulk: boolean;
  /** A plausible verdict for this email, in the compact shape the model actually returns. */
  readonly verdict: Record<string, unknown>;
}

function email(overrides: Partial<ParsedEmail> & Pick<ParsedEmail, "externalId">): ParsedEmail {
  return {
    threadId: null,
    historyId: null,
    subject: "Subject",
    from: "someone@example.com",
    recipients: [OWN_ADDRESS],
    receivedAt: "2026-09-01T12:00:00.000Z",
    labelIds: ["INBOX", "IMPORTANT"],
    snippet: "",
    body: "",
    bodyTruncated: false,
    ...overrides
  };
}

const UNSUBSCRIBE_FOOTER = "\n\nDo not want these? Unsubscribe at any time.";

/**
 * Invented mail modelled on the real misfiled messages from Ben's inbox: a clothing sale, a ticket
 * drop, an advocacy campaign, a terms update, a sign-in notice, a listening party and a drill, plus
 * the obligations that must survive - a rent reminder that carries an unsubscribe link, a declined
 * payment, a recruiter, and a sign-in code that must never reach the model at all.
 */
const CORPUS: readonly Corpus[] = [
  {
    name: "a clothing sale with urgent wording",
    email: email({
      externalId: "promo-run-gear",
      subject: "A refresh on your favourite run gear",
      from: "Roark <news@roark.example>",
      body: "New colours just dropped. Act now, this ends tonight." + UNSUBSCRIBE_FOOTER
    }),
    bulk: true,
    verdict: { category: "noise", reason: "A clothing sale.", confidence: 0.9 }
  },
  {
    name: "a ticket on-sale announcement",
    email: email({
      externalId: "promo-tickets",
      subject: "Tickets go on sale Friday",
      from: "Public Service Broadcasting <mail@band.example>",
      body: "Presale opens at 10am and these always sell out fast." + UNSUBSCRIBE_FOOTER
    }),
    bulk: true,
    verdict: { category: "noise", reason: "A ticket release.", confidence: 0.85 }
  },
  {
    name: "an advocacy campaign asking for action",
    email: email({
      externalId: "promo-campaign",
      subject: "Action required: tell your senator today",
      from: "Breakthrough T1D <advocacy@charity.example>",
      body: "Add your name before the vote. This is our last chance." + UNSUBSCRIBE_FOOTER
    }),
    bulk: true,
    verdict: { category: "noise", reason: "A fundraising campaign.", confidence: 0.8 }
  },
  {
    name: "a terms-of-service update",
    email: email({
      externalId: "policy-terms",
      subject: "We are updating our terms",
      from: "Spotify <no-reply@spotify.example>",
      body: "The changes take effect next month. No action is needed." + UNSUBSCRIBE_FOOTER
    }),
    bulk: true,
    verdict: { category: "fyi", reason: "A policy update.", confidence: 0.9 }
  },
  {
    name: "a new-sign-in notice where nothing failed",
    email: email({
      externalId: "security-signin",
      subject: "New sign-in on a Windows device",
      from: "Google <no-reply@accounts.google.example>",
      body: "You signed in on a new device. If this was you, there is nothing to do."
    }),
    bulk: false,
    verdict: { category: "fyi", reason: "A routine security notice.", confidence: 0.9 }
  },
  {
    name: "a listening party starting soon",
    email: email({
      externalId: "promo-listening-party",
      subject: "Starting in 30 minutes",
      from: "Bandcamp <noreply@bandcamp.example>",
      body: "Join the artist and listen along with everyone else." + UNSUBSCRIBE_FOOTER
    }),
    bulk: true,
    verdict: { category: "noise", reason: "An event promo.", confidence: 0.85 }
  },
  {
    name: "a scheduled emergency-alert drill",
    email: email({
      externalId: "promo-drill",
      subject: "This is a test of the emergency notification system",
      from: "SDGE <alerts@utility.example>",
      body: "No action is required. This is only a test." + UNSUBSCRIBE_FOOTER
    }),
    bulk: true,
    verdict: { category: "noise", reason: "A scheduled test alert.", confidence: 0.9 }
  },
  {
    name: "a rent reminder that also carries an unsubscribe link",
    email: email({
      externalId: "obligation-rent",
      subject: "Your September rent statement",
      from: "Parkside Residences <billing@landlord.example>",
      body: "A balance of 2,150 dollars is due on the first of the month." + UNSUBSCRIBE_FOOTER
    }),
    bulk: true,
    verdict: {
      category: "needs_action",
      reason: "Rent is due.",
      action: "Pay the rent",
      dueDate: "2026-10-01",
      confidence: 0.95
    }
  },
  {
    name: "a declined payment",
    email: email({
      externalId: "obligation-payment",
      subject: "We could not process your payment",
      from: "PayPal <service@paypal.example>",
      body: "Your card was declined, so the transaction did not go through."
    }),
    bulk: false,
    verdict: {
      category: "needs_action",
      reason: "A payment failed.",
      action: "Update the card on file",
      dueDate: "2026-09-08",
      confidence: 0.9
    }
  },
  {
    name: "a recruiter asking for times",
    email: email({
      externalId: "obligation-reply",
      subject: "Chat this week?",
      from: "Dana Okafor <dana@recruiting.example>",
      body: "Which afternoons suit you? Happy to work around your schedule."
    }),
    bulk: false,
    verdict: {
      category: "needs_reply",
      reason: "A person is waiting.",
      action: "Send Dana some times",
      confidence: 0.9
    }
  },
  {
    name: "a sign-in code",
    email: email({
      externalId: "code-verification",
      subject: "Your verification code",
      from: "Google <no-reply@accounts.google.example>",
      body: "482910 is your Google verification code. Do not share it with anyone."
    }),
    bulk: false,
    verdict: { category: "unknown", confidence: 0 }
  }
];

const byId = new Map(CORPUS.map((entry) => [entry.email.externalId, entry]));
const SIGN_IN_CODE_ID = "code-verification";

/**
 * Stands in for the model. It answers from the corpus, keyed off the subject line it can see in
 * the prompt, and records every prompt it was given so the tests can check what was actually sent.
 */
function fakeModel(): { deps: EmailExtractDeps; prompts: string[] } {
  const prompts: string[] = [];
  const deps: EmailExtractDeps = {
    runChat: async (prompt: string) => {
      prompts.push(prompt);
      const entry = CORPUS.find((candidate) =>
        prompt.includes(`Subject: ${candidate.email.subject}`)
      );
      if (!entry) throw new Error(`no corpus entry matched the prompt: ${prompt.slice(0, 80)}`);
      return { text: JSON.stringify(entry.verdict) };
    }
  };
  return { deps, prompts };
}

/** Runs the corpus through the real sorting step and then the real extractor, as the sync does. */
async function runWholeCorpus(): Promise<{
  readonly pending: ParsedEmail[];
  readonly otpKeys: string[];
  readonly prompts: string[];
  readonly results: Map<string, EmailExtractResult>;
}> {
  const progress = { emailUpserted: 0, emailFailures: 0, errors: [] as string[] };
  const { pending, otpKeys } = await sortFetchedEmails({
    parsedMessages: CORPUS.map((entry) => entry.email),
    seen: new Map<string, SavedEmailMarker>(),
    persistEmail: async () => {},
    progress,
    onFailure: (error) => {
      throw error;
    }
  });
  const { deps, prompts } = fakeModel();
  const results = new Map<string, EmailExtractResult>();
  // One message per call, exactly as the sync batches them.
  for (const message of pending) {
    const [result] = await extractEmailSignalsBatch([message], deps);
    results.set(message.externalId, result!);
  }
  return { pending, otpKeys, prompts, results };
}

describe("the bulk-mail rule itself", () => {
  it("agrees with every invented email in the corpus", () => {
    for (const entry of CORPUS) {
      expect(looksLikeBulkMail(entry.email), entry.name).toBe(entry.bulk);
    }
  });

  it("counts a message that carried an unsubscribe header even with no such word in the body", () => {
    expect(looksLikeBulkMail({ hasListUnsubscribe: true, body: "Nothing here." })).toBe(true);
  });

  it("does not count the word buried inside a longer one", () => {
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

describe("what the sync sends to the model", () => {
  it("holds back the sign-in code and sends every other invented email, bulk mail included", async () => {
    const { pending, otpKeys } = await runWholeCorpus();
    expect(otpKeys).toEqual([SIGN_IN_CODE_ID]);
    const sent = pending.map((message) => message.externalId).sort();
    const expected = CORPUS.map((entry) => entry.email.externalId)
      .filter((id) => id !== SIGN_IN_CODE_ID)
      .sort();
    // Bulk mail is deliberately still judged: rent and loan reminders carry unsubscribe links too.
    expect(sent).toEqual(expected);
  });

  it("marks exactly the bulk mail in the prompt, and always sends the rules", async () => {
    const { prompts } = await runWholeCorpus();
    for (const prompt of prompts) {
      const entry = CORPUS.find((candidate) =>
        prompt.includes(`Subject: ${candidate.email.subject}`)
      );
      expect(entry, "every prompt belongs to a corpus email").toBeDefined();
      const marked = prompt.includes("Bulk mail: yes (carries an unsubscribe link)");
      expect(marked, entry!.name).toBe(entry!.bulk);
      expect(prompt).toContain("Urgent wording is not evidence on its own");
      expect(prompt).toContain("A real bill or bank alert can still carry an unsubscribe link");
      expect(prompt).toContain(
        "deliversSignInCode: true only when this message hands the recipient"
      );
    }
  });
});

describe("what comes back out", () => {
  it("stores the verdict and the bulk yes-or-no for every invented email", async () => {
    const { results } = await runWholeCorpus();
    for (const [externalId, result] of results) {
      const entry = byId.get(externalId)!;
      expect(result.signals.actionability?.category, entry.name).toBe(entry.verdict.category);
      expect(result.signals.bulk, entry.name).toBe(entry.bulk ? true : undefined);
      expect(JSON.stringify(result.signals)).not.toContain("Unsubscribe at any time");
    }
  });

  it("turns none of the sales, campaigns, policy updates or drills into a task", async () => {
    const { results } = await runWholeCorpus();
    const quiet = CORPUS.filter(
      (entry) => entry.verdict.category === "noise" || entry.verdict.category === "fyi"
    );
    expect(quiet.length).toBeGreaterThan(5);
    for (const entry of quiet) {
      const result = results.get(entry.email.externalId)!;
      expect(result.signals.actionability?.suggestedTasks ?? [], entry.name).toEqual([]);
      // Only the three actionable categories carry a subject through to a flag on Today.
      expect(result.signals.actionability?.inferredSubject, entry.name).toBeUndefined();
    }
  });

  it("still raises the rent reminder that carries an unsubscribe link", async () => {
    const { results } = await runWholeCorpus();
    const rent = results.get("obligation-rent")!;
    expect(rent.signals.bulk).toBe(true);
    expect(rent.signals.actionability?.category).toBe("needs_action");
    expect(rent.signals.actionability?.suggestedTasks).toEqual([
      { text: "Pay the rent", dueDate: "2026-10-01" }
    ]);
    expect(rent.signals.actionability?.inferredSubject).toBe("Your September rent statement");
  });

  it("still raises the declined payment and the recruiter", async () => {
    const { results } = await runWholeCorpus();
    expect(results.get("obligation-payment")!.signals.actionability?.category).toBe("needs_action");
    expect(results.get("obligation-payment")!.signals.actionability?.suggestedTasks).toEqual([
      { text: "Update the card on file", dueDate: "2026-09-08" }
    ]);
    const recruiter = results.get("obligation-reply")!;
    expect(recruiter.signals.actionability?.category).toBe("needs_reply");
    expect(recruiter.signals.bulk).toBeUndefined();
  });

  it("never asks the model about the sign-in code", async () => {
    const { prompts } = await runWholeCorpus();
    for (const prompt of prompts) {
      expect(prompt).not.toContain("482910");
    }
  });
});

describe("a message the sorting step passes straight to the extractor", () => {
  it("marks bulk mail when only the header said so, with no such word in the body", async () => {
    const seen = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("Bulk mail: yes (carries an unsubscribe link)");
      return { text: JSON.stringify({ category: "noise", confidence: 0.9 }) };
    });
    const result = await extractEmailSignals(
      email({
        externalId: "header-only",
        subject: "Weekend hours",
        from: "Shop <news@shop.example>",
        hasListUnsubscribe: true,
        body: "We are open late on Saturday."
      }),
      { runChat: seen }
    );
    expect(seen).toHaveBeenCalledTimes(1);
    expect(result.signals.bulk).toBe(true);
  });
});
