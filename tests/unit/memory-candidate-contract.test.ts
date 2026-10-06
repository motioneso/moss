import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataContextRunner, type AccessContext, type DataContextDb } from "@moss/db";
import type { CapturedRouteSchema } from "@moss/module-sdk";

import { renderAndCap } from "../../packages/ai/src/gateway/output-validation.js";
import {
  MemoryCandidatesRepository,
  type MemoryCandidateRecord
} from "../../packages/memory/src/candidates-repository.js";
import { registerMemoryDashboardRoutes } from "../../packages/memory/src/dashboard-routes.js";
import { memoryModuleManifest } from "../../packages/memory/src/manifest.js";
import { buildRouteCatalog } from "../../packages/module-registry/src/route-catalog.js";
import { appCallActionOutputSchema } from "../../packages/settings/src/app-action-tools.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

// Real routes, validation, serialization and catalog; actor resolution and persistence are fakes.
const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const FACT_ID = "00000000-0000-4000-8000-000000000002";
const ACCEPT_PATH = "/api/memory/candidates/00000000-0000-4000-8000-000000000003/accept";
const CREATED_AT = "2026-10-06T12:00:00.000Z";
const access: AccessContext = { actorUserId: ACTOR_ID, requestId: "memory-contract" };
const apps: FastifyInstance[] = [];
const databases: DataContextDb[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(databases.splice(0).map((db) => db.db.destroy()));
  vi.restoreAllMocks();
});

function harness() {
  const app = Fastify();
  apps.push(app);
  const { scoped, queries } = makeRecordingDb();
  databases.push(scoped);
  const dataContext = new DataContextRunner(scoped.db);
  const withDataContext = vi
    .spyOn(dataContext, "withDataContext")
    .mockImplementation(
      async <T>(_access: AccessContext, work: (db: DataContextDb) => Promise<T>): Promise<T> =>
        work(scoped)
    );
  const resolveAccessContext = vi.fn(async () => access);
  const captured: CapturedRouteSchema[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      captured.push({
        method,
        url: route.url,
        body: route.schema?.body,
        querystring: route.schema?.querystring,
        params: route.schema?.params
      });
    }
  });
  registerMemoryDashboardRoutes(app, {
    dataContext,
    resolveAccessContext
  });
  return { app, scoped, queries, withDataContext, resolveAccessContext, captured };
}

function candidate(index: number): MemoryCandidateRecord {
  return {
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    ownerUserId: ACTOR_ID,
    episodeId: "00000000-0000-4000-8000-000000000004",
    kind: "fact",
    action: "create",
    payloadJson: { summary: `Suggestion ${index + 1}`, recordKind: "preference" },
    candidateSignature: `candidate-${index + 1}`,
    status: "pending",
    confidence: 0.8,
    importance: 0.5,
    provenance: index % 2 === 0 ? "volunteered" : "inferred",
    promotionReason: null,
    createdAt: new Date(CREATED_AT),
    updatedAt: new Date(CREATED_AT),
    resolvedAt: null
  };
}

describe("memory candidate HTTP contract", () => {
  it.each([
    { label: "a conflict fact ID", body: { resolveConflictWithFactId: FACT_ID } },
    { label: "a null conflict fact ID", body: { resolveConflictWithFactId: null } },
    { label: "an empty conflict fact ID", body: { resolveConflictWithFactId: "" } },
    { label: "superseded fact IDs", body: { supersedeFactIds: [FACT_ID] } },
    { label: "null superseded fact IDs", body: { supersedeFactIds: null } },
    { label: "empty superseded fact IDs", body: { supersedeFactIds: [] } }
  ])("rejects $label before actor resolution or persistence", async ({ body }) => {
    const h = harness();
    h.withDataContext.mockRejectedValue(new Error("Unexpected persistence dispatch"));

    const response = await h.app.inject({
      method: "POST",
      url: ACCEPT_PATH,
      payload: { ...body, edited: { summary: "A valid edited suggestion" } }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Accepting a suggestion adds a memory; it does not replace existing memories"
    });
    expect(h.resolveAccessContext).not.toHaveBeenCalled();
    expect(h.withDataContext).not.toHaveBeenCalled();
    expect(h.queries).toEqual([]);
  });

  it.each([
    { label: "50 of 52 pending suggestions", count: 50, total: 52, hasMore: true, remaining: 2 },
    { label: "all 50 pending suggestions", count: 50, total: 50, hasMore: false, remaining: 0 },
    { label: "an empty pending list", count: 0, total: 0, hasMore: false, remaining: 0 }
  ])(
    "serializes exact items and counts for $label",
    async ({ count, total, hasMore, remaining }) => {
      const h = harness();
      const listPending = vi
        .spyOn(MemoryCandidatesRepository.prototype, "listPendingWithCount")
        .mockResolvedValue({
          items: Array.from({ length: count }, (_, index) => candidate(index)),
          total
        });

      const response = await h.app.inject({ method: "GET", url: "/api/memory/candidates" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: Array.from({ length: count }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
          title: `Suggestion ${index + 1}`,
          summary: `Suggestion ${index + 1}`,
          recordKind: "preference",
          provenance: index % 2 === 0 ? "volunteered" : "inferred",
          createdAt: CREATED_AT
        })),
        total,
        hasMore,
        remainingCount: remaining
      });
      expect(h.withDataContext).toHaveBeenCalledExactlyOnceWith(access, expect.any(Function));
      expect(listPending).toHaveBeenCalledExactlyOnceWith(h.scoped, ACTOR_ID, 50);
      expect(h.queries).toEqual([]);
    }
  );

  it("keeps pending counts visible when long suggestions hit the app-action output cap", async () => {
    const h = harness();
    const longSummary = "A long suggested memory. ".repeat(100);
    vi.spyOn(MemoryCandidatesRepository.prototype, "listPendingWithCount").mockResolvedValue({
      items: Array.from({ length: 50 }, (_, index) => ({
        ...candidate(index),
        payloadJson: { summary: longSummary, recordKind: "preference" }
      })),
      total: 52
    });

    const response = await h.app.inject({ method: "GET", url: "/api/memory/candidates" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(50);
    expect(body.items[49].summary).toBe(longSummary);

    const { text } = renderAndCap(
      appCallActionOutputSchema,
      { data: { status: response.statusCode, body } },
      "app.callAction"
    );
    expect(text).toContain('<tool_result source="app.callAction">');
    expect(text).toContain(
      "    &quot;total&quot;: 52,\n    &quot;hasMore&quot;: true,\n    &quot;remainingCount&quot;: 2,"
    );
    expect(text).toContain("\n...[truncated tool result]\n</tool_result>");
    expect(text).not.toContain(candidate(49).id);
    expect(h.queries).toEqual([]);
  });

  it.each(["captured Fastify schema", "manifest fallback"] as const)(
    "advertises add-only acceptance in the route catalog using the %s",
    async (source) => {
      const h = harness();
      await h.app.ready();
      const catalog = buildRouteCatalog(
        [memoryModuleManifest],
        source === "captured Fastify schema" ? h.captured : []
      );
      const route = catalog.resolve("POST", ACCEPT_PATH)?.route;
      const body = route?.inputShape?.body as {
        description?: string;
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
      };

      expect(route?.moduleId).toBe("memory");
      expect(body.description).toBe(
        "Add the accepted suggestion as a new memory. Existing memories are kept."
      );
      expect(body.additionalProperties).toBe(false);
      expect(Object.keys(body.properties ?? {})).toEqual(["edited"]);
      expect(JSON.stringify(route?.inputShape)).not.toContain("resolveConflictWithFactId");
      expect(JSON.stringify(route?.inputShape)).not.toContain("supersedeFactIds");
      expect(h.withDataContext).not.toHaveBeenCalled();
    }
  );
});
