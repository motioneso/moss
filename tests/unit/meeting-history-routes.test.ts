import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataContextDb, AccessContext } from "@moss/db";
import { registerMeetingHistoryRoutes } from "@moss/meetings";
import { MeetingHistoryInputError } from "../../packages/meetings/src/history-repository.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
function setup() {
  const logs: string[] = [];
  const server = Fastify({ logger: { stream: { write: (value: string) => logs.push(value) } } });
  servers.push(server);
  const db = {} as DataContextDb;
  const auth = vi.fn(async () => ({ actorUserId: id }));
  const historyRepository = {
    search: vi.fn().mockResolvedValue({ meetings: [], nextCursor: null }),
    get: vi.fn().mockResolvedValue(null)
  };
  registerMeetingHistoryRoutes(server, {
    resolveAccessContext: auth,
    dataContext: {
      withDataContext: async <T>(
        _actor: AccessContext,
        work: (value: DataContextDb) => Promise<T>
      ) => work(db)
    },
    historyRepository
  });
  return { server, logs, auth, historyRepository, db };
}
describe("owner-authenticated history reads", () => {
  it("carries search only in POST body, uses the actor transaction and prevents caching", async () => {
    const { server, historyRepository, db, logs } = setup();
    const query = "confidential-search-marker";
    const response = await server.inject({
      method: "POST",
      url: "/api/meetings/history/search",
      payload: { query, filter: "transcript" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(historyRepository.search).toHaveBeenCalledWith(db, { query, filter: "transcript" });
    expect(logs.join("")).not.toContain(query);
  });
  it.each([
    { query: "x".repeat(257) },
    { query: "\0" },
    { query: 1 },
    { before: { id } },
    { before: { id, createdAt: "2026-10-04T00:00:00.000Z", private: "private-validation-marker" } },
    { "private-validation-marker": true }
  ])("rejects invalid schema without logging submitted names or values", async (payload) => {
    const { server, historyRepository, logs } = setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/meetings/history/search",
      payload
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "meeting_history_invalid_input" });
    expect(historyRepository.search).not.toHaveBeenCalled();
    expect(logs.join("")).not.toContain("private-validation-marker");
  });
  it("scrubs driver errors before generic logging while mapping timeout to a retryable error", async () => {
    const { server, historyRepository, logs } = setup();
    const marker = "private-error-query-marker";
    historyRepository.search.mockRejectedValue(
      Object.assign(new Error(marker), { detail: marker, code: "57014" })
    );
    const response = await server.inject({
      method: "POST",
      url: "/api/meetings/history/search",
      payload: { query: marker }
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(marker);
    expect(logs.join("")).not.toContain(marker);
  });
  it("keeps auth failures distinct from absent/inaccessible selected metadata", async () => {
    const { server, auth, historyRepository } = setup();
    const absent = await server.inject(`/api/meetings/history/${id}`);
    expect(absent.statusCode).toBe(404);
    expect(historyRepository.get).toHaveBeenCalledTimes(1);
    auth.mockRejectedValue(new Error("Session is missing or expired"));
    expect((await server.inject(`/api/meetings/history/${id}`)).statusCode).toBe(401);
    expect(historyRepository.get).toHaveBeenCalledTimes(1);
  });
  it("maps normalization term-limit errors without echoing the query", async () => {
    const { server, historyRepository } = setup();
    historyRepository.search.mockRejectedValue(new MeetingHistoryInputError());
    expect(
      (await server.inject({ method: "POST", url: "/api/meetings/history/search", payload: {} }))
        .statusCode
    ).toBe(400);
  });
  it.each([401, 403, 429])(
    "preserves safe hook status %i without echoing hook details",
    async (statusCode) => {
      const { server, logs, historyRepository } = setup();
      server.addHook("onRequest", async () => {
        throw Object.assign(new Error("private-hook-marker"), { statusCode });
      });
      const response = await server.inject({
        method: "POST",
        url: "/api/meetings/history/search",
        payload: {}
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.body).not.toContain("private-hook-marker");
      expect(logs.join("")).not.toContain("private-hook-marker");
      expect(historyRepository.search).not.toHaveBeenCalled();
    }
  );
});
