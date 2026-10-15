import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb, type DataContextRunner } from "@moss/db";
import type { EmbeddingProvider } from "@moss/memory";
import type { PreferencesRepository } from "@moss/structured-state";
import { registerNotesSyncRoutes } from "../../packages/notes/src/notes-sync-routes.js";

const access = { actorUserId: "00000000-0000-4000-8000-000000000001", requestId: "sync" };

function harness(source: string | null = "/notes") {
  const server = Fastify({ logger: false });
  let openContexts = 0;
  const scopedDb = { [dataContextBrand]: true } as DataContextDb;
  const dataContext = {
    async withDataContext<T>(_access: typeof access, run: (db: DataContextDb) => Promise<T>) {
      openContexts++;
      try {
        return await run(scopedDb);
      } finally {
        openContexts--;
      }
    }
  } as DataContextRunner;
  const embedQuery = vi.fn(async (_query: string) => [1]);
  const embeddingProviderFactory = vi.fn(async (db: DataContextDb) => {
    expect(db).toBe(scopedDb);
    return {
      dimensions: 1,
      modelName: "test",
      modelVersion: "test",
      embedDocument: embedQuery,
      embedQuery: (query: string) => {
        expect(openContexts, "model loading must not hold an actor transaction open").toBe(0);
        return embedQuery(query);
      }
    } satisfies EmbeddingProvider;
  });
  const send = vi.fn(async () => "job-id");
  const warn = vi.spyOn(server.log, "warn");
  registerNotesSyncRoutes(server, {
    dataContext,
    resolveAccessContext: async () => access,
    preferencesRepository: { get: vi.fn(async () => source) } as unknown as PreferencesRepository,
    boss: { send } as unknown as PgBoss,
    embeddingProviderFactory
  });
  return { server, embedQuery, embeddingProviderFactory, send, warn };
}

describe("notes sync prepares automatic recall", () => {
  it("starts model preparation without awaiting inference or holding its transaction", async () => {
    const h = harness();
    let finish!: (embedding: number[]) => void;
    h.embedQuery.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    try {
      const response = await h.server.inject({ method: "POST", url: "/api/notes/sync" });
      expect(response.statusCode).toBe(202);
      await vi.waitFor(() => expect(h.embedQuery).toHaveBeenCalledWith(""));
      expect(h.embeddingProviderFactory).toHaveBeenCalledOnce();
      expect(h.send).toHaveBeenCalledWith(
        "notes.sync",
        { actorUserId: access.actorUserId, sourcePath: "/notes" },
        { singletonKey: `notes-sync:${access.actorUserId}` }
      );
    } finally {
      finish?.([1]);
      await h.server.close();
    }
  });

  it("contains preparation failures and retries on a later sync without logging the error", async () => {
    const h = harness();
    h.embedQuery.mockRejectedValueOnce(new Error("private-provider-detail"));
    try {
      expect((await h.server.inject({ method: "POST", url: "/api/notes/sync" })).statusCode).toBe(
        202
      );
      await vi.waitFor(() => expect(h.warn).toHaveBeenCalled());
      expect(JSON.stringify(h.warn.mock.calls)).not.toContain("private-provider-detail");
      expect((await h.server.inject({ method: "POST", url: "/api/notes/sync" })).statusCode).toBe(
        202
      );
      await vi.waitFor(() => expect(h.embedQuery).toHaveBeenCalledTimes(2));
    } finally {
      await h.server.close();
    }
  });

  it("does not prepare a model when the owner has no notes source", async () => {
    const h = harness(null);
    try {
      expect((await h.server.inject({ method: "POST", url: "/api/notes/sync" })).statusCode).toBe(
        409
      );
      expect(h.embeddingProviderFactory).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      await h.server.close();
    }
  });
});
