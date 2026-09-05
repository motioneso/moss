import { describe, expect, it } from "vitest";

import type { EmailThreadMessage } from "@moss/module-sdk";

import {
  EMAIL_JUDGEMENT_SERVICE,
  buildEmailJudgementPrompt,
  capQuoteToOneSentence,
  parseEmailJudgement,
  type EmailJudgementPromptInput
} from "../../packages/commitments/src/email-judgement.js";

const msg = (o: Partial<EmailThreadMessage> = {}): EmailThreadMessage => ({
  externalId: "m1",
  cacheMessageId: "00000000-0000-0000-0000-000000000001",
  fromAddress: "sarah@kim.example",
  fromIsUser: false,
  subject: "Addendum",
  receivedAt: "2026-09-01T10:00:00Z",
  bodyExcerpt: "Could you send the signed addendum back by Friday? Thanks!",
  ...o
});
const base: EmailJudgementPromptInput = {
  today: "2026-09-04",
  timezone: "America/Los_Angeles",
  messages: [msg()],
  person: null,
  noteLines: [],
  openTasks: [],
  calendar: null,
  missing: [],
  senderRuledNotObligation: false
};

describe("judgement prompt", () => {
  it("names the service key", () =>
    expect(EMAIL_JUDGEMENT_SERVICE).toBe("module.commitments.email-judgement"));
  it("carries the one question, the due-date rule, and the thread", () => {
    const p = buildEmailJudgementPrompt(base);
    expect(p).toContain("does this thread create something the user owes");
    expect(p).toContain("when the user's reply or step is owed, never the event date");
    expect(p).toContain("sarah@kim.example");
    expect(p).toContain("Today: 2026-09-04");
  });
  it("says what context it could not see", () => {
    expect(buildEmailJudgementPrompt({ ...base, missing: ["calendar"] })).toContain(
      "Calendar: unavailable"
    );
  });
  it("includes person, notes, tasks and busy slots when present", () => {
    const p = buildEmailJudgementPrompt({
      ...base,
      person: {
        personId: "p1",
        displayName: "Sarah Kim",
        relationshipSummary: "landlord",
        recentNoteLines: ["Told her Tue I'd send it this week"]
      },
      noteLines: ["Signed copy scanned Aug 30"],
      openTasks: [{ id: "t1", title: "Renew lease", dueLocalDate: "2026-09-15" }],
      calendar: {
        timezone: "America/Los_Angeles",
        busy: [{ start: "2026-09-09T16:00:00Z", end: "2026-09-09T17:00:00Z", title: "Standup" }]
      }
    });
    for (const s of [
      "Sarah Kim",
      "landlord",
      "send it this week",
      "Signed copy",
      "Renew lease",
      "Standup"
    ]) {
      expect(p).toContain(s);
    }
  });
  it("tells the model when the user ruled this sender not an obligation", () => {
    expect(buildEmailJudgementPrompt({ ...base, senderRuledNotObligation: true })).toContain(
      "ruled that mail from this sender is not something they owe"
    );
  });
});

describe("parseEmailJudgement", () => {
  it("returns null on garbage", () => {
    expect(parseEmailJudgement("nope")).toBeNull();
    expect(parseEmailJudgement({ owed: "yes" })).toBeNull();
  });
  it("accepts a well-formed owed answer and caps why and actions", () => {
    const r = parseEmailJudgement({
      owed: true,
      title: "Send Sarah the lease addendum",
      counterpartyLabel: "Sarah Kim",
      counterpartyAddress: "Sarah@Kim.Example",
      dueLocalDate: "2026-09-05",
      confidence: "high",
      why: [
        '"Could you send the signed addendum back by Friday? Thanks so much for this, I appreciate it."',
        "b",
        "c",
        "d"
      ],
      actions: [
        { kind: "reply", facts: ["x"], wantsFreeSlots: false },
        { kind: "task", title: "T", dueLocalDate: "2026-09-05" },
        { kind: "snooze", untilLocalDate: "2026-09-06" },
        { kind: "dismiss" },
        { kind: "teleport" }
      ]
    });
    expect(r?.why).toHaveLength(3);
    expect(r?.why[0]).toBe('"Could you send the signed addendum back by Friday?"');
    expect(r?.actions).toHaveLength(4);
    expect(r?.actions.map((a) => a.kind)).toEqual(["reply", "task", "snooze", "dismiss"]);
    expect(r?.counterpartyAddress).toBe("sarah@kim.example");
  });
  it("rejects a bad due date", () => {
    expect(
      parseEmailJudgement({
        owed: true,
        title: "T",
        counterpartyLabel: null,
        counterpartyAddress: null,
        dueLocalDate: "Friday",
        confidence: "low",
        why: [],
        actions: []
      })
    ).toBeNull();
  });
  it("not owed needs nothing else", () => {
    expect(parseEmailJudgement({ owed: false })).toEqual({
      owed: false,
      title: null,
      counterpartyLabel: null,
      counterpartyAddress: null,
      dueLocalDate: null,
      confidence: "low",
      why: [],
      actions: []
    });
  });
});

describe("capQuoteToOneSentence", () => {
  it("keeps the first sentence inside the quotes", () =>
    expect(capQuoteToOneSentence('"One. Two."')).toBe('"One."'));
  it("caps at 240 chars", () =>
    expect(capQuoteToOneSentence("x".repeat(300)).length).toBeLessThanOrEqual(240));
});
