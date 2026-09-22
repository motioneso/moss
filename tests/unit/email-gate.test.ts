import { describe, expect, it, vi } from "vitest";
import {
  extractEmailSignals,
  type EmailExtractDeps,
  type ParsedEmail
} from "../../packages/connectors/src/email-extract.js";

export function parsed(over: Partial<ParsedEmail>): ParsedEmail {
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

describe("email gate", () => {
  it("nothing: stores no summary and a noise verdict", async () => {
    const r = await extractEmailSignals(
      parsed({ subject: "Weekend sale" }),
      answer({ gate: "nothing", summary: "A sale" })
    );
    expect(r.gate).toBe("nothing");
    expect(r.summary).toBeNull();
    expect(r.signals.actionability?.category).toBe("noise");
    expect(r.signals.pendingJudgement).toBeUndefined();
  });
  it("worth_knowing: keeps the summary, verdict fyi", async () => {
    const r = await extractEmailSignals(
      parsed({ subject: "Your parcel arrived" }),
      answer({ gate: "worth_knowing", summary: "Parcel delivered" })
    );
    expect(r.gate).toBe("worth_knowing");
    expect(r.summary).toBe("Parcel delivered");
    expect(r.signals.actionability?.category).toBe("fyi");
  });
  it("maybe_owed: no summary, no verdict, pending flag", async () => {
    const r = await extractEmailSignals(
      parsed({ subject: "Lease addendum" }),
      answer({ gate: "maybe_owed", summary: "Landlord wants addendum" })
    );
    expect(r.gate).toBe("maybe_owed");
    expect(r.summary).toBeNull();
    expect(r.signals.actionability).toBeUndefined();
    expect(r.signals.pendingJudgement).toBe(true);
  });
  it("a bulk advert the model flagged anyway never reaches the second pass (#2341)", async () => {
    const r = await extractEmailSignals(
      parsed({
        subject: "UP TO 60% OFF BEST SELLERS",
        body: "Shop the sale now. Unsubscribe any time.",
        hasListUnsubscribe: true
      }),
      answer({ gate: "maybe_owed", category: "noise", confidence: 0.7, reason: "A sale." })
    );
    expect(r.gate).toBe("nothing");
    expect(r.signals.pendingJudgement).toBeUndefined();
    expect(r.signals.actionability?.category).toBe("noise");
  });
  it("a sign-in notice the model flagged anyway still reaches the closer look (#2341)", async () => {
    // The security half of the shortcut was removed after review: recognizing a "no-failure"
    // notice from wording drops real account-takeover alerts, so these always keep maybe_owed.
    const r = await extractEmailSignals(
      parsed({
        subject: "Verify Discord Login from New Location",
        body: "If this was you, no action is needed."
      }),
      answer({
        gate: "maybe_owed",
        category: "fyi",
        confidence: 0.7,
        reason: "A sign-in notice."
      })
    );
    expect(r.gate).toBe("maybe_owed");
    expect(r.signals.pendingJudgement).toBe(true);
  });
  it("a sign-in notice with an unsubscribe mark still reaches the closer look (#2341)", async () => {
    for (const category of ["fyi", "noise"]) {
      const r = await extractEmailSignals(
        parsed({
          subject: "Verify Discord Login from New Location",
          body: "If this was you, no action is needed. Unsubscribe any time.",
          hasListUnsubscribe: true
        }),
        answer({
          gate: "maybe_owed",
          category,
          confidence: 0.7,
          reason: "A sign-in notice."
        })
      );
      expect(r.gate).toBe("maybe_owed");
      expect(r.signals.pendingJudgement).toBe(true);
    }
  });
  it("an obligation answer is never overridden (#2341)", async () => {
    const r = await extractEmailSignals(
      parsed({
        subject: "Verify Discord Login from New Location",
        body: "If this was you, no action is needed."
      }),
      answer({
        gate: "maybe_owed",
        category: "needs_action",
        confidence: 0.7,
        reason: "A sign-in needs review."
      })
    );
    expect(r.gate).toBe("maybe_owed");
    expect(r.signals.pendingJudgement).toBe(true);
  });
  it("does not shortcut a known sender's mail to worth_knowing (#2341)", async () => {
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
  it("keeps a bulk bill the model named an obligation (#2341)", async () => {
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
  it("a real obligation still reaches the second pass (#2341)", async () => {
    const r = await extractEmailSignals(
      parsed({ subject: "Lease addendum" }),
      answer({
        gate: "maybe_owed",
        category: "needs_action",
        confidence: 0.8,
        reason: "The landlord is waiting on a signature."
      })
    );
    expect(r.gate).toBe("maybe_owed");
    expect(r.signals.pendingJudgement).toBe(true);
  });
  it("prompt carries the three outcomes and the 2271 lists", async () => {
    const deps = answer({ gate: "nothing" });
    await extractEmailSignals(parsed({}), deps);
    const prompt = (deps.runChat as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    for (const s of [
      "nothing",
      "worth_knowing",
      "maybe_owed",
      "unsubscribe",
      "sign-in",
      "terms of service",
      "When you cannot tell, answer maybe_owed"
    ]) {
      expect(prompt).toContain(s);
    }
  });
  it("an unknown gate value is treated as nothing", async () => {
    const r = await extractEmailSignals(parsed({}), answer({ gate: "banana", summary: "x" }));
    expect(r.gate).toBe("nothing");
    expect(r.summary).toBeNull();
  });
  it("otp skip still wins before the model", async () => {
    const deps = answer({ gate: "maybe_owed" });
    const r = await extractEmailSignals(
      parsed({ subject: "Your sign-in code is 123456", body: "123456 is your code" }),
      deps
    );
    expect(r.signals.skipped).toBe("otp");
    expect(deps.runChat).not.toHaveBeenCalled();
  });
});
