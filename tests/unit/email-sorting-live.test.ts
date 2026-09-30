import { describe, expect, it, vi } from "vitest";

import type { ParsedEmail } from "../../packages/connectors/src/email-extract.js";
import {
  EMAIL_SORTING_QUESTION_IDS,
  type EmailSortingAsk,
  type EmailSortingQuestionId
} from "../../packages/connectors/src/email-sorting.js";
import {
  runSortingModelPass,
  sortEmailOnSortingModel,
  sortingSession,
  type EmailSortingService
} from "../../packages/connectors/src/email-sorting-live.js";

/** #2805: sync sorts email on the sorting model first and falls back to the general model. */

const YES = 0.9;
const NO = 0.1;
const UNSURE = 0.5;
const NOW = new Date("2026-09-29T10:00:00Z");

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    externalId: "msg-1",
    threadId: "thread-1",
    historyId: "history-1",
    subject: "Your order is confirmed",
    from: "Shop <orders@shop.example.invalid>",
    recipients: ["me@example.invalid"],
    receivedAt: "2026-09-28T12:00:00.000Z",
    labelIds: ["INBOX"],
    snippet: "Thanks for your order",
    body: "Thanks for your order. Order number 1234 ships tomorrow.",
    bodyTruncated: false,
    ...overrides
  };
}

function answers(overrides: Partial<Record<EmailSortingQuestionId, number>>): EmailSortingAsk {
  const all = Object.fromEntries(EMAIL_SORTING_QUESTION_IDS.map((id) => [id, NO]));
  return async () => ({ ok: true, probabilities: { ...all, ...overrides } });
}

function sort(ask: EmailSortingAsk, parsed = email(), userSentLast = false) {
  return sortEmailOnSortingModel({ parsed, userSentLast, knownSender: false, now: NOW }, ask);
}

describe("sortEmailOnSortingModel", () => {
  it("stores a receipt as receipt_or_notice with a preview summary and no gate", async () => {
    const outcome = await sort(answers({ receipt_or_notice: YES }));
    expect(outcome.kind).toBe("sorted");
    if (outcome.kind !== "sorted") return;
    expect(outcome.category).toBe("receipt_or_notice");
    expect(outcome.result.gate).toBeUndefined();
    expect(outcome.result.summary).not.toBeNull();
    expect(outcome.result.signals.actionability?.category).toBe("receipt_or_notice");
    expect(outcome.result.signals.sortedBy).toBe("sorting_model");
  });

  it("hands a message that asks for a reply to the thread judgement", async () => {
    const outcome = await sort(answers({ asks_reply: YES, receipt_or_notice: YES }));
    expect(outcome.kind).toBe("sorted");
    if (outcome.kind !== "sorted") return;
    expect(outcome.category).toBe("needs_reply");
    expect(outcome.result.gate).toBe("maybe_owed");
    expect(outcome.result.signals.pendingJudgement).toBe(true);
    expect(outcome.result.signals.actionability).toBeUndefined();
  });

  it("stores marketing as noise with no summary", async () => {
    const outcome = await sort(answers({ marketing: YES }));
    if (outcome.kind !== "sorted") throw new Error("expected sorted");
    expect(outcome.result).toMatchObject({
      summary: null,
      gate: "nothing",
      signals: { actionability: { category: "noise" }, sortedBy: "sorting_model" }
    });
  });

  it("stores plain mail as fyi on the worth-knowing gate", async () => {
    const outcome = await sort(answers({}));
    if (outcome.kind !== "sorted") throw new Error("expected sorted");
    expect(outcome.category).toBe("fyi");
    expect(outcome.result.gate).toBe("worth_knowing");
  });

  it("filters an unclear sign-in code without asking the sorting model", async () => {
    const ask = vi.fn(answers({ asks_reply: YES }));
    const outcome = await sort(
      ask,
      email({
        subject: "Your verification code",
        body: "Use the code in the app to finish signing in.",
        snippet: null
      })
    );
    expect(ask).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "sorted",
      category: "sign_in_code",
      result: { signals: { skipped: "otp" } }
    });
  });

  it("sends an unsure answer the decision depends on to the general model", async () => {
    expect(await sort(answers({ receipt_or_notice: UNSURE }))).toEqual({
      kind: "general",
      reason: "unsure"
    });
  });

  it("falls back to the general model when the sorting model fails", async () => {
    expect(await sort(async () => ({ ok: false, error: "provider_error" }))).toEqual({
      kind: "general",
      reason: "failed"
    });
  });

  it("falls back to the general model when the sorting model throws", async () => {
    expect(
      await sort(async () => {
        throw new Error("boom");
      })
    ).toEqual({ kind: "general", reason: "failed" });
  });

  it("gives up on a stalled sorting model within the budget and aborts the request", async () => {
    let received: AbortSignal | undefined;
    const stalled: EmailSortingAsk = (_state, _questions, signal) => {
      received = signal;
      return new Promise(() => undefined);
    };
    const outcome = await sortEmailOnSortingModel(
      { parsed: email(), userSentLast: false, knownSender: false, now: NOW, timeoutMs: 20 },
      stalled
    );
    expect(outcome).toEqual({ kind: "general", reason: "failed" });
    expect(received?.aborted).toBe(true);
  });

  it("reads no bound sorting model as not configured", async () => {
    expect(await sort(async () => ({ ok: false, error: "not_supported" }))).toEqual({
      kind: "general",
      reason: "not_configured"
    });
  });
});

const passThrough = <T>(work: () => Promise<T>) => work();

function pass(
  sorting: EmailSortingService | undefined,
  pending: ParsedEmail[],
  userSentLast: (parsed: ParsedEmail) => Promise<boolean | "unknown"> = async () => false
) {
  return runSortingModelPass({
    pending,
    sorting,
    userSentLast,
    knownSender: () => false,
    now: () => NOW,
    guard: passThrough
  });
}

describe("runSortingModelPass", () => {
  const two = [email({ externalId: "a" }), email({ externalId: "b" })];

  it("sends everything to the general model when no sorting model is set", async () => {
    const ask = vi.fn(answers({}));
    const result = await pass({ available: async () => false, ask }, two);
    expect(ask).not.toHaveBeenCalled();
    expect(result.general.map((m) => m.externalId)).toEqual(["a", "b"]);
    expect(result.counts.general).toEqual({ not_configured: 2 });
  });

  it("sends everything to the general model when the settings read fails", async () => {
    const result = await pass(
      {
        available: async () => {
          throw new Error("db down");
        },
        ask: answers({})
      },
      two
    );
    expect(result.sorted).toEqual([]);
    expect(result.general).toHaveLength(2);
  });

  it("sends everything to the general model when there is no sorting service", async () => {
    const result = await pass(undefined, two);
    expect(result.general).toHaveLength(2);
  });

  it("sorts what the sorting model settles and leaves a failed message for the general model", async () => {
    const ask = vi
      .fn<EmailSortingAsk>()
      .mockImplementationOnce(answers({ receipt_or_notice: YES }))
      .mockResolvedValueOnce({ ok: false, error: "provider_error" });
    const result = await pass({ available: async () => true, ask }, two);
    expect(result.sorted.map((s) => s.parsed.externalId)).toEqual(["a"]);
    expect(result.general.map((m) => m.externalId)).toEqual(["b"]);
    expect(result.counts).toEqual({
      sorted: { receipt_or_notice: 1 },
      general: { failed: 1 }
    });
  });

  it("stops asking for the rest of the pass once the sorting model reports it is not set up", async () => {
    const ask = vi.fn<EmailSortingAsk>(async () => ({ ok: false, error: "needs_config" }));
    const result = await pass({ available: async () => true, ask }, two);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.counts.general).toEqual({ not_configured: 2 });
  });

  it("defers to the general model when the thread read fails", async () => {
    const result = await pass({ available: async () => true, ask: answers({}) }, two, async () => {
      throw new Error("db down");
    });
    expect(result.sorted).toEqual([]);
    expect(result.counts.general).toEqual({ unsure: 2 });
  });
});

describe("sortingSession", () => {
  it("reads the settings once across passes", async () => {
    const available = vi.fn(async () => true);
    const session = sortingSession({ available, ask: answers({}) });
    await pass(session, [email({ externalId: "a" })]);
    await pass(session, [email({ externalId: "b" })]);
    expect(available).toHaveBeenCalledTimes(1);
  });

  it("stops asking in later passes once the sorting model reports it is not set up", async () => {
    const ask = vi.fn<EmailSortingAsk>(async () => ({ ok: false, error: "not_supported" }));
    const session = sortingSession({ available: async () => true, ask });
    await pass(session, [email({ externalId: "a" })]);
    const second = await pass(session, [email({ externalId: "b" })]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(second.counts.general).toEqual({ not_configured: 1 });
  });

  it("keeps asking after an ordinary failure", async () => {
    const ask = vi.fn<EmailSortingAsk>(async () => ({ ok: false, error: "provider_error" }));
    const session = sortingSession({ available: async () => true, ask });
    await pass(session, [email({ externalId: "a" })]);
    await pass(session, [email({ externalId: "b" })]);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("passes no service through as none", () => {
    expect(sortingSession(undefined)).toBeUndefined();
  });
});
