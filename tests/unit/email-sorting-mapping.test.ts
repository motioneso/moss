import { describe, expect, it, vi } from "vitest";

import {
  EMAIL_SORTING_MAX_REQUEST_BYTES,
  EMAIL_SORTING_QUESTIONS,
  buildEmailSortingState,
  decideEmailCategory,
  readSortingAnswer,
  userSentLastInThread,
  type EmailSortingFacts,
  type EmailSortingQuestionId
} from "../../packages/connectors/src/email-sorting.js";
import {
  shadowSortEmail,
  storedBySortingModel,
  storedVerdictOf,
  summarizeEmailSortingComparison,
  type EmailSortingComparisonRow
} from "../../packages/connectors/src/email-sorting-comparison.js";

/**
 * #2805: the agreed email mapping. The sorting model answers six yes/no questions; code maps them
 * to a category, first match wins, and an unsure answer the decision depends on defers to the
 * general model.
 */

const YES = 0.9;
const NO = 0.1;
const UNSURE = 0.5;

const allNo: Record<EmailSortingQuestionId, number> = {
  personal_sender: NO,
  asks_reply: NO,
  asks_action: NO,
  near_deadline: NO,
  marketing: NO,
  receipt_or_notice: NO
};

const ordinary: EmailSortingFacts = { signInCode: "ordinary", userSentLast: false };

function decide(
  overrides: Partial<Record<EmailSortingQuestionId, number>>,
  facts: Partial<EmailSortingFacts> = {}
) {
  return decideEmailCategory({ ...ordinary, ...facts }, { ...allNo, ...overrides });
}

describe("readSortingAnswer", () => {
  it("treats the closed 0.35 to 0.65 band as unsure", () => {
    expect(readSortingAnswer(0.34)).toBe("no");
    expect(readSortingAnswer(0.35)).toBe("unsure");
    expect(readSortingAnswer(0.65)).toBe("unsure");
    expect(readSortingAnswer(0.66)).toBe("yes");
  });
});

describe("decideEmailCategory mapping order", () => {
  it("a sign-in code wins over everything", () => {
    expect(
      decide({ marketing: YES, asks_reply: YES }, { signInCode: "hands-over-a-code" })
    ).toEqual({ kind: "category", category: "sign_in_code" });
  });

  it("an unclear sign-in code is filtered as a sign-in code", () => {
    expect(decide({ asks_reply: YES }, { signInCode: "unclear" })).toEqual({
      kind: "category",
      category: "sign_in_code"
    });
  });

  it("marketing from a non-person is noise, even when it asks for a reply", () => {
    expect(decide({ marketing: YES, personal_sender: NO, asks_reply: YES })).toEqual({
      kind: "category",
      category: "noise"
    });
  });

  it("marketing written by a real person is not noise", () => {
    expect(decide({ marketing: YES, personal_sender: YES, asks_reply: YES })).toEqual({
      kind: "category",
      category: "needs_reply"
    });
  });

  it("needs_reply beats needs_action", () => {
    expect(decide({ asks_reply: YES, asks_action: YES })).toEqual({
      kind: "category",
      category: "needs_reply"
    });
  });

  it("needs_action beats waiting_on_someone", () => {
    expect(decide({ asks_action: YES }, { userSentLast: true })).toEqual({
      kind: "category",
      category: "needs_action"
    });
  });

  it("needs_reply and needs_action beat receipt_or_notice", () => {
    expect(decide({ receipt_or_notice: YES, asks_reply: YES })).toEqual({
      kind: "category",
      category: "needs_reply"
    });
    expect(decide({ receipt_or_notice: YES, asks_action: YES })).toEqual({
      kind: "category",
      category: "needs_action"
    });
  });

  it("marketing noise beats receipt_or_notice", () => {
    expect(decide({ marketing: YES, personal_sender: NO, receipt_or_notice: YES })).toEqual({
      kind: "category",
      category: "noise"
    });
  });

  it("receipt_or_notice beats waiting_on_someone and time_sensitive_info", () => {
    expect(decide({ receipt_or_notice: YES, near_deadline: YES }, { userSentLast: true })).toEqual({
      kind: "category",
      category: "receipt_or_notice"
    });
  });

  it("defers to the general model when the thread could not be read", () => {
    expect(decide({ near_deadline: YES }, { userSentLast: "unknown" })).toEqual({
      kind: "unsure",
      reason: "waiting_on_someone",
      questions: []
    });
  });

  it("still settles a higher category when the thread could not be read", () => {
    expect(decide({ receipt_or_notice: YES }, { userSentLast: "unknown" })).toEqual({
      kind: "category",
      category: "receipt_or_notice"
    });
  });

  it("waiting_on_someone beats time_sensitive_info", () => {
    expect(decide({ near_deadline: YES }, { userSentLast: true })).toEqual({
      kind: "category",
      category: "waiting_on_someone"
    });
  });

  it("a near deadline is time_sensitive_info", () => {
    expect(decide({ near_deadline: YES })).toEqual({
      kind: "category",
      category: "time_sensitive_info"
    });
  });

  it("everything no is fyi", () => {
    expect(decide({})).toEqual({ kind: "category", category: "fyi" });
  });
});

describe("decideEmailCategory unsure band", () => {
  it("defers when the noise step depends on an unsure marketing answer", () => {
    expect(decide({ marketing: UNSURE, personal_sender: NO })).toEqual({
      kind: "unsure",
      reason: "noise",
      questions: ["marketing"]
    });
  });

  it("defers when marketing is yes and the personal sender answer is unsure", () => {
    expect(decide({ marketing: YES, personal_sender: UNSURE })).toEqual({
      kind: "unsure",
      reason: "noise",
      questions: ["personal_sender"]
    });
  });

  it("an unsure marketing answer does not matter when a real person clearly wrote it", () => {
    expect(decide({ marketing: UNSURE, personal_sender: YES, asks_reply: YES })).toEqual({
      kind: "category",
      category: "needs_reply"
    });
  });

  it("an unsure personal sender answer does not matter when it is clearly not marketing", () => {
    expect(decide({ marketing: NO, personal_sender: UNSURE })).toEqual({
      kind: "category",
      category: "fyi"
    });
  });

  it("defers on an unsure reply answer", () => {
    expect(decide({ asks_reply: UNSURE, asks_action: YES })).toEqual({
      kind: "unsure",
      reason: "needs_reply",
      questions: ["asks_reply"]
    });
  });

  it("defers on an unsure action answer", () => {
    expect(decide({ asks_action: UNSURE })).toEqual({
      kind: "unsure",
      reason: "needs_action",
      questions: ["asks_action"]
    });
  });

  it("defers on an unsure receipt answer", () => {
    expect(decide({ receipt_or_notice: UNSURE })).toEqual({
      kind: "unsure",
      reason: "receipt_or_notice",
      questions: ["receipt_or_notice"]
    });
  });

  it("the sixth question carries the agreed wording", () => {
    expect(EMAIL_SORTING_QUESTIONS.receipt_or_notice.instructions).toBe(
      "Is this a receipt, order or booking confirmation, or an account or policy notice?"
    );
  });

  it("an unsure deadline answer does not matter once the user sent the last message", () => {
    expect(decide({ near_deadline: UNSURE }, { userSentLast: true })).toEqual({
      kind: "category",
      category: "waiting_on_someone"
    });
  });

  it("defers on an unsure deadline answer when it decides the category", () => {
    expect(decide({ near_deadline: UNSURE })).toEqual({
      kind: "unsure",
      reason: "time_sensitive_info",
      questions: ["near_deadline"]
    });
  });

  it("answers after the deciding step never cause a fallback", () => {
    expect(decide({ asks_reply: YES, asks_action: UNSURE, near_deadline: UNSURE })).toEqual({
      kind: "category",
      category: "needs_reply"
    });
  });

  it("a missing answer counts as unsure", () => {
    expect(decideEmailCategory(ordinary, { ...allNo, asks_reply: undefined })).toEqual({
      kind: "unsure",
      reason: "needs_reply",
      questions: ["asks_reply"]
    });
  });
});

describe("buildEmailSortingState", () => {
  it("keeps the whole request under the provider byte cap", () => {
    const state = buildEmailSortingState(
      { subject: "s", from: "a@b.c", receivedAt: "2026-09-28T10:00:00Z", body: "é".repeat(30_000) },
      new Date("2026-09-29T10:00:00Z")
    );
    const questions = Object.fromEntries(
      Object.entries(EMAIL_SORTING_QUESTIONS).map(([id, q]) => [id, { type: "noul", ...q }])
    );
    const request = JSON.stringify({ model: "a-model-name-of-some-length", state, questions });
    expect(Buffer.byteLength(request, "utf8")).toBeLessThanOrEqual(EMAIL_SORTING_MAX_REQUEST_BYTES);
    expect((state.body as string).length).toBeGreaterThan(1_000);
    expect(state.received).toBe("2026-09-28");
    expect(state.today).toBe("2026-09-29");
  });

  it("leaves a short body whole", () => {
    const state = buildEmailSortingState(
      { subject: "s", from: "a@b.c", receivedAt: "2026-09-28T10:00:00Z", body: "hello" },
      new Date("2026-09-29T10:00:00Z")
    );
    expect(state.body).toBe("hello");
  });
});

describe("userSentLastInThread", () => {
  const mine = new Set(["me@example.test"]);

  it("is true when the newest message is from the user", () => {
    expect(
      userSentLastInThread(
        [
          { sender: "Them <them@example.test>", receivedAt: "2026-09-01T00:00:00Z" },
          { sender: "Me <Me@Example.test>", receivedAt: "2026-09-02T00:00:00Z" }
        ],
        mine
      )
    ).toBe(true);
  });

  it("is false when someone else wrote last, whatever the array order", () => {
    expect(
      userSentLastInThread(
        [
          { sender: "them@example.test", receivedAt: "2026-09-03T00:00:00Z" },
          { sender: "me@example.test", receivedAt: "2026-09-02T00:00:00Z" }
        ],
        mine
      )
    ).toBe(false);
    expect(userSentLastInThread([], mine)).toBe(false);
  });
});

describe("shadow comparison", () => {
  it("reads the stored verdict", () => {
    expect(storedVerdictOf({ skipped: "otp" })).toBe("sign_in_code");
    expect(storedVerdictOf({ pendingJudgement: true })).toBe("pending");
    expect(storedVerdictOf({ actionability: { category: "noise" } })).toBe("noise");
    expect(storedVerdictOf({ actionability: { category: "receipt_or_notice" } })).toBe(
      "receipt_or_notice"
    );
    expect(storedVerdictOf({ confidence: 0 })).toBeNull();
    expect(storedVerdictOf(null)).toBeNull();
  });

  it("skips the request when code settles the sign-in question", async () => {
    const ask = vi.fn();
    const row = await shadowSortEmail(
      {
        id: "m1",
        subject: "Your sign-in code",
        sender: "no-reply@service.test",
        receivedAt: "2026-09-28T10:00:00Z",
        text: "Your sign-in code is 123456. It expires in 10 minutes.",
        signals: {},
        userSentLast: false
      },
      ask,
      new Date("2026-09-29T00:00:00Z")
    );
    expect(ask).not.toHaveBeenCalled();
    expect(row.shadow).toEqual({ kind: "category", category: "sign_in_code" });
  });

  it("maps the model's probabilities and records a failed request", async () => {
    const message = {
      id: "m2",
      subject: "Lunch?",
      sender: "friend@example.test",
      receivedAt: "2026-09-28T10:00:00Z",
      text: "Are you free on Friday?",
      signals: {},
      userSentLast: false
    };
    const ok = await shadowSortEmail(
      message,
      async () => ({
        ok: true,
        probabilities: { ...allNo, personal_sender: YES, asks_reply: YES }
      }),
      new Date("2026-09-29T00:00:00Z")
    );
    expect(ok.shadow).toEqual({ kind: "category", category: "needs_reply" });
    const failed = await shadowSortEmail(
      message,
      async () => ({ ok: false, error: "provider_error" }),
      new Date("2026-09-29T00:00:00Z")
    );
    expect(failed.shadow).toEqual({ kind: "failed", error: "provider_error" });
  });

  it("summarizes agreement, unsure, pending and disagreements separately", () => {
    const rows: EmailSortingComparisonRow[] = [
      {
        id: "a",
        stored: "noise",
        shadow: { kind: "category", category: "noise" },
        probabilities: null
      },
      {
        id: "b",
        stored: "fyi",
        shadow: { kind: "category", category: "noise" },
        probabilities: null
      },
      {
        id: "c",
        stored: "fyi",
        shadow: { kind: "unsure", reason: "noise", questions: ["marketing"] },
        probabilities: null
      },
      {
        id: "d",
        stored: "pending",
        shadow: { kind: "category", category: "needs_reply" },
        probabilities: null
      },
      {
        id: "e",
        stored: "fyi",
        shadow: { kind: "failed", error: "provider_error" },
        probabilities: null
      }
    ];
    const summary = summarizeEmailSortingComparison(rows);
    expect(summary.decided).toBe(2);
    expect(summary.agreed).toBe(1);
    expect(summary.agreementRate).toBe(0.5);
    expect(summary.unsure).toEqual({ noise: 1 });
    expect(summary.pending).toEqual({ needs_reply: 1 });
    expect(summary.failed).toBe(1);
    expect(summary.confusion).toEqual({ noise: { noise: 1 }, fyi: { noise: 1 } });
    expect(summary.disagreements.map((r) => r.id)).toEqual(["b"]);
    expect(summary.receiptOrNotice).toEqual({});
  });

  it("reports the receipt outcome and verdicts the sorting model already stored", () => {
    const rows: EmailSortingComparisonRow[] = [
      {
        id: "r1",
        stored: "fyi",
        shadow: { kind: "category", category: "receipt_or_notice" },
        probabilities: null
      },
      {
        id: "r2",
        stored: "pending",
        shadow: { kind: "category", category: "receipt_or_notice" },
        probabilities: null
      },
      {
        id: "r3",
        stored: "receipt_or_notice",
        shadow: { kind: "category", category: "receipt_or_notice" },
        probabilities: null,
        storedBySortingModel: true
      }
    ];
    const summary = summarizeEmailSortingComparison(rows);
    expect(summary.receiptOrNotice).toEqual({ fyi: 1, pending: 1, receipt_or_notice: 1 });
    expect(summary.storedBySortingModel).toEqual({ receipt_or_notice: 1 });
    expect(summary.confusion.receipt_or_notice).toEqual({ receipt_or_notice: 1 });
    expect(storedBySortingModel({ sortedBy: "sorting_model" })).toBe(true);
    expect(storedBySortingModel({})).toBe(false);
  });
});
