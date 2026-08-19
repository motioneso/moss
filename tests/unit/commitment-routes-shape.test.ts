import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import {
  registerCommitmentsRoutes,
  type CommitmentsRouteDependencies
} from "@moss/commitments/routes";
import type { CommitmentCandidateStatus } from "@moss/commitments";

const actor: AccessContext = { actorUserId: "user-1", requestId: "req-1" };

function buildApp(seenStatuses: (CommitmentCandidateStatus | undefined)[]) {
  const app = Fastify();
  const repo = {
    async listCandidates(
      _scopedDb: unknown,
      _ownerUserId: string,
      status?: CommitmentCandidateStatus
    ) {
      seenStatuses.push(status);
      return [];
    }
  };
  const deps: CommitmentsRouteDependencies = {
    resolveAccessContext: async () => actor,
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    boss: {} as unknown as CommitmentsRouteDependencies["boss"],
    repository: repo as unknown as CommitmentsRouteDependencies["repository"]
  };
  registerCommitmentsRoutes(app, deps);
  return app;
}

describe("registerCommitmentsRoutes", () => {
  it("exports registration function", () => {
    expect(typeof registerCommitmentsRoutes).toBe("function");
  });

  it("rejects an unknown status value with 400 before repository work", async () => {
    const seen: (CommitmentCandidateStatus | undefined)[] = [];
    const app = buildApp(seen);
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/commitments/candidates?status=bogus"
    });
    expect(res.statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("returns 200 when status is omitted", async () => {
    const seen: (CommitmentCandidateStatus | undefined)[] = [];
    const app = buildApp(seen);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/commitments/candidates" });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([undefined]);
  });

  it.each([
    "pending_review",
    "accepted",
    "rejected",
    "snoozed",
    "expired",
    "explicit_non_action"
  ] satisfies CommitmentCandidateStatus[])(
    "passes valid status %s through to the repository unchanged",
    async (status) => {
      const seen: (CommitmentCandidateStatus | undefined)[] = [];
      const app = buildApp(seen);
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: `/api/commitments/candidates?status=${status}`
      });
      expect(res.statusCode).toBe(200);
      expect(seen).toEqual([status]);
    }
  );
});
