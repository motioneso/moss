import { describe, expect, it, vi } from "vitest";

import { buildEngineText } from "../../packages/chat/src/live/engine-text.js";
import { renderCurrentTimeContext } from "../../packages/chat/src/live/time-context.js";

// This verifies the context supplied to the model, not whether a model follows it.
describe("tool timestamp guidance in the per-turn time context", () => {
  it("pairs the reported UTC instant with the previous Pacific evening", async () => {
    const instant = new Date("2026-10-07T01:15:00.000Z");
    const getThreadContext = vi.fn(async () => ({
      threadTitle: null,
      localTimezone: "America/Los_Angeles",
      incognito: false
    }));
    const result = await buildEngineText(
      {
        persistence: { getThreadContext, listPriorTurns: vi.fn() },
        now: () => instant
      },
      "owner-1",
      "List my pending suggestions."
    );

    expect(getThreadContext).toHaveBeenCalledWith("owner-1", undefined);
    expect(result.text).toContain("Current UTC time: 2026-10-07T01:15:00.000Z (Wednesday)");
    expect(result.text).toContain(
      "User's local time: 2026-10-06 (Tuesday) 18:15 (America/Los_Angeles, UTC offset -420 minutes)"
    );
    expect(result.text).toContain("ISO 8601 timestamps ending in Z are UTC");
    expect(result.text).toContain("Read ISO clock hours as 24-hour time");
    expect(result.text).toContain("Never relabel the raw UTC clock as local or change only AM/PM");
    expect(result.text).toContain("carry any date change across midnight");
    expect(instant.toISOString()).toBe("2026-10-07T01:15:00.000Z");
  });

  it("keeps record event times distinct from the fresh current-time reference", () => {
    const context = renderCurrentTimeContext(
      new Date("2026-10-07T02:00:00.000Z"),
      "America/Los_Angeles"
    );

    expect(context).toContain("createdAt and updatedAt describe the record's own event time");
    expect(context).toContain("not the current time");
    expect(context).toContain("preserve the original instant");
    expect(context).toContain(
      "show the original timestamp with its explicit zone instead of guessing"
    );
  });

  it.each([
    ["2026-11-01T08:30:00.000Z", "2026-11-01 (Sunday) 01:30", -420],
    ["2026-11-01T09:30:00.000Z", "2026-11-01 (Sunday) 01:30", -480]
  ])("anchors %s across the daylight-saving transition", (utc, local, offset) => {
    const context = renderCurrentTimeContext(new Date(utc), "America/Los_Angeles");

    expect(context).toContain(`Current UTC time: ${utc}`);
    expect(context).toContain(`${local} (America/Los_Angeles, UTC offset ${offset} minutes)`);
    expect(context).toContain("offset in effect at that timestamp (including daylight saving)");
    expect(context).toContain("not necessarily the current offset above");
  });

  it("uses the supplied account zone rather than assuming Pacific", () => {
    const context = renderCurrentTimeContext(new Date("2026-10-07T01:15:00.000Z"), "Asia/Tokyo");

    expect(context).toContain("2026-10-07 (Wednesday) 10:15 (Asia/Tokyo, UTC offset 540 minutes)");
    expect(context).toContain("user's time zone (Asia/Tokyo)");
    expect(context).not.toContain("America/Los_Angeles");
  });

  it.each([null, "Not/AZone"])("does not invent a local label for unknown zone %s", (zone) => {
    const context = renderCurrentTimeContext(new Date("2026-10-07T01:15:00.000Z"), zone);

    expect(context).toContain("ISO 8601 timestamps ending in Z are UTC");
    expect(context).toContain("preserve tool timestamps in their explicit source zone");
    expect(context).toContain("unless the user requests a specific target time zone");
    expect(context).toContain("For a requested target zone, apply its offset at the timestamp");
    expect(context).toContain("If you mention the current time");
    expect(context).toContain("do not label them as the user's local time");
    expect(context).not.toContain("User's local time:");
    expect(context).not.toContain("convert that instant to the user's time zone");
  });
});
