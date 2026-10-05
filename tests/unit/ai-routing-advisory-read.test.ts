import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import type * as dbModule from "@moss/db";
import { AiRepository } from "@moss/ai";
import type { ModuleServiceBindingMap } from "@moss/shared";

vi.mock("@moss/db", async (original) => ({
  ...(await original<typeof dbModule>()),
  withSavepoint: async <T>(_db: DataContextDb, work: () => Promise<T>) => work()
}));
afterEach(() => vi.restoreAllMocks());

function setup(bindings: ModuleServiceBindingMap) {
  // All database operations are in-memory test doubles; routing itself is real.
  const query = {
    innerJoin: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    clearOrderBy: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue([])
  };
  const ai = new AiRepository();
  vi.spyOn(ai, "listModuleServiceBindings").mockResolvedValue(bindings);
  vi.spyOn(ai, "getAdminPinnedModelId").mockResolvedValue(null);
  const providerPin = vi.spyOn(ai, "getAdminPinnedProviderId").mockResolvedValue(null);
  const recordError = vi.spyOn(ai, "recordError").mockResolvedValue(undefined);
  const db = {
    [dataContextBrand]: true,
    db: { selectFrom: vi.fn(() => query) }
  } as unknown as DataContextDb;
  return { ai, db, query, recordError, providerPin };
}

describe("advisory routing reads", () => {
  it.each([
    { "module.meetings": { kind: "model", modelId: "unavailable-model" } },
    { "module.worker": { kind: "mode", tier: "economy" } },
    {}
  ] satisfies ModuleServiceBindingMap[])(
    "avoids needs-config writes for advisory reads and preserves generation logging (case %#)",
    async (bindings) => {
      const h = setup(bindings);
      const options = {
        capability: "summarization" as const,
        rejectUnavailableFixedBinding: true as const,
        rejectUnavailablePinnedModel: true as const
      };
      const advisory = await h.ai.resolveModelForService(h.db, "module.meetings", {
        ...options,
        logNeedsConfig: false
      });
      expect(advisory.model).toBeNull();
      expect(h.recordError).not.toHaveBeenCalled();
      const generation = await h.ai.resolveModelForService(h.db, "module.meetings", options);
      expect(generation).toEqual(advisory);
      expect(h.recordError).toHaveBeenCalledOnce();
    }
  );
  it("propagates advisory logging through the admin pin path without changing routing", async () => {
    const h = setup({});
    h.providerPin.mockResolvedValue("pinned-provider");
    const capability = vi
      .spyOn(h.ai, "resolveModelForCapability")
      .mockResolvedValue({ model: null, reason: "admin-pin-unavailable" });
    await expect(
      h.ai.resolveModelForService(h.db, "module.meetings", {
        capability: "summarization",
        rejectUnavailablePinnedModel: true,
        logNeedsConfig: false
      })
    ).resolves.toEqual({ model: null, reason: "admin-pin-unavailable" });
    expect(capability).toHaveBeenCalledWith(h.db, "summarization", "economy", {
      logNeedsConfig: false
    });
  });
});
