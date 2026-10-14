import { describe, expect, it, vi } from "vitest";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { createAppMapReadService } from "@moss/settings";
import { CORE_APP_SCREENS, CORE_APP_SETTINGS } from "@moss/shared";
import { buildAppMap } from "../../scripts/build-app-map.js";

const artifact = buildAppMap({
  manifests: getBuiltInModuleManifests(),
  coreScreens: CORE_APP_SCREENS,
  coreSettings: CORE_APP_SETTINGS,
  version: "test",
  buildId: "test",
  narrative: ""
});

function service() {
  return createAppMapReadService({
    artifact,
    resolveActiveModules: async () => [{ id: "news" }],
    resolveFeatureFlagState: () => true,
    getUser: async () => ({ is_instance_admin: true }),
    logGap: vi.fn()
  });
}

describe("app-map free-text remediation lookup", () => {
  it("returns the declared News requirement and Settings link for the observed model query", async () => {
    const result = await service().query({} as never, "owner", {
      query: "AI providers structured output JSON capable economy model News configure"
    });
    expect(result.items).toContainEqual(
      expect.objectContaining({
        id: "news.add_source",
        requires: expect.objectContaining({ capability: "json", tier: "economy" })
      })
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        id: "news.add_source.configure_json_model",
        path: "/settings?section=aiproviders"
      })
    );
    expect(result.items.length).toBeLessThanOrEqual(8);
  });

  it("keeps exact remediation references discoverable", async () => {
    const result = await service().query({} as never, "owner", {
      query: "news.add_source.configure_json_model"
    });
    expect(result.items).toContainEqual(
      expect.objectContaining({
        id: "news.add_source.configure_json_model",
        path: "/settings?section=aiproviders"
      })
    );
  });

  it("does not treat one shared word in an unrelated phrase as a match", async () => {
    const result = await service().query({} as never, "owner", {
      query: "News quantum sandwich"
    });
    expect(result.items).toEqual([]);
  });
});
