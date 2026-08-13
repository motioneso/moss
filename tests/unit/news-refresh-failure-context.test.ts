import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  brand: Symbol("DataContextDb"),
  executedDb: undefined as unknown
}));

vi.mock("@moss/db", () => ({
  assertDataContextDb: vi.fn(),
  dataContextBrand: state.brand
}));

vi.mock("kysely", () => ({
  sql: vi.fn(() => ({
    execute: vi.fn(async (db: unknown) => {
      state.executedDb = db;
      return { rows: [{ failed: true }] };
    })
  }))
}));

describe("news refresh failure recording (#1590)", () => {
  it("uses a fresh context instead of the failed job transaction", async () => {
    const { NewsPersonalizationRepository } =
      await import("../../packages/news/src/personalization-repository.js");
    const freshDb = { db: "fresh-transaction", [state.brand]: true };
    const dataContext = {
      withDataContext: async (_access: unknown, work: (db: typeof freshDb) => Promise<boolean>) =>
        work(freshDb)
    };

    await expect(
      new NewsPersonalizationRepository().failRefreshRunIfCurrent(
        dataContext as never,
        { actorUserId: "00000000-0000-4000-8000-000000000001" },
        7,
        "internal"
      )
    ).resolves.toBe(true);
    expect(state.executedDb).toBe("fresh-transaction");
  });
});
