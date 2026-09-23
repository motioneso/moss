import { describe, expect, it } from "vitest";

import { aiModuleManifest } from "../../packages/ai/src/manifest.js";
import { CORE_APP_SETTINGS } from "../../packages/shared/src/app-map-core.js";

describe("app map: sorting model (#2594)", () => {
  const feature = (aiModuleManifest.features ?? []).find(
    (entry) => entry.id === "ai.sorting_model"
  );

  it("declares the sorting model feature with its error and remediation", () => {
    expect(feature?.description).toMatch(/Sorting model/);
    expect(feature?.remediations).toEqual([
      {
        id: "ai.sorting_model.use_main_model",
        description:
          "Moss tries your main model instead when it can. To stop trying the sorting model, choose Use main model.",
        path: "/settings?section=aiproviders"
      }
    ]);
    expect(feature?.errors).toEqual([
      expect.objectContaining({
        code: "ai.sorting_model.not_answering",
        class: "transient"
      })
    ]);
    expect(feature?.errors?.[0]?.description).toMatch(/sorting model not answering/);
  });

  it("describes the row on the Assistant & AI settings page", () => {
    const page = CORE_APP_SETTINGS.find((entry) => entry.id === "aiproviders");
    expect(page?.description).toMatch(/Sorting model/);
    expect(page?.description).toMatch(/Use main model/);
  });
});
