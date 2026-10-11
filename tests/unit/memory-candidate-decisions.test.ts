import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataContextRunner, type AccessContext, type DataContextDb } from "@moss/db";

import { MemoryCandidatesRepository } from "../../packages/memory/src/candidates-repository.js";
import { registerMemoryDashboardRoutes } from "../../packages/memory/src/dashboard-routes.js";
import * as embeddingConfig from "../../packages/memory/src/embedding-provider-config.js";
import { makeRecordingDb, type RecordedQuery } from "./helpers/recording-db.js";

// Real query compilation, repository, service and Fastify routes; database results and actor
// resolution are fakes. These tests do not establish Postgres locking, rollback or RLS behavior.
const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000002";
const access: AccessContext = { actorUserId: ACTOR_ID, requestId: "candidate-decisions" };
const databases: DataContextDb[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(databases.splice(0).map((db) => db.db.destroy()));
  vi.restoreAllMocks();
});

function recordingDb(updated: boolean) {
  const db = makeRecordingDb({ rows: updated ? [{ id: CANDIDATE_ID }] : [] });
  databases.push(db.scoped);
  return db;
}

function expectPendingDecision(queries: RecordedQuery[], status: string, reason: string) {
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql.replace(/\s+/g, " ").trim()).toBe(
    "UPDATE app.memory_candidates SET status = $1, promotion_reason = $2, " +
      "resolved_at = now(), updated_at = now() " +
      "WHERE owner_user_id = $3::uuid AND id = $4::uuid AND status = 'pending' RETURNING id"
  );
  expect(queries[0]!.parameters).toEqual([status, reason, ACTOR_ID, CANDIDATE_ID]);
}

describe("pending-only memory candidate decision queries", () => {
  it.each([
    ["markPromoted", "promoted"],
    ["markRejected", "rejected"],
    ["markSuppressed", "suppressed"]
  ] as const)("%s scopes its update to the owner's pending candidate", async (method, status) => {
    const { scoped, queries } = recordingDb(true);
    const result = await new MemoryCandidatesRepository()[method](
      scoped,
      ACTOR_ID,
      CANDIDATE_ID,
      "original decision"
    );

    expect(result).toBe(true);
    expectPendingDecision(queries, status, "original decision");
  });

  it.each(["markPromoted", "markRejected", "markSuppressed"] as const)(
    "%s returns false when the conditional update returns no row",
    async (method) => {
      const { scoped, queries } = recordingDb(false);
      const result = await new MemoryCandidatesRepository()[method](
        scoped,
        ACTOR_ID,
        CANDIDATE_ID,
        "stale decision"
      );

      expect(result).toBe(false);
      expect(queries).toHaveLength(1);
    }
  );
});

describe("pending-only memory candidate decision HTTP responses", () => {
  it.each([
    ["reject", "rejected", true],
    ["reject", "rejected", false],
    ["suppress", "suppressed", true],
    ["suppress", "suppressed", false]
  ] as const)(
    "%s reports its %s decision as successful only when updated: %s",
    async (action, status, updated) => {
      const { scoped, queries } = recordingDb(updated);
      const dataContext = new DataContextRunner(scoped.db);
      const withDataContext = vi
        .spyOn(dataContext, "withDataContext")
        .mockImplementation(
          async <T>(_access: AccessContext, work: (db: DataContextDb) => Promise<T>): Promise<T> =>
            work(scoped)
        );
      vi.spyOn(embeddingConfig, "getEmbeddingProviderConfig").mockResolvedValue({ kind: "stub" });
      const app = Fastify();
      apps.push(app);
      registerMemoryDashboardRoutes(app, {
        dataContext,
        resolveAccessContext: async () => access
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/memory/candidates/${CANDIDATE_ID}/${action}`,
        payload: { reason: "requested decision" }
      });

      expect(response.statusCode).toBe(updated ? 204 : 404);
      if (updated) {
        expect(response.body).toBe("");
      } else {
        expect(response.json()).toEqual({ error: "Candidate not found or not pending" });
      }
      expect(withDataContext).toHaveBeenCalledExactlyOnceWith(access, expect.any(Function));
      expectPendingDecision(queries, status, "requested decision");
    }
  );
});
