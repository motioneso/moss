import { describe, expect, it } from "vitest";

import {
  validateExternalModuleManifest,
  type ReconciledExternalModule
} from "@moss/module-registry";
import { serializeExternalModule } from "../../apps/api/src/module-dto.js";

const base = {
  schemaVersion: 1,
  id: "acme-widgets",
  name: "Acme Widgets",
  version: "0.1.0",
  publisher: "Acme, Inc.",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.1.0" }
};

function validate(settingsPath: unknown) {
  return validateExternalModuleManifest({ ...base, settingsPath }, "acme-widgets", "0.1.0");
}

describe("external settingsPath (#3184)", () => {
  it("keeps a clean module-relative path on the manifest", () => {
    const result = validate("/settings");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.settingsPath).toBe("/settings");
  });

  it.each([
    ["a host route", "https://evil.example/x"],
    ["a parent segment", "/../settings"],
    ["a query string", "/settings?x=1"],
    ["a non-string", 4],
    ["an empty string", ""],
    ["the module root", "/"]
  ])("rejects %s", (_name, value) => {
    expect(validate(value).ok).toBe(false);
  });

  it("is absent when not declared", () => {
    const result = validateExternalModuleManifest(base, "acme-widgets", "0.1.0");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.settingsPath).toBeUndefined();
  });

  it("serializes to an absolute /m/<id> route only when declared", () => {
    const module = {
      id: "acme-widgets",
      name: "Acme Widgets",
      version: "0.1.0",
      navigation: [],
      preferences: [],
      web: null,
      status: "enabled"
    } as unknown as ReconciledExternalModule;
    expect(serializeExternalModule(module).settingsPath).toBeUndefined();
    expect(serializeExternalModule({ ...module, settingsPath: "/settings" }).settingsPath).toBe(
      "/m/acme-widgets/settings"
    );
  });
});
