import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { CommitmentsRepository } from "@moss/commitments";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let repo: CommitmentsRepository;

const userA = ids.userA;

function userAContext() {
  return { actorUserId: userA, requestId: "req:commitments-test" };
}

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
  repo = new CommitmentsRepository();
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("CommitmentsRepository", () => {
  describe("upsertCandidate", () => {
    it("creates a new candidate and returns it with correct fields", async () => {
      const sig = `test-sig-${randomUUID()}`;
      const candidate = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
        repo.upsertCandidate(scopedDb, {
          ownerUserId: userA,
          candidateSignature: sig,
          kind: "deadline",
          title: "Send the quarterly report",
          dueLocalDate: "2026-08-01",
          counterpartyLabel: "Finance team",
          confidence: "high",
          suggestedHandling: "create_task",
          occurredAt: "2026-06-28T10:00:00Z"
        })
      );

      expect(candidate.id).toBeTruthy();
      expect(candidate.ownerUserId).toBe(userA);
      expect(candidate.candidateSignature).toBe(sig);
      expect(candidate.kind).toBe("deadline");
      expect(candidate.title).toBe("Send the quarterly report");
      expect(candidate.dueLocalDate).toBe("2026-08-01");
      expect(candidate.counterpartyLabel).toBe("Finance team");
      expect(candidate.confidence).toBe("high");
      expect(candidate.status).toBe("pending_review");
      expect(candidate.sourceCount).toBe(1);
    });

    it("increments sourceCount on re-upsert of same signature", async () => {
      const sig = `test-sig-dedup-${randomUUID()}`;
      const input = {
        ownerUserId: userA,
        candidateSignature: sig,
        kind: "promise" as const,
        title: "Follow up with client",
        dueLocalDate: null,
        counterpartyLabel: null,
        confidence: "medium" as const,
        suggestedHandling: null,
        occurredAt: null
      };

      await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.upsertCandidate(scopedDb, input)
      );
      const second = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.upsertCandidate(scopedDb, input)
      );

      expect(second.sourceCount).toBe(2);
    });

    it("resolves two concurrent upserts of the same signature to one row with no 23505", async () => {
      const sig = `test-sig-concurrent-${randomUUID()}`;
      const input = {
        ownerUserId: userA,
        candidateSignature: sig,
        kind: "promise" as const,
        title: "Concurrent write test",
        dueLocalDate: null,
        counterpartyLabel: null,
        confidence: "medium" as const,
        suggestedHandling: null,
        occurredAt: null
      };

      // Forced-overlap barrier: naive Promise.all does not reliably make two
      // withDataContext transactions overlap on fast local Postgres — connection
      // acquisition + BEGIN + two SET LOCALs can let one transaction fully commit
      // before the other's first SELECT is even sent, silently missing the race
      // window the old SELECT-then-branch code was vulnerable to (see
      // mem_msxjowwt_a55597fb5cc8). Instead, each side signals "ready" only once
      // its transaction is BEGUN and its actor context is set, and both are
      // released to call upsertCandidate in the same tick, so neither side's
      // SELECT can observe the other's write.
      let resolveAReady: () => void;
      const aReady = new Promise<void>((resolve) => {
        resolveAReady = resolve;
      });
      let resolveBReady: () => void;
      const bReady = new Promise<void>((resolve) => {
        resolveBReady = resolve;
      });
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const sideA = dataContext.withDataContext(userAContext(), async (scopedDb) => {
        resolveAReady();
        await gate;
        return repo.upsertCandidate(scopedDb, input);
      });
      const sideB = dataContext.withDataContext(userAContext(), async (scopedDb) => {
        resolveBReady();
        await gate;
        return repo.upsertCandidate(scopedDb, input);
      });

      await Promise.all([aReady, bReady]);
      release!();

      const [first, second] = await Promise.all([sideA, sideB]);

      expect(first.id).toBe(second.id);

      const settled = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.getCandidate(scopedDb, userA, first.id)
      );
      expect(settled?.sourceCount).toBe(2);
    });
  });

  describe("addEvidenceRow", () => {
    it("adds evidence and enforces max 5 rows", async () => {
      const sig = `test-sig-evidence-${randomUUID()}`;
      const candidate = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.upsertCandidate(scopedDb, {
          ownerUserId: userA,
          candidateSignature: sig,
          kind: "obligation",
          title: "Review PR by EOD",
          dueLocalDate: null,
          counterpartyLabel: null,
          confidence: "low",
          suggestedHandling: null,
          occurredAt: null
        })
      );

      const results: boolean[] = [];
      for (let i = 0; i < 7; i++) {
        const added = await dataContext.withDataContext(userAContext(), (scopedDb) =>
          repo.addEvidenceRow(scopedDb, {
            candidateId: candidate.id,
            ownerUserId: userA,
            sourceKind: "chat",
            sourceRef: `msg-${randomUUID()}`,
            sourceVersion: 1,
            evidenceExcerpt: `Evidence excerpt ${i + 1}`,
            occurredAt: null
          })
        );
        results.push(added);
      }

      // First 5 succeed, rows 6+7 rejected (max enforced)
      expect(results.slice(0, 5).every(Boolean)).toBe(true);
      expect(results[5]).toBe(false);
      expect(results[6]).toBe(false);
    });
  });

  describe("listCandidates", () => {
    it("filters by status", async () => {
      const sig1 = `test-sig-list-pending-${randomUUID()}`;
      const sig2 = `test-sig-list-accepted-${randomUUID()}`;

      const pending = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.upsertCandidate(scopedDb, {
          ownerUserId: userA,
          candidateSignature: sig1,
          kind: "intent",
          title: "Draft proposal",
          dueLocalDate: null,
          counterpartyLabel: null,
          confidence: "low",
          suggestedHandling: null,
          occurredAt: null
        })
      );

      await dataContext.withDataContext(userAContext(), async (scopedDb) => {
        await repo.upsertCandidate(scopedDb, {
          ownerUserId: userA,
          candidateSignature: sig2,
          kind: "promise",
          title: "Share slides",
          dueLocalDate: null,
          counterpartyLabel: null,
          confidence: "high",
          suggestedHandling: null,
          occurredAt: null
        });
        await repo.updateStatus(scopedDb, userA, pending.id, "accepted");
      });

      const pendingList = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.listCandidates(scopedDb, userA, "pending_review")
      );
      const acceptedList = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.listCandidates(scopedDb, userA, "accepted")
      );

      const pendingIds = pendingList.map((c) => c.id);
      const acceptedIds = acceptedList.map((c) => c.id);

      expect(pendingIds).not.toContain(pending.id);
      expect(acceptedIds).toContain(pending.id);
    });
  });

  describe("upsertExtractionState + getExtractionState", () => {
    it("stores and retrieves extraction cursor", async () => {
      const before = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.getExtractionState(scopedDb, userA, "chat")
      );

      const extractedAt = new Date("2026-06-28T12:00:00Z");
      await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.upsertExtractionState(scopedDb, userA, "chat", extractedAt)
      );

      const after = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.getExtractionState(scopedDb, userA, "chat")
      );

      expect(after).not.toBeNull();
      expect(after!.sourceKind).toBe("chat");
      expect(after!.lastExtractedAt?.toISOString()).toBe(extractedAt.toISOString());

      if (before !== null) {
        expect(after!.lastExtractedAt?.getTime()).toBeGreaterThanOrEqual(
          before.lastExtractedAt?.getTime() ?? 0
        );
      }
    });

    it("updates cursor on second upsert", async () => {
      const t1 = new Date("2026-06-28T08:00:00Z");
      const t2 = new Date("2026-06-28T16:00:00Z");

      await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.upsertExtractionState(scopedDb, userA, "notes", t1)
      );
      await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.upsertExtractionState(scopedDb, userA, "notes", t2)
      );

      const state = await dataContext.withDataContext(userAContext(), (scopedDb) =>
        repo.getExtractionState(scopedDb, userA, "notes")
      );

      expect(state!.lastExtractedAt?.toISOString()).toBe(t2.toISOString());
    });
  });
});
