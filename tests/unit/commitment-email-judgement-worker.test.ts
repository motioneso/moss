import { describe, expect, it, vi } from "vitest";
import {
  judgeEmailThread,
  type EmailJudgementWorkerDeps
} from "../../packages/commitments/src/email-judgement-worker.js";
import type { EmailThreadMessage } from "@moss/module-sdk";
import type { UpsertEmailCandidateInput } from "../../packages/commitments/src/types.js";

const msg = (o: Partial<EmailThreadMessage> = {}): EmailThreadMessage => ({
  externalId: "m1",
  cacheMessageId: "00000000-0000-0000-0000-000000000001",
  fromAddress: "sarah@kim.example",
  fromIsUser: false,
  subject: "Addendum",
  receivedAt: "2026-09-01T10:00:00Z",
  bodyExcerpt: "Could you send it back by Friday?",
  ...o
});

type Deps = EmailJudgementWorkerDeps & {
  repository: {
    getThreadJudgement: ReturnType<typeof vi.fn>;
    upsertEmailCandidate: ReturnType<typeof vi.fn>;
    recordThreadJudgement: ReturnType<typeof vi.fn>;
  };
  generate: ReturnType<typeof vi.fn>;
};

function deps(over: Record<string, unknown> = {}): Deps {
  return {
    repository: {
      getThreadJudgement: vi.fn(async () => null),
      upsertEmailCandidate: vi.fn(async (_db: unknown, i: UpsertEmailCandidateInput) => ({
        id: "c1",
        ...i
      })),
      recordThreadJudgement: vi.fn(async () => {})
    },
    threads: {
      listThreadMessages: vi.fn(async () => [msg()]),
      listThreadsWithNewerMessages: vi.fn(async () => [])
    },
    context: {
      people: {
        resolveByEmail: vi.fn(async () => ({
          personId: "p1",
          displayName: "Sarah Kim",
          relationshipSummary: "landlord",
          recentNoteLines: []
        }))
      },
      notes: { searchLines: vi.fn(async () => ["Signed copy Aug 30"]) },
      tasks: { listOpen: vi.fn(async () => []) },
      calendar: { windowFromNow: vi.fn(async () => ({ timezone: "UTC", busy: [] })) }
    },
    generate: vi.fn(async () => ({
      owed: true,
      title: "Send Sarah the lease addendum",
      counterpartyLabel: "Sarah Kim",
      counterpartyAddress: "sarah@kim.example",
      dueLocalDate: "2026-09-05",
      confidence: "high",
      why: ['"Could you send it back by Friday?"'],
      actions: [
        { kind: "reply", facts: [], wantsFreeSlots: false },
        { kind: "task", title: "Send addendum", dueLocalDate: "2026-09-05" },
        { kind: "dismiss" }
      ]
    })),
    now: () => new Date("2026-09-04T12:00:00Z"),
    timezoneFor: async () => "UTC",
    ...over
  } as unknown as Deps;
}
const payload = { actorUserId: "u1", threadRef: "t1", idempotencyKey: "k" };

describe("judgeEmailThread", () => {
  it("writes one candidate with person link, actions and why", async () => {
    const d = deps();
    expect(await judgeEmailThread({}, payload, d)).toBe("item");
    const input = d.repository.upsertEmailCandidate.mock.calls[0]![1] as UpsertEmailCandidateInput;
    expect(input.threadRef).toBe("t1");
    expect(input.lastJudgedExternalId).toBe("m1");
    expect(input.counterpartyPersonId).toBe("p1");
    expect(input.proposedActions.map((a) => a.kind)).toEqual(["reply", "task", "dismiss"]);
    expect(input.whyLines).toHaveLength(1);
    expect(input.suggestedHandling).toBe("create_task");
    expect(d.repository.recordThreadJudgement).toHaveBeenCalledWith({}, "u1", "t1", "m1", "item");
  });
  it("records no_item and writes no candidate when not owed", async () => {
    const d = deps({ generate: vi.fn(async () => ({ owed: false })) });
    expect(await judgeEmailThread({}, payload, d)).toBe("no_item");
    expect(d.repository.upsertEmailCandidate).not.toHaveBeenCalled();
    expect(d.repository.recordThreadJudgement).toHaveBeenCalledWith(
      {},
      "u1",
      "t1",
      "m1",
      "no_item"
    );
  });
  it("skips when the thread was already judged at its newest message", async () => {
    const d = deps({
      repository: {
        ...deps().repository,
        getThreadJudgement: vi.fn(async () => ({ lastJudgedExternalId: "m1", outcome: "no_item" }))
      }
    });
    expect(await judgeEmailThread({}, payload, d)).toBe("skipped");
    expect(d.generate).not.toHaveBeenCalled();
  });
  it("skips when the newest message is from the user", async () => {
    const d = deps({
      threads: {
        listThreadMessages: vi.fn(async () => [
          msg(),
          msg({ externalId: "m2", fromIsUser: true, fromAddress: "ben@ben.com" })
        ]),
        listThreadsWithNewerMessages: vi.fn()
      }
    });
    expect(await judgeEmailThread({}, payload, d)).toBe("skipped");
    expect(d.generate).not.toHaveBeenCalled();
  });
  it("runs without a failing provider and tells the prompt", async () => {
    const d = deps({
      context: {
        ...deps().context,
        calendar: {
          windowFromNow: vi.fn(async () => {
            throw new Error("boom");
          })
        }
      },
      threads: {
        listThreadMessages: vi.fn(async () => [
          msg({ bodyExcerpt: "Can we schedule a call to go over it?" })
        ]),
        listThreadsWithNewerMessages: vi.fn()
      }
    });
    await judgeEmailThread({}, payload, d);
    const prompt = d.generate.mock.calls[0]![2] as string;
    expect(prompt).toContain("Calendar: unavailable");
  });
  it("treats a malformed answer as no item and logs a bounded warning", async () => {
    const warn = vi.fn();
    const d = deps({ generate: vi.fn(async () => ({ owed: "maybe" })), logger: { warn } });
    expect(await judgeEmailThread({}, payload, d)).toBe("no_item");
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("Could you send");
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("sarah@kim.example");
  });
  it("lets a model failure throw so pg-boss retries", async () => {
    const d = deps({
      generate: vi.fn(async () => {
        throw new Error("model down");
      })
    });
    await expect(judgeEmailThread({}, payload, d)).rejects.toThrow("model down");
    expect(d.repository.recordThreadJudgement).not.toHaveBeenCalled();
  });
  it("never puts message bodies in the candidate beyond the why lines", async () => {
    const d = deps();
    await judgeEmailThread({}, payload, d);
    const input = JSON.stringify(d.repository.upsertEmailCandidate.mock.calls[0]![1]);
    expect(input.match(/Could you send it back by Friday\?/g)?.length).toBe(1);
  });
  it("does not ask the model when the sender was ruled never owed", async () => {
    const d = deps({ senderRuledNotObligation: vi.fn(async () => true) });
    await judgeEmailThread({}, payload, d);
    const prompt = d.generate.mock.calls[0]![2] as string;
    expect(prompt).toContain("never");
  });
});
