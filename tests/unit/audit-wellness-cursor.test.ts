import { describe, expect, it } from "vitest";
import {
  encodeCheckinCursor,
  parseCheckinCursor
} from "../../packages/wellness/src/checkin-pagination.js";
import { exportRangeDays } from "../../apps/web/src/wellness/export-draft.js";
import { checkinWindowSince } from "../../apps/web/src/wellness/wellness-date-utils.js";

const id = "00000000-0000-0000-0000-000000000001";
const stamp = "2026-10-10T23:59:59.123456Z";
const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("Wellness precise keyset cursors", () => {
  it("round-trips six-digit microseconds and UUID without looking up the boundary row", () => {
    expect(parseCheckinCursor(encodeCheckinCursor(stamp, id))).toEqual({
      checkedInAt: stamp,
      id,
      since: null
    });
    expect(parseCheckinCursor(undefined)).toBeUndefined();
  });
  it("binds the canonical instant filter", () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const cursor = encodeCheckinCursor(stamp, id, since);
    expect(parseCheckinCursor(cursor, new Date("2026-09-30T20:00:00-04:00"))?.since).toBe(
      since.toISOString()
    );
    expect(() => parseCheckinCursor(cursor)).toThrow("does not match");
    expect(() => parseCheckinCursor(cursor, new Date("2026-10-02T00:00:00Z"))).toThrow(
      "does not match"
    );
  });
  it.each([
    "",
    "!",
    "a".repeat(513),
    token(null),
    token([]),
    token({ checkedInAt: stamp, id: "bad", since: null }),
    token({ checkedInAt: "0000-01-01T00:00:00.123456Z", id, since: null }),
    token({ checkedInAt: "2026-02-30T00:00:00.123456Z", id, since: null }),
    token({ checkedInAt: "2026-10-10T23:59:59.123Z", id, since: null })
  ])("rejects invalid cursor %s", (cursor) => {
    expect(() => parseCheckinCursor(cursor)).toThrow("Invalid check-in cursor");
  });
});

describe("Wellness calendar window bounds", () => {
  it("pads the instant read before exact downstream local-day filtering", () => {
    expect(checkinWindowSince("2026-10-01")).toBe("2026-09-30T00:00:00.000Z");
  });
  it("validates inclusive UTC ranges, including leap years and invalid dates", () => {
    expect(exportRangeDays("2024-01-01", "2024-12-31")).toBe(366);
    expect(exportRangeDays("2024-01-01", "2025-01-01")).toBe(367);
    expect(exportRangeDays("2026-01-01", "2026-01-01")).toBe(1);
    expect(exportRangeDays("2026-02-30", "2026-03-01")).toBeNull();
    expect(exportRangeDays("2026-03-02", "2026-03-01")).toBeNull();
  });
});
