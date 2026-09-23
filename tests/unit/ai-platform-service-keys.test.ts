import { describe, expect, it } from "vitest";

import { isPlatformServiceKey, PLATFORM_SERVICE_NAMESPACES } from "@moss/shared";

// #2570: the model-binding check treats these namespaces as installed. The list must stay to
// platform-owned names, so this pins both what is accepted and what is not.
describe("platform-owned AI service namespaces", () => {
  it("lists exactly the platform-owned names", () => {
    expect([...PLATFORM_SERVICE_NAMESPACES]).toEqual(["trail-marker"]);
  });

  it("accepts the Trail Marker key and sub-keys of that namespace", () => {
    expect(isPlatformServiceKey("module.trail-marker")).toBe(true);
    expect(isPlatformServiceKey("module.trail-marker.judge")).toBe(true);
  });

  it("does not accept a look-alike or another module's name (fails if the check is a prefix match)", () => {
    expect(isPlatformServiceKey("module.trail-markers")).toBe(false);
    expect(isPlatformServiceKey("module.trail-marker-evil")).toBe(false);
    expect(isPlatformServiceKey("module.connectors.email-extract")).toBe(false);
    expect(isPlatformServiceKey("module.worker")).toBe(false);
    expect(isPlatformServiceKey("module.nonexistent")).toBe(false);
  });
});
