import { describe, expect, it } from "vitest";

import type { BriefingPlanBlockV1, BriefingPlanContextV1, LocaleSettingsDto } from "@moss/shared";

import { calloutCopy, findChangedBlocks } from "../../apps/web/src/today/briefing-callout.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

function block(id: string, overrides: Partial<BriefingPlanBlockV1> = {}): BriefingPlanBlockV1 {
  return {
    id,
    kind: "focus",
    taskId: null,
    title: `Block ${id}`,
    position: 0,
    actualPlacement: null,
    pendingChange: null,
    ...overrides
  };
}

function context(blocks: readonly BriefingPlanBlockV1[]): BriefingPlanContextV1 {
  return {
    version: 1,
    planId: "plan-1",
    revision: 1,
    localDay: "2026-09-10",
    timeZone: locale.timezone,
    sourceRunId: null,
    eveningIntent: null,
    blocks
  };
}

const at9 = { startsAt: "2026-09-10T16:00:00.000Z", durationMinutes: 30, calendarEventRef: null };
const at10 = { startsAt: "2026-09-10T17:00:00.000Z", durationMinutes: 30, calendarEventRef: null };

describe("findChangedBlocks", () => {
  it("returns nothing when either context is missing", () => {
    expect(findChangedBlocks(null, context([]))).toEqual([]);
    expect(findChangedBlocks(context([]), null)).toEqual([]);
  });

  it("ignores a block whose time did not move", () => {
    const before = context([block("a", { actualPlacement: at9 })]);
    const after = context([block("a", { actualPlacement: at9 })]);
    expect(findChangedBlocks(before, after)).toEqual([]);
  });

  it("ignores a block that only exists on one side", () => {
    const before = context([block("a", { actualPlacement: at9 })]);
    const after = context([block("b", { actualPlacement: at10 })]);
    expect(findChangedBlocks(before, after)).toEqual([]);
  });

  it("reports a block whose confirmed time moved", () => {
    const before = context([block("a", { actualPlacement: at9 })]);
    const after = context([block("a", { actualPlacement: at10 })]);
    expect(findChangedBlocks(before, after)).toEqual([
      { title: "Block a", oldStartsAt: at9.startsAt, newStartsAt: at10.startsAt, proposed: false }
    ]);
  });

  it("reads a pending block's proposed time instead of its confirmed placement, and marks it proposed", () => {
    const before = context([block("a", { actualPlacement: at9 })]);
    const after = context([
      block("a", {
        actualPlacement: at9,
        pendingChange: "move",
        pendingStartsAt: at10.startsAt
      })
    ]);
    expect(findChangedBlocks(before, after)).toEqual([
      { title: "Block a", oldStartsAt: at9.startsAt, newStartsAt: at10.startsAt, proposed: true }
    ]);
  });

  it("falls back to the block's kind when it has no title", () => {
    const before = context([block("a", { title: null, actualPlacement: at9 })]);
    const after = context([block("a", { title: null, actualPlacement: at10 })]);
    expect(findChangedBlocks(before, after)[0]?.title).toBe("focus");
  });

  it("reports every changed block across multiple blocks", () => {
    const before = context([
      block("a", { actualPlacement: at9 }),
      block("b", { actualPlacement: at9 })
    ]);
    const after = context([
      block("a", { actualPlacement: at10 }),
      block("b", { actualPlacement: at10 })
    ]);
    expect(findChangedBlocks(before, after)).toHaveLength(2);
  });
});

describe("calloutCopy", () => {
  it("returns null when nothing changed", () => {
    expect(calloutCopy([], locale)).toBeNull();
  });

  it("writes singular copy naming the one block and its new time", () => {
    const copy = calloutCopy(
      [
        { title: "Standup", oldStartsAt: at9.startsAt, newStartsAt: at10.startsAt, proposed: false }
      ],
      locale
    );
    expect(copy?.headline).toBe("Standup is now at 10:00 AM.");
    expect(copy?.sentence).toBe("Standup is set for 10:00 AM.");
    expect(copy?.disclosureLines).toEqual(["Standup: 9:00 AM to 10:00 AM"]);
  });

  it("marks a proposed single block as proposed, not set", () => {
    const copy = calloutCopy(
      [{ title: "Standup", oldStartsAt: at9.startsAt, newStartsAt: at10.startsAt, proposed: true }],
      locale
    );
    expect(copy?.sentence).toBe("Standup is proposed for 10:00 AM.");
  });

  it("handles a block with no new time as no time", () => {
    const copy = calloutCopy(
      [{ title: "Standup", oldStartsAt: at9.startsAt, newStartsAt: null, proposed: false }],
      locale
    );
    expect(copy?.headline).toBe("Standup is now at no time.");
  });

  it("writes a count headline and one disclosure line per block when several changed", () => {
    const copy = calloutCopy(
      [
        {
          title: "Standup",
          oldStartsAt: at9.startsAt,
          newStartsAt: at10.startsAt,
          proposed: false
        },
        { title: "Review", oldStartsAt: at9.startsAt, newStartsAt: at10.startsAt, proposed: true }
      ],
      locale
    );
    expect(copy?.headline).toBe("2 blocks changed since this report.");
    expect(copy?.sentence).toBe("Some blocks moved since this report was prepared.");
    expect(copy?.disclosureLines).toEqual([
      "Standup: 9:00 AM to 10:00 AM",
      "Review: 9:00 AM to 10:00 AM"
    ]);
  });
});
