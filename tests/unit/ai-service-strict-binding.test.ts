import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import { AiRepository, type AiConfiguredModelSafeRow } from "@moss/ai";
import type { ModuleServiceBindingMap } from "@moss/shared";

const model = { id: "bound-model" } as AiConfiguredModelSafeRow;
const strict = {
  capability: "summarization" as const,
  rejectUnavailableFixedBinding: true as const,
  rejectUnavailablePinnedModel: true as const
};
function setup(
  bindings: ModuleServiceBindingMap,
  selected: AiConfiguredModelSafeRow | undefined = model
) {
  const where = vi.fn();
  const query = {
    innerJoin: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    clearOrderBy: vi.fn().mockReturnThis(),
    where: where.mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue(selected)
  };
  const selectFrom = vi.fn((table: string) => {
    if (table !== "app.ai_configured_models as models")
      throw new Error("Unexpected fallback query");
    return query;
  });
  const db = { [dataContextBrand]: true, db: { selectFrom } } as unknown as DataContextDb;
  const ai = new AiRepository();
  vi.spyOn(ai, "listModuleServiceBindings").mockResolvedValue(bindings);
  const modelPin = vi.spyOn(ai, "getAdminPinnedModelId").mockResolvedValue(null);
  const providerPin = vi.spyOn(ai, "getAdminPinnedProviderId").mockResolvedValue(null);
  const defaultProvider = vi
    .spyOn(ai, "resolveDefaultProviderId")
    .mockResolvedValue("default-provider");
  const capability = vi
    .spyOn(ai, "resolveModelForCapability")
    .mockResolvedValue({ model: { ...model, id: "pinned-model" }, reason: "admin-pin" });
  return { ai, db, where, selectFrom, modelPin, providerPin, capability, defaultProvider, query };
}
afterEach(() => vi.restoreAllMocks());

describe("service routing with unavailable fixed-binding rejection", () => {
  it("honors the Meetings binding ahead of the generic worker binding", async () => {
    const h = setup({
      "module.meetings": { kind: "model", modelId: "bound-model" },
      "module.worker": { kind: "model", modelId: "worker-model" }
    });
    expect(await h.ai.resolveModelForService(h.db, "module.meetings", strict)).toEqual({
      model,
      reason: "manual-route"
    });
    expect(h.where).toHaveBeenCalledWith("models.id", "=", "bound-model");
    expect(h.where).not.toHaveBeenCalledWith("models.id", "=", "worker-model");
    expect(h.capability).not.toHaveBeenCalled();
  });
  it("honors a generic worker fixed binding when Meetings has no binding", async () => {
    const h = setup({ "module.worker": { kind: "model", modelId: "worker-model" } });
    expect((await h.ai.resolveModelForService(h.db, "module.meetings", strict)).model).toBe(model);
    expect(h.where).toHaveBeenCalledWith("models.id", "=", "worker-model");
    expect(h.capability).not.toHaveBeenCalled();
  });
  it("honors the configured worker mode tier", async () => {
    const h = setup({ "module.worker": { kind: "mode", tier: "reasoning" } });
    expect(await h.ai.resolveModelForService(h.db, "module.meetings", strict)).toEqual({
      model,
      reason: "matched-active-model"
    });
    expect(h.where).toHaveBeenCalledWith("models.tier", "=", "reasoning");
  });
  it.each(["model", "provider"])(
    "keeps hard %s pin precedence over fixed bindings",
    async (kind) => {
      const h = setup({ "module.meetings": { kind: "model", modelId: "broken-binding" } });
      if (kind === "model") h.modelPin.mockResolvedValue("pinned-model");
      else h.providerPin.mockResolvedValue("pinned-provider");
      expect((await h.ai.resolveModelForService(h.db, "module.meetings", strict)).model?.id).toBe(
        "pinned-model"
      );
      expect(h.capability).toHaveBeenCalledExactlyOnceWith(h.db, "summarization", "economy");
      expect(h.selectFrom).not.toHaveBeenCalled();
    }
  );
  it.each(["same-provider-replacement", null])(
    "rejects unavailable exact model pins (%s)",
    async (replacementId) => {
      const h = setup({ "module.meetings": { kind: "model", modelId: "bound-model" } });
      h.modelPin.mockResolvedValue("pinned-model");
      h.capability.mockResolvedValue({
        model: replacementId ? { ...model, id: replacementId } : null,
        reason: "admin-pin"
      });
      expect(await h.ai.resolveModelForService(h.db, "module.meetings", strict)).toEqual({
        model: null,
        reason: "admin-pin-unavailable"
      });
      expect(h.selectFrom).not.toHaveBeenCalled();
      expect(h.defaultProvider).not.toHaveBeenCalled();
    }
  );
  it("preserves legacy same-provider model-pin substitution without strict exact-pin checking", async () => {
    const h = setup({});
    h.modelPin.mockResolvedValue("pinned-model");
    const replacement = { ...model, id: "same-provider-replacement" };
    h.capability.mockResolvedValue({ model: replacement, reason: "admin-pin" });
    expect(
      await h.ai.resolveModelForService(h.db, "module.meetings", {
        capability: "summarization",
        rejectUnavailableFixedBinding: true
      })
    ).toEqual({ model: replacement, reason: "admin-pin" });
  });
  it("allows capability-based model selection under a provider-only pin even in strict mode", async () => {
    const h = setup({});
    h.providerPin.mockResolvedValue("pinned-provider");
    const selected = { ...model, id: "capable-model-in-pinned-provider" };
    h.capability.mockResolvedValue({ model: selected, reason: "admin-pin" });
    expect(await h.ai.resolveModelForService(h.db, "module.meetings", strict)).toEqual({
      model: selected,
      reason: "admin-pin"
    });
  });
  it.each(["module.meetings", "module.worker"] as const)(
    "fails closed on unavailable %s fixed binding without default-provider fallback",
    async (service) => {
      const h = setup({ [service]: { kind: "model", modelId: "missing-or-incapable" } });
      // A binding can remain after model deletion, disablement, or capability removal.
      // The real resolver's filtered model query returns no row in each case.
      const query = h.selectFrom("app.ai_configured_models as models");
      query.executeTakeFirst.mockResolvedValue(undefined);
      h.selectFrom.mockClear();
      expect(await h.ai.resolveModelForService(h.db, "module.meetings", strict)).toEqual({
        model: null,
        reason: "needs-config"
      });
      expect(h.selectFrom).toHaveBeenCalledExactlyOnceWith("app.ai_configured_models as models");
      expect(h.capability).not.toHaveBeenCalled();
      expect(h.defaultProvider).not.toHaveBeenCalled();
    }
  );
  it("keeps legacy fixed-binding fallback unchanged when strict rejection is omitted", async () => {
    const h = setup({ "module.meetings": { kind: "model", modelId: "removed-model" } });
    h.query.executeTakeFirst.mockResolvedValueOnce(undefined).mockResolvedValue(model);
    expect(
      await h.ai.resolveModelForService(h.db, "module.meetings", { capability: "summarization" })
    ).toEqual({ model, reason: "matched-active-model" });
    expect(h.defaultProvider).toHaveBeenCalledExactlyOnceWith(h.db);
    expect(h.where).toHaveBeenCalledWith("providers.id", "=", "default-provider");
  });
  it("uses normal capability routing only when no module binding or pin exists", async () => {
    const h = setup({});
    await h.ai.resolveModelForService(h.db, "module.meetings", strict);
    expect(h.capability).toHaveBeenCalledExactlyOnceWith(h.db, "summarization", "economy");
  });
});
