import { describe, expect, it } from "vitest";
import type {
  EmailJudgementOutcome,
  EmailThreadJudgementRequester,
  ProposedCommitmentAction
} from "../../packages/module-sdk/src/index.js";

describe("email judgement contracts", () => {
  it("compile and are shaped as the spec says", () => {
    const action: ProposedCommitmentAction = {
      kind: "task",
      title: "Send addendum",
      dueLocalDate: "2026-09-05"
    };
    const outcome: EmailJudgementOutcome = {
      owed: true,
      title: "Send Sarah the lease addendum",
      counterpartyLabel: "Sarah Kim",
      counterpartyAddress: "sarah@kim.example",
      dueLocalDate: "2026-09-05",
      confidence: "high",
      why: ['"Could you send the signed addendum back by Friday?"'],
      actions: [action, { kind: "dismiss" }]
    };
    const requester: EmailThreadJudgementRequester = {
      requestThreadJudgement: async () => {}
    };
    expect(outcome.actions).toHaveLength(2);
    expect(typeof requester.requestThreadJudgement).toBe("function");
  });
});
