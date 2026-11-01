import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  detectStep,
  TAGGED_FAMILIES,
  tiersForStep,
  type Tier
} from "../../external-modules/finance/src/web/settings-api.js";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../external-modules/finance/jarvis.module.json", import.meta.url),
    "utf8"
  )
) as {
  assistantActionFamilies: { id: string; freedom?: string; defaultTier: Tier }[];
};

describe("Finance settings presets mirror the manifest", () => {
  it("tags each family the same way as the manifest", () => {
    const routine = tiersForStep("routine");
    for (const id of TAGGED_FAMILIES) {
      const family = manifest.assistantActionFamilies.find((entry) => entry.id === id);
      expect(family?.freedom, id).toBeDefined();
      expect(routine[id], id).toBe(
        family!.freedom === "routine" ? "trusted_auto" : "ask_each_time"
      );
    }
  });

  it("shows a fresh install as Handle routine, ask about new", () => {
    const defaults = Object.fromEntries(
      TAGGED_FAMILIES.map((id) => [
        id,
        manifest.assistantActionFamilies.find((entry) => entry.id === id)!.defaultTier
      ])
    ) as Record<(typeof TAGGED_FAMILIES)[number], Tier>;
    expect(detectStep(defaults)).toBe("routine");
  });
});
