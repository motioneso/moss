import { describe, expect, it } from "vitest";

import { requiresCalendarConfirmation } from "../../packages/calendar/src/confirmation-policy.js";

describe("requiresCalendarConfirmation", () => {
  it("skips confirmation for a Moss-created event", () => {
    expect(requiresCalendarConfirmation({ jarvisCreated: true })).toBe(false);
  });

  it("requires confirmation for a user-created event, independent of tier", () => {
    expect(requiresCalendarConfirmation({ jarvisCreated: false })).toBe(true);
  });
});

describe("calendar.deleteEvent requiresConfirmation hook", () => {
  it("fails closed to true when the event ref does not resolve", async () => {
    const { calendarModuleManifest } = await import("../../packages/calendar/src/manifest.js");
    const deleteTool = calendarModuleManifest.assistantTools.find(
      (tool) => tool.name === "calendar.deleteEvent"
    );
    expect(deleteTool, "expected tool calendar.deleteEvent to exist").toBeDefined();
    const hook = deleteTool?.requiresConfirmation;
    expect(hook, "expected calendar.deleteEvent to declare requiresConfirmation").toBeDefined();

    // A scopedDb that isn't a real DataContextDb makes every repository call throw;
    // resolveCalendarEventRef (1a) collapses that to found:false, and the hook must fail
    // closed to true rather than defaulting to auto-run.
    const scopedDb = {} as never;
    const ctx = { actorUserId: "u1", requestId: "r1", chatSessionId: "s1" };

    await expect(
      hook?.(scopedDb, { eventId: "11111111-1111-4111-8111-111111111111" }, ctx, undefined)
    ).resolves.toBe(true);
  });
});
