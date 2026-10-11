import { describe, expect, it } from "vitest";
import { meetingWeekStart } from "../../packages/meetings/src/web/locale.js";

describe("meeting history owner-local calendar weeks", () => {
  it.each([
    ["2026-10-05T01:00:00Z", "America/Los_Angeles", "2026-09-28T00:00:00.000Z"],
    ["2026-10-05T01:00:00Z", "UTC", "2026-10-05T00:00:00.000Z"],
    ["2026-10-04T12:00:00Z", "Pacific/Auckland", "2026-10-05T00:00:00.000Z"],
    ["2026-03-09T06:00:00Z", "America/Los_Angeles", "2026-03-02T00:00:00.000Z"],
    ["2026-03-09T07:00:00Z", "America/Los_Angeles", "2026-03-09T00:00:00.000Z"],
    ["2027-01-01T12:00:00Z", "Europe/London", "2026-12-28T00:00:00.000Z"]
  ])("groups %s in %s by the local Monday", (instant, timezone, expected) => {
    expect(meetingWeekStart(instant, timezone)).toBe(expected);
  });
});
