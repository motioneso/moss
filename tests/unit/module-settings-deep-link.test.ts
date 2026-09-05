import { describe, expect, it } from "vitest";

import { resolveModuleSettingsDeepLink } from "../../apps/web/src/settings/module-settings-deep-link.js";

describe("resolveModuleSettingsDeepLink", () => {
  it("routes built-in module settings surfaces directly", () => {
    expect(resolveModuleSettingsDeepLink("briefings", () => false)).toBe("briefings");
    expect(resolveModuleSettingsDeepLink("notifications", () => false)).toBe("notifications");
    expect(resolveModuleSettingsDeepLink("chat", () => false)).toBeNull();
  });

  it("routes contributed module surfaces by module id", () => {
    expect(resolveModuleSettingsDeepLink("tasks", (moduleId) => moduleId === "tasks")).toEqual({
      moduleId: "tasks"
    });
  });

  it("ignores unknown module ids", () => {
    expect(resolveModuleSettingsDeepLink("unknown", () => false)).toBeNull();
  });
});
