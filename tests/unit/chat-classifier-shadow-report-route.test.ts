/**
 * #2957 — `GET /api/chat/classifier/shadow-report` must run the report read through the
 * caller's actor data context, so row-level security scopes it. No database here: the route
 * is exercised on a bare Fastify instance with the shadow repository spied, proving the
 * production route calls `getReportForOwner` under the resolved actor, passes the
 * allowlisted day range (defaulting to 30), and returns the serialized report. The RLS proof
 * (another owner's rows and an admin's view never appear) lives in
 * `tests/integration/chat-classifier-shadow-report.test.ts`.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClassifierShadowRepository } from "../../packages/chat/src/classifier-shadow-repository.js";
import { registerChatRoutes } from "../../packages/chat/src/routes.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

const stubReport = {
  days: 30 as const,
  checked: 4,
  pickedTool: 2,
  agreed: 1,
  comparable: 2,
  missedTool: 1,
  disagreements: [
    {
      id: "dis-1",
      createdAt: new Date("2026-10-01T09:41:00.000Z"),
      classifierTool: "calendar.listvisibleevents",
      modelTool: "tasks.create",
      confidence: 0.8
    }
  ]
};

async function injectReport(url: string) {
  const scopedDb = { db: {} } as never;
  const withDataContext = vi.fn(async (_access: unknown, work: (db: never) => Promise<unknown>) =>
    work(scopedDb)
  );
  const getReportForOwner = vi
    .spyOn(ClassifierShadowRepository.prototype, "getReportForOwner")
    .mockResolvedValue(stubReport);

  const server = Fastify({ logger: false });
  registerChatRoutes(server, {
    rootDb: {} as never,
    dataContext: { withDataContext } as never,
    resolveAccessContext: async () => ({ actorUserId: ACTOR_ID, requestId: "req-1" })
  });

  const response = await server.inject({ method: "GET", url });
  await server.close();
  return { response, withDataContext, getReportForOwner, scopedDb };
}

describe("GET /api/chat/classifier/shadow-report (#2957)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the caller's own report under their actor context and returns it", async () => {
    const { response, withDataContext, getReportForOwner, scopedDb } = await injectReport(
      "/api/chat/classifier/shadow-report?days=7"
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      report: {
        days: 30,
        checked: 4,
        pickedTool: 2,
        agreed: 1,
        comparable: 2,
        missedTool: 1,
        disagreements: [
          {
            id: "dis-1",
            createdAt: "2026-10-01T09:41:00.000Z",
            classifierTool: "calendar.listvisibleevents",
            modelTool: "tasks.create",
            confidence: 0.8
          }
        ]
      }
    });
    expect(withDataContext).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: ACTOR_ID }),
      expect.any(Function)
    );
    expect(getReportForOwner).toHaveBeenCalledWith(scopedDb, { days: 7 });
  });

  it("defaults to 30 days when the range is missing or outside the allowlist", async () => {
    const missing = await injectReport("/api/chat/classifier/shadow-report");
    expect(missing.getReportForOwner).toHaveBeenCalledWith(missing.scopedDb, { days: 30 });

    const outside = await injectReport("/api/chat/classifier/shadow-report?days=14");
    expect(outside.getReportForOwner).toHaveBeenCalledWith(outside.scopedDb, { days: 30 });
  });
});
