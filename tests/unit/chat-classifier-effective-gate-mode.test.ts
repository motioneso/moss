import { describe, expect, it, vi } from "vitest";

import type { ClassifierDeps } from "@moss/ai";
import type { DataContextDb } from "@moss/db";

import {
  resolveEffectiveGateMode,
  type ClassifierSelection
} from "../../packages/chat/src/classifier-shadow-review-repository.js";

/**
 * #2984 R2.4 (spec 8.5) — a stored `on` runs only while the current classifier selection has a
 * shadow review. The classifier binding and the review table are fakes.
 */

const fakeDb = {} as DataContextDb;

const REVIEWED: ClassifierSelection = { modelId: "model-a", providerModelId: "provider-model-a" };

function makeDeps(selected: ClassifierSelection | null) {
  const hasReviewForSelection = vi.fn(
    async (_db: DataContextDb, selection: ClassifierSelection) =>
      selection.modelId === REVIEWED.modelId &&
      selection.providerModelId === REVIEWED.providerModelId
  );
  const classifierDeps = {
    repository: {
      resolveSortingModel: vi.fn(async () =>
        selected
          ? {
              id: selected.modelId,
              provider_config_id: "provider-config",
              provider_kind: "anthropic",
              provider_model_id: selected.providerModelId
            }
          : null
      ),
      resolveModelForService: vi.fn(),
      selectProviderWithCredential: vi.fn()
    }
  } as unknown as Pick<ClassifierDeps, "repository">;
  return { deps: { classifierDeps, hasReviewForSelection }, hasReviewForSelection };
}

describe("resolveEffectiveGateMode", () => {
  it("keeps on when the current classifier selection is reviewed", async () => {
    const { deps, hasReviewForSelection } = makeDeps(REVIEWED);
    expect(await resolveEffectiveGateMode(fakeDb, "on", deps)).toBe("on");
    expect(hasReviewForSelection).toHaveBeenCalledWith(fakeDb, REVIEWED);
  });

  it("drops on to shadow when the classifier selection changed since the review", async () => {
    const changedModel = makeDeps({ ...REVIEWED, modelId: "model-b" });
    expect(await resolveEffectiveGateMode(fakeDb, "on", changedModel.deps)).toBe("shadow");

    const changedProviderModel = makeDeps({ ...REVIEWED, providerModelId: "provider-model-b" });
    expect(await resolveEffectiveGateMode(fakeDb, "on", changedProviderModel.deps)).toBe("shadow");
  });

  it("drops on to shadow when no classifier is selected", async () => {
    const { deps, hasReviewForSelection } = makeDeps(null);
    expect(await resolveEffectiveGateMode(fakeDb, "on", deps)).toBe("shadow");
    expect(hasReviewForSelection).not.toHaveBeenCalled();
  });

  it("passes shadow and off through without reading the review", async () => {
    const { deps, hasReviewForSelection } = makeDeps(null);
    expect(await resolveEffectiveGateMode(fakeDb, "shadow", deps)).toBe("shadow");
    expect(await resolveEffectiveGateMode(fakeDb, "off", deps)).toBe("off");
    expect(hasReviewForSelection).not.toHaveBeenCalled();
  });
});
