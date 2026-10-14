import { describe, expect, it } from "vitest";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { buildAppMap } from "../../scripts/build-app-map.js";

describe("bounded agreement real registry and app-map contract", () => {
  it("boots the built-in registry and emits the bounded inactive feature within description bounds", () => {
    const manifests = getBuiltInModuleManifests();
    const feature = manifests
      .find((manifest) => manifest.id === "chat")
      ?.features?.find((entry) => entry.id === "chat.bounded_action_agreements");
    expect(feature).toBeDefined();
    expect(feature!.description.trim().length).toBeGreaterThanOrEqual(1);
    expect(feature!.description.trim().length).toBeLessThanOrEqual(240);
    for (const declaration of [...(feature!.errors ?? []), ...(feature!.remediations ?? [])]) {
      expect(declaration.description.trim().length).toBeGreaterThanOrEqual(1);
      expect(declaration.description.trim().length).toBeLessThanOrEqual(240);
    }
    expect(
      feature!.errors?.find((error) => error.code === "bounded_action_not_active")
    ).toMatchObject({ class: "validation" });
    expect(
      feature!.errors?.find((error) => error.code === "bounded_action_not_active")
    ).not.toHaveProperty("remediationRef");
    for (const error of feature!.errors ?? []) {
      if (error.class === "prerequisite")
        expect(
          feature!.remediations?.some((remediation) => remediation.id === error.remediationRef)
        ).toBe(true);
    }
    const artifact = buildAppMap({
      manifests,
      coreScreens: [],
      coreSettings: [],
      version: "proof",
      buildId: "bounded-agreement",
      narrative: ""
    });
    expect(artifact.features).toContainEqual({ moduleId: "chat", ...feature });
    expect(feature!.description).toContain("inactive");
    expect(feature!.description).toContain("JSON model");
    expect(feature!.description).toContain("Tasks status-change");
  });
});
