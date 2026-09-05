import { describe, expect, it } from "vitest";

import { CommitmentsRepository } from "../../packages/commitments/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const now = new Date("2026-09-04T10:00:00Z");
const row = {
  id: "c1",
  owner_user_id: "u1",
  candidate_signature: "s",
  kind: "obligation",
  title: "T",
  due_local_date: null,
  counterparty_label: "Sarah",
  counterparty_person_id: null,
  counterparty_address: "sarah@kim.example",
  status: "pending_review",
  confidence: "high",
  suggested_handling: null,
  resolution_ref: null,
  suppressed_by: null,
  source_count: 1,
  first_seen_at: now,
  last_seen_at: now,
  snoozed_until: null,
  expires_at: null,
  created_at: now,
  updated_at: now,
  proposed_actions: [{ kind: "dismiss" }],
  why_lines: ['"Could you send it back by Friday?"'],
  thread_ref: "t1",
  last_judged_external_id: "m2",
  stale: false
};

describe("email candidate persistence", () => {
  it("upsertEmailCandidate writes the email columns and conflicts on owner+signature", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [row] });
    const c = await new CommitmentsRepository().upsertEmailCandidate(scoped, {
      ownerUserId: "u1",
      candidateSignature: "s",
      kind: "obligation",
      title: "T",
      dueLocalDate: null,
      counterpartyLabel: "Sarah",
      counterpartyPersonId: null,
      counterpartyAddress: "sarah@kim.example",
      confidence: "high",
      suggestedHandling: null,
      proposedActions: [{ kind: "dismiss" }],
      whyLines: ['"Could you send it back by Friday?"'],
      threadRef: "t1",
      lastJudgedExternalId: "m2"
    });
    expect(queries).toHaveLength(1);
    const statement = queries[0]!.sql;
    expect(statement).toContain("proposed_actions");
    expect(statement).toContain("why_lines");
    expect(statement).toContain('on conflict ("owner_user_id", "candidate_signature")');
    // A person's rejection or "never owed" decision survives a re-judgement.
    expect(statement).toContain("'rejected'");
    expect(statement).toContain("'explicit_non_action'");
    expect(statement).toContain('"stale" = ');
    expect(queries[0]!.parameters).toEqual(expect.arrayContaining(["u1", "s", "t1", "m2"]));
    expect(c.threadRef).toBe("t1");
    expect(c.lastJudgedExternalId).toBe("m2");
    expect(c.proposedActions).toEqual([{ kind: "dismiss" }]);
    expect(c.whyLines).toEqual(['"Could you send it back by Friday?"']);
    expect(c.counterpartyAddress).toBe("sarah@kim.example");
    expect(c.stale).toBe(false);
  });

  it("recordThreadJudgement upserts on owner+thread", async () => {
    const { scoped, queries } = makeRecordingDb();
    await new CommitmentsRepository().recordThreadJudgement(scoped, "u1", "t1", "m2", "no_item");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("commitment_email_thread_judgements");
    expect(queries[0]!.sql).toContain('on conflict ("owner_user_id", "thread_ref")');
    expect(queries[0]!.parameters).toEqual(expect.arrayContaining(["u1", "t1", "m2", "no_item"]));
  });

  it("getThreadJudgement reads one owner's row and maps it", async () => {
    const { scoped, queries } = makeRecordingDb({
      rows: [{ last_judged_external_id: "m2", outcome: "item" }]
    });
    const got = await new CommitmentsRepository().getThreadJudgement(scoped, "u1", "t1");
    expect(queries[0]!.parameters).toEqual(["u1", "t1"]);
    expect(got).toEqual({ lastJudgedExternalId: "m2", outcome: "item" });
  });

  it("getThreadJudgement returns null when the thread was never judged", async () => {
    const { scoped } = makeRecordingDb();
    expect(await new CommitmentsRepository().getThreadJudgement(scoped, "u1", "t1")).toBeNull();
  });

  it("listOpenEmailCandidates keeps only open, unresolved thread candidates", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [row] });
    const list = await new CommitmentsRepository().listOpenEmailCandidates(scoped, "u1");
    const statement = queries[0]!.sql;
    expect(statement).toContain('"thread_ref" is not null');
    expect(statement).toContain('"resolution_ref" is null');
    expect(statement).toContain("nulls last");
    expect(queries[0]!.parameters).toEqual(
      expect.arrayContaining(["u1", "pending_review", "accepted", "snoozed"])
    );
    expect(queries[0]!.parameters).not.toContain("rejected");
    expect(list).toHaveLength(1);
    expect(list[0]!.threadRef).toBe("t1");
  });
});
