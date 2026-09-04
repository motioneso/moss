import { describe, expect, it } from "vitest";

import { scanModuleSettings } from "../../packages/settings-ui/src/scanner.js";
import { buildModuleSettingsSearchItems } from "../../apps/web/src/settings/settings-module-search.js";
import { searchSettings } from "../../apps/web/src/settings/settings-search.js";
import type { MyModuleDto } from "../../packages/shared/src/platform-api-modules.js";

function fakeModule(overrides: Partial<MyModuleDto> & { id: string; name: string }): MyModuleDto {
  return {
    version: "0.1.0",
    lifecycle: "user-toggleable",
    required: false,
    supportsUserDisable: true,
    instanceDisabled: false,
    userDisabled: false,
    active: true,
    hasPreferences: false,
    hasUserCredentials: false,
    scope: "everyone",
    ...overrides
  };
}

describe("settings search covers module settings", () => {
  it("finds the news module's real manifest-declared settings by searching News", () => {
    const { surfaces } = scanModuleSettings({ rootDir: process.cwd() });
    const newsSurface = surfaces.find((surface) => surface.moduleId === "news");
    expect(newsSurface).toBeDefined();
    expect(newsSurface?.description).toContain("news topics");

    const modules: MyModuleDto[] = [fakeModule({ id: "news", name: "News" })];
    const items = buildModuleSettingsSearchItems(modules, surfaces, "Moss");
    const newsItem = items.find((item) => item.id === "module:news");
    expect(newsItem).toBeDefined();
    expect(newsItem?.description).toBe(newsSurface?.description);

    const results = searchSettings(items, "News");
    expect(results.map((item) => item.id)).toContain("module:news");
  });
});
