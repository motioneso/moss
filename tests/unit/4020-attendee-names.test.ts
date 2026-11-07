import { describe, expect, it } from "vitest";

import { extractAttendeeNames } from "../../packages/connectors/src/google-attendee-names.js";

describe("extractAttendeeNames", () => {
  it("keeps display names only and drops the owner's own entry", () => {
    const names = extractAttendeeNames([
      { email: "me@x.test", displayName: "Me Owner", self: true },
      { email: "ann@x.test", displayName: "Ann Lee" },
      { email: "bob@x.test", displayName: "  Bob Ray  " }
    ]);
    expect(names).toEqual(["Ann Lee", "Bob Ray"]);
  });

  it("never emits an email, even when there is no display name", () => {
    const names = extractAttendeeNames([
      { email: "nobody@x.test" },
      { email: "c@x.test", displayName: "c@x.test" },
      { displayName: "   " },
      "junk",
      null
    ]);
    expect(names).toEqual([]);
    expect(JSON.stringify(names)).not.toContain("@");
  });

  it("caps at 20 names and trims each to 80 characters", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ displayName: `P${i}` }));
    expect(extractAttendeeNames(many)).toHaveLength(20);
    const [long] = extractAttendeeNames([{ displayName: "x".repeat(200) }]);
    expect(long).toHaveLength(80);
  });

  it("returns an empty list when attendees are missing", () => {
    expect(extractAttendeeNames(undefined)).toEqual([]);
  });
});
