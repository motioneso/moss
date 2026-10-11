import { describe, expect, it } from "vitest";

import { meetingIdOnRoute } from "../../apps/web/src/shell/meeting-route-context.js";

const MEETING_ID = "abcdef12-3456-4789-8abc-123456789abc";

describe("meetingIdOnRoute", () => {
  it("selects the valid meeting on the actual meetings route", () => {
    expect(meetingIdOnRoute("/meetings", `?id=${MEETING_ID}`)).toBe(MEETING_ID);
  });

  it("keeps selection through unrelated query changes and transcript evidence links", () => {
    expect(
      meetingIdOnRoute(
        "/meetings",
        `?tab=notes&id=${MEETING_ID}&segmentId=${MEETING_ID}&segmentRevision=4&startCharacter=0&endCharacter=12`
      )
    ).toBe(MEETING_ID);
  });

  it("uses the same case-insensitive UUID validation as explicit meeting chat", () => {
    expect(meetingIdOnRoute("/meetings", `?id=${MEETING_ID.toUpperCase()}`)).toBe(
      MEETING_ID.toUpperCase()
    );
  });

  it.each(["/today", "/notes", "/meetings/", "/meetings/other", "/m/meetings", "/Meetings"])(
    "does not select a meeting from an id query on %s",
    (pathname) => {
      expect(meetingIdOnRoute(pathname, `?id=${MEETING_ID}`)).toBeNull();
    }
  );

  it.each([
    "",
    "?id=",
    "?meetingId=" + MEETING_ID,
    "?id=not-a-uuid",
    "?id=../../other",
    "?id=" + MEETING_ID + "extra",
    "?id=%20" + MEETING_ID,
    "?id=" + MEETING_ID + "%0A",
    "?id=" + MEETING_ID + "&id=" + MEETING_ID,
    "?id=" + MEETING_ID + "&id=",
    "?id=&id=" + MEETING_ID,
    "?id=" + MEETING_ID + "&%69d=" + MEETING_ID
  ])("rejects missing, malformed, or ambiguous selection: %s", (search) => {
    expect(meetingIdOnRoute("/meetings", search)).toBeNull();
  });
});
