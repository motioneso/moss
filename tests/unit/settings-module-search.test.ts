import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, afterEach } from "vitest";

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

  it("does not offer a module that has no settings page to open", () => {
    // Active, not required, no contributed settings page, no on/off switches, no credential
    // slots — nowhere for the search box to send the user, so it must not be a result at all.
    const modules: MyModuleDto[] = [
      fakeModule({ id: "job-search", name: "Job Search", active: true, required: false })
    ];
    const items = buildModuleSettingsSearchItems(modules, [], "Moss");
    expect(items.map((item) => item.id)).not.toContain("module:job-search");
  });

  it("finds an installed module by its declared credential slot's own name", () => {
    // Mirrors what the server now computes for an installed module with a user-scope credential
    // slot and no on/off switches (Finance's Plaid tokens) — declared text only, no stored value.
    const modules: MyModuleDto[] = [
      fakeModule({
        id: "finance",
        name: "Finance",
        hasUserCredentials: true,
        settingKeywords: ["Plaid access tokens"]
      })
    ];
    const items = buildModuleSettingsSearchItems(modules, [], "Moss");
    const results = searchSettings(items, "Plaid");
    expect(results.map((item) => item.id)).toContain("module:finance");
  });

  describe("built-in module preference labels", () => {
    let rootDir: string;

    afterEach(() => {
      if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    });

    it("scans a declared on/off switch's label into that module's setting keywords", () => {
      rootDir = mkdtempSync(join(tmpdir(), "settings-search-scan-"));
      const pkgDir = join(rootDir, "packages", "widgets");
      mkdirSync(join(pkgDir, "src"), { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "@moss/widgets" }, null, 2)
      );
      writeFileSync(
        join(pkgDir, "src", "manifest.ts"),
        [
          "export const widgetsManifest = {",
          '  id: "widgets",',
          '  name: "Widgets",',
          '  lifecycle: "optional",',
          "  settings: [],",
          "  preferences: [",
          '    { key: "compactView", label: "Compact widget cards", description: "Shrink cards to fit more on screen." }',
          "  ]",
          "};"
        ].join("\n")
      );

      const scanResult = scanModuleSettings({ rootDir });
      expect(scanResult.settingKeywords.widgets).toContain("Compact widget cards");

      const modules: MyModuleDto[] = [
        fakeModule({ id: "widgets", name: "Widgets", hasPreferences: true })
      ];
      const items = buildModuleSettingsSearchItems(
        modules,
        scanResult.surfaces,
        "Moss",
        scanResult.settingKeywords
      );
      const results = searchSettings(items, "Compact widget cards");
      expect(results.map((item) => item.id)).toContain("module:widgets");
    });
  });
});
