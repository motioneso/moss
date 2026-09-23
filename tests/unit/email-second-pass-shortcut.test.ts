import { describe, expect, it, vi } from "vitest";

import {
  resolveMaybeOwedGate,
  type MaybeOwedGateContext
} from "../../packages/connectors/src/email-gate.js";
import {
  extractEmailSignals,
  type EmailExtractDeps,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

function parsed(over: Partial<ParsedEmail>): ParsedEmail {
  return {
    externalId: "m1",
    threadId: "t1",
    historyId: "1",
    subject: "Hello",
    from: "a@example.com",
    recipients: ["ben@ben.com"],
    receivedAt: "2026-09-04T10:00:00Z",
    labelIds: [],
    snippet: null,
    body: "body",
    bodyTruncated: false,
    hasListUnsubscribe: false,
    ...over
  };
}

const answer = (obj: unknown): EmailExtractDeps => ({
  runChat: vi.fn(async () => ({ text: JSON.stringify(obj) }))
});

const BULK_UNKNOWN: MaybeOwedGateContext = { bulk: true, knownSender: false };
const BULK_KNOWN: MaybeOwedGateContext = { bulk: true, knownSender: true };
const PLAIN_UNKNOWN: MaybeOwedGateContext = { bulk: false, knownSender: false };

describe("second-pass shortcut (bulk mail only)", () => {
  it("resolves a bulk advert from an unknown sender only when the first pass called it noise", () => {
    const advert: MaybeOwedGateContext = {
      ...BULK_UNKNOWN,
      subject: "UP TO 60% OFF BEST SELLERS",
      body: "Shop the sale now. New styles added every Friday."
    };
    expect(resolveMaybeOwedGate("noise", advert)).toBe("nothing");
    expect(resolveMaybeOwedGate("fyi", advert)).toBe("maybe_owed");
    expect(resolveMaybeOwedGate("unknown", advert)).toBe("maybe_owed");
    expect(resolveMaybeOwedGate(undefined, advert)).toBe("maybe_owed");
  });

  it("never takes the shortcut when the body is empty, whatever the verdict", () => {
    const subjectOnly: MaybeOwedGateContext = {
      ...BULK_UNKNOWN,
      subject: "UP TO 60% OFF BEST SELLERS",
      body: ""
    };
    expect(resolveMaybeOwedGate("noise", subjectOnly)).toBe("maybe_owed");
  });

  it("keeps a bulk security alert on the closer look even when the first pass called it noise", () => {
    const alert: MaybeOwedGateContext = {
      ...BULK_UNKNOWN,
      subject: "Security alert",
      body: "A new device was added. Unsubscribe any time."
    };
    for (const category of ["fyi", "noise", "unknown", undefined]) {
      expect(resolveMaybeOwedGate(category, alert)).toBe("maybe_owed");
    }
  });

  it("never takes the shortcut for a known sender, even bulk mail", () => {
    expect(resolveMaybeOwedGate("fyi", BULK_KNOWN)).toBe("maybe_owed");
    expect(resolveMaybeOwedGate("noise", BULK_KNOWN)).toBe("maybe_owed");
  });

  it("never takes the shortcut for non-bulk mail", () => {
    expect(resolveMaybeOwedGate("fyi", PLAIN_UNKNOWN)).toBe("maybe_owed");
    expect(resolveMaybeOwedGate("unknown", PLAIN_UNKNOWN)).toBe("maybe_owed");
    expect(resolveMaybeOwedGate(undefined, PLAIN_UNKNOWN)).toBe("maybe_owed");
  });

  it("never overrides an answer that named a real obligation", () => {
    for (const category of [
      "needs_reply",
      "needs_action",
      "time_sensitive_info",
      "waiting_on_someone"
    ]) {
      expect(resolveMaybeOwedGate(category, BULK_UNKNOWN)).toBe("maybe_owed");
    }
  });
});

describe("second-pass shortcut through the single-message extraction", () => {
  it("leaves a bulk advert out entirely when the first pass called it noise", async () => {
    const r = await extractEmailSignals(
      parsed({
        subject: "UP TO 60% OFF BEST SELLERS",
        body: "Shop the sale now. New styles added every Friday. Unsubscribe any time.",
        hasListUnsubscribe: true
      }),
      answer({ gate: "maybe_owed", category: "noise", confidence: 0.7, reason: "A sale." })
    );
    expect(r.gate).toBe("nothing");
    expect(r.signals.pendingJudgement).toBeUndefined();
  });

  it("keeps a bulk bill the model named an obligation", async () => {
    const r = await extractEmailSignals(
      parsed({
        subject: "Electric bill due Friday",
        body: "Your bill is due Friday. Unsubscribe from paperless notices.",
        hasListUnsubscribe: true
      }),
      answer({
        gate: "maybe_owed",
        category: "needs_action",
        confidence: 0.8,
        reason: "A payment is due."
      })
    );
    expect(r.gate).toBe("maybe_owed");
    expect(r.signals.pendingJudgement).toBe(true);
  });

  it("does not shortcut a known sender's mail", async () => {
    const r = await extractEmailSignals(
      parsed({
        subject: "Lunch next week?",
        body: "Are you free on Tuesday?",
        from: "Alice <alice@example.com>"
      }),
      answer({ gate: "maybe_owed", category: "fyi", confidence: 0.6, reason: "Unsure." }),
      { knownSender: true }
    );
    expect(r.gate).toBe("maybe_owed");
    expect(r.signals.pendingJudgement).toBe(true);
  });
});

/**
 * Every one of these is a made-up security alert a user must not lose. The shortcut must let all
 * of them reach the closer look, whatever the cheap model's category is. (Round-two review of
 * #2600: an earlier wording-based "no-failure notice" rule dropped 19 of these, so the security
 * half was removed.)
 */
const MUST_REACH_THE_CLOSER_LOOK: ReadonlyArray<readonly [string, string]> = [
  ["Security alert", ""],
  ["Critical security alert", "Someone knows your password. Check activity now."],
  ["Critical security alert for your linked account", "Someone may have your password."],
  ["Security alert", "A new device was added. If you don't recognize this device, remove it."],
  ["Your password was changed", "If you don't recognize this change, contact support immediately."],
  ["Recovery email changed", "If you do not recognise this, reset your password."],
  ["Recovery phone updated", "Not expected? Review your security settings."],
  [
    "New sign-in to your account",
    "If this was you, ignore this. If not, reset your password right away."
  ],
  ["New login from Moscow, Russia", "Otherwise change your password immediately."],
  ["Two-step verification turned off", "Turn it back on to protect your account."],
  ["Security notice", "Your email forwarding rule was created to an external address."],
  ["Security alert: new sign-in", "Someone else might be using your account."],
  ["New device signed in", "Please verify it was you."],
  ["Security alert", "Your account is at risk. Take action now."],
  ["Password was reset", "Your password was reset by an administrator. Call IT if unexpected."],
  ["Didn&#8217;t sign in?", ""],
  ["wasn&rsquo;t you", ""],
  ["wasn&#39;t you", ""],
  ["didn\u02bct sign in", ""],
  ["New app password created", "if this wasn't you"],
  ["New passkey added", ""],
  ["Email forwarding enabled", ""],
  ["Someone added a new email address", ""],
  ["Your PIN was changed", ""],
  ["Alerte de sécurité", ""],
  ["Neue Anmeldung", ""],
  ["Alerte de sécurité", "Nouvelle connexion détectée"]
];

describe("security and sign-in alerts always reach the closer look", () => {
  const UNSUBSCRIBE_MARKS = [
    { name: "no mark", hasListUnsubscribe: false, footer: "" },
    { name: "header", hasListUnsubscribe: true, footer: "" },
    { name: "footer word", hasListUnsubscribe: false, footer: "\nUnsubscribe any time." },
    { name: "both", hasListUnsubscribe: true, footer: "\nUnsubscribe any time." }
  ] as const;

  it.each(MUST_REACH_THE_CLOSER_LOOK)(
    "%s always stays maybe_owed, with or without an unsubscribe mark",
    async (subject, body) => {
      for (const mark of UNSUBSCRIBE_MARKS) {
        for (const category of ["fyi", "noise", "unknown"]) {
          const r = await extractEmailSignals(
            parsed({
              subject,
              body: `${body}${mark.footer}`,
              hasListUnsubscribe: mark.hasListUnsubscribe
            }),
            answer({ gate: "maybe_owed", category, confidence: 0.6, reason: "Unsure." })
          );
          expect({ subject, mark: mark.name, category, gate: r.gate }).toEqual({
            subject,
            mark: mark.name,
            category,
            gate: "maybe_owed"
          });
          expect(r.signals.pendingJudgement).toBe(true);
        }
      }
    }
  );
});
