import { describe, expect, it } from "vitest";

import { readableTime } from "./heartbeat/publish.js";

describe("readableTime", () => {
  it("writes an ISO time in the owner's zone", () => {
    expect(readableTime("2026-10-29T15:00:00Z", "America/New_York")).toBe("Oct 29, 2026, 11:00 AM");
  });

  it("keeps date-only values as dates", () => {
    expect(readableTime("2026-10-29", "America/New_York")).toBe("Oct 29, 2026");
  });

  it("passes through values it cannot parse", () => {
    expect(readableTime("sometime soon", "UTC")).toBe("sometime soon");
  });
});
