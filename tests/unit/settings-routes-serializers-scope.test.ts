import { describe, expect, it } from "vitest";

import type { MossModuleManifest } from "@moss/module-sdk";

import {
  toMyModuleDto,
  toMyModuleDtoFromExternal
} from "../../packages/settings/src/routes-serializers.js";
import type { InstalledExternalModuleSummary } from "../../packages/settings/src/routes-external-module-types.js";

// #1945 — a built-in module is never private; an external one is private only while its
// builder hasn't shipped it yet.

const builtInManifest: MossModuleManifest = {
  id: "finance",
  name: "Finance",
  version: "0.1.0",
  lifecycle: "optional"
} as MossModuleManifest;

function externalModule(
  status: InstalledExternalModuleSummary["status"]
): InstalledExternalModuleSummary {
  return {
    id: "gmm",
    name: "GMM tracker",
    version: "0.1.0",
    hasPreferences: false,
    hasUserCredentials: false,
    status,
    settingKeywords: []
  };
}

describe("toMyModuleDto (built-in modules)", () => {
  it("is always everyone's, never private to one person", () => {
    const dto = toMyModuleDto(builtInManifest, false, false);
    expect(dto.scope).toBe("everyone");
  });
});

describe("toMyModuleDtoFromExternal", () => {
  it("is visible only to its builder while still a draft", () => {
    const dto = toMyModuleDtoFromExternal(externalModule("draft"), false);
    expect(dto.scope).toBe("you");
  });

  it("is everyone's once shipped", () => {
    const dto = toMyModuleDtoFromExternal(externalModule("enabled"), false);
    expect(dto.scope).toBe("everyone");
  });
});
