import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_SENSITIVITY_PREFERENCE_KEY,
  sensitivityFromRaw,
  sensitivityToRaw,
  shouldPushImmediately
} from "@moss/notifications";

describe("notification sensitivity", () => {
  it("defaults to balanced for missing or malformed stored values", () => {
    expect(sensitivityFromRaw(null)).toBe("balanced");
    expect(sensitivityFromRaw({})).toBe("balanced");
    expect(sensitivityFromRaw({ sensitivity: "loud" })).toBe("balanced");
    expect(sensitivityFromRaw([])).toBe("balanced");
  });

  it("round-trips each level through the stored shape", () => {
    for (const level of ["quiet", "balanced", "proactive"] as const) {
      expect(sensitivityFromRaw(sensitivityToRaw(level))).toBe(level);
    }
    expect(NOTIFICATION_SENSITIVITY_PREFERENCE_KEY).toBe("notifications:sensitivity");
  });

  it("quiet pushes only urgent, balanced skips low, proactive pushes everything", () => {
    expect(shouldPushImmediately("quiet", "urgent")).toBe(true);
    expect(shouldPushImmediately("quiet", "normal")).toBe(false);
    expect(shouldPushImmediately("quiet", "low")).toBe(false);
    expect(shouldPushImmediately("balanced", "urgent")).toBe(true);
    expect(shouldPushImmediately("balanced", "normal")).toBe(true);
    expect(shouldPushImmediately("balanced", "low")).toBe(false);
    expect(shouldPushImmediately("proactive", "low")).toBe(true);
  });
});
