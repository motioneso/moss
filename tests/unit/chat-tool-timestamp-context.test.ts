import { describe, expect, it, vi } from "vitest";

import { buildEngineText } from "../../packages/chat/src/live/engine-text.js";

function persistence(localTimezone: string | null) {
  return {
    getThreadContext: vi.fn(async () => ({
      threadTitle: null,
      localTimezone,
      incognito: false
    })),
    listPriorTurns: vi.fn()
  };
}

describe("current account-local time supplied to chat", () => {
  it.each([
    ["America/Los_Angeles", "2026-10-06 (Tuesday) 18:15", -420],
    ["Asia/Tokyo", "2026-10-07 (Wednesday) 10:15", 540]
  ])("carries the UTC instant and correct local date in %s", async (zone, local, offset) => {
    const store = persistence(zone);
    const result = await buildEngineText(
      { persistence: store, now: () => new Date("2026-10-07T01:15:00.000Z") },
      "owner-1",
      "List my pending suggestions."
    );

    expect(store.getThreadContext).toHaveBeenCalledWith("owner-1", undefined);
    expect(result.text).toContain("Current UTC time: 2026-10-07T01:15:00.000Z (Wednesday)");
    expect(result.text).toContain(
      `User's local time: ${local} (${zone}, UTC offset ${offset} minutes)`
    );
    expect(result.text.endsWith("\n\nList my pending suggestions.")).toBe(true);
  });

  it.each([
    ["2026-11-01T08:30:00.000Z", -420],
    ["2026-11-01T09:30:00.000Z", -480]
  ])("preserves the correct current-time offset for %s at the DST overlap", async (utc, offset) => {
    const result = await buildEngineText(
      { persistence: persistence("America/Los_Angeles"), now: () => new Date(utc) },
      "owner-1",
      "What time is it?"
    );

    expect(result.text).toContain(`Current UTC time: ${utc}`);
    expect(result.text).toContain(
      `User's local time: 2026-11-01 (Sunday) 01:30 (America/Los_Angeles, UTC offset ${offset} minutes)`
    );
  });

  it("refreshes the current time for every turn", async () => {
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-10-07T01:15:00.000Z"))
      .mockReturnValueOnce(new Date("2026-10-07T02:15:00.000Z"));
    const deps = { persistence: persistence("America/Los_Angeles"), now };
    const first = await buildEngineText(deps, "owner-1", "What time is it?");
    const second = await buildEngineText(deps, "owner-1", "And now?");

    expect(first.text).toContain("2026-10-06 (Tuesday) 18:15");
    expect(second.text).toContain("Current UTC time: 2026-10-07T02:15:00.000Z");
    expect(second.text).toContain("2026-10-06 (Tuesday) 19:15");
    expect(second.text).not.toContain("18:15");
  });

  it.each([null, "Not/AZone"])("does not invent local clock context for %s", async (zone) => {
    const result = await buildEngineText(
      { persistence: persistence(zone), now: () => new Date("2026-10-07T01:15:00.000Z") },
      "owner-1",
      "What time is it?"
    );

    expect(result.text).toContain("Current UTC time: 2026-10-07T01:15:00.000Z");
    expect(result.text).not.toContain("User's local time:");
  });
});
