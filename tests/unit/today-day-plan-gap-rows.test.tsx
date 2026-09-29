import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DayPlanBlockDto,
  DayPlanDto,
  GetDayPlanResponse,
  LocaleSettingsDto
} from "@moss/shared";

import { DayPlanSection } from "../../apps/web/src/today/day-plan.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

const NOW = new Date("2026-06-30T16:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function placed(
  id: string,
  startsAt: string,
  durationMinutes: number,
  position: number
): DayPlanBlockDto {
  return {
    id,
    kind: "focus",
    taskId: "t1",
    title: `Block ${id}`,
    position,
    actualPlacement: { startsAt, durationMinutes, calendarEventRef: null },
    pendingChange: null
  };
}

function plan(blocks: DayPlanBlockDto[]): DayPlanDto {
  return {
    id: "plan-1",
    localDay: "2026-06-30",
    timeZone: locale.timezone,
    revision: 1,
    sourceRunId: null,
    blocks,
    eveningIntent: {
      priorityTaskIds: [],
      capacity: null,
      notes: null,
      corrections: [],
      commitments: []
    }
  };
}

function dayPlanResponse(planValue: DayPlanDto | null): GetDayPlanResponse {
  return {
    plan: planValue,
    tasks: [
      { id: "t1", title: "Write the draft", status: "todo", dueAt: null, doAt: null, effort: null }
    ],
    unavailableTaskIds: [],
    sourceRun: null,
    sourceRunUnavailable: false
  };
}

function render(planValue: DayPlanDto | null, todayLayout: boolean): string {
  return renderToString(
    createElement(DayPlanSection, {
      dayPlan: dayPlanResponse(planValue),
      events: [],
      locale,
      now: NOW,
      loading: false,
      error: false,
      calendarError: false,
      editorial: true,
      todayLayout,
      onOpenTask: () => undefined
    })
  );
}

describe("DayPlanSection schedule gaps (Today layout)", () => {
  it("renders a break row, an open-time row, a three-entry legend and a closing line", () => {
    const html = render(
      plan([
        // 10:00-10:15 block, 15-min gap, 10:30-11:00 block, 60-min gap, 12:00-12:30 block
        placed("b1", "2026-06-30T17:00:00.000Z", 15, 0),
        placed("b2", "2026-06-30T17:30:00.000Z", 30, 1),
        placed("b3", "2026-06-30T19:00:00.000Z", 30, 2)
      ]),
      true
    );

    expect(html).toContain("Open time");
    expect(html).toContain("A break before the next block");
    expect(html).toContain("No more commitments after");
  });

  it("shows no gap rows, no open-time legend entry, and no closing line outside the Today layout", () => {
    const html = render(
      plan([
        placed("b1", "2026-06-30T17:00:00.000Z", 15, 0),
        placed("b2", "2026-06-30T19:00:00.000Z", 30, 1)
      ]),
      false
    );
    expect(html).not.toContain("A break before the next block");
    expect(html).not.toContain("No more commitments after");
  });

  it("shows nothing new for an empty schedule", () => {
    const html = render(plan([]), true);
    expect(html).not.toContain("Open time");
    expect(html).not.toContain("A break before the next block");
    expect(html).not.toContain("No more commitments after");
  });

  it("omits the open-time legend entry when the schedule has no gaps", () => {
    const html = render(plan([placed("b1", "2026-06-30T17:00:00.000Z", 30, 0)]), true);
    expect(html).not.toContain("A break before the next block");
    expect(html.match(/tl-legend__/g)?.length).toBe(2);
  });

  it("places a gap after the block just before it, not after a block that merely contains it (case 16)", () => {
    // A 9:00-12:00 PDT contains B 10:00-10:30 PDT; C starts at 13:00 PDT. The gap between
    // the end of the containing block and C must render after B, the block right before it
    // in the list, not after A. taskId is null on each block so its own title renders
    // instead of the shared task's title.
    function untitledBlock(
      id: string,
      startsAt: string,
      durationMinutes: number,
      position: number
    ): DayPlanBlockDto {
      return {
        id,
        kind: "focus",
        taskId: null,
        title: `Block ${id}`,
        position,
        actualPlacement: { startsAt, durationMinutes, calendarEventRef: null },
        pendingChange: null
      };
    }
    const html = render(
      plan([
        untitledBlock("A", "2026-06-30T16:00:00.000Z", 180, 0),
        untitledBlock("B", "2026-06-30T17:00:00.000Z", 30, 1),
        untitledBlock("C", "2026-06-30T20:00:00.000Z", 30, 2)
      ]),
      true
    );

    // "Open time" also appears once in the legend above the list, so the gap row itself
    // is located by its wrapper class instead of by that shared text.
    const posA = html.indexOf("Block A");
    const posB = html.indexOf("Block B");
    const posOpen = html.indexOf("tl-slot--gap");
    const posC = html.indexOf("Block C");

    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(posA);
    expect(posOpen).toBeGreaterThan(posB);
    expect(posC).toBeGreaterThan(posOpen);
  });
});

describe("DayPlanSection task block detail (Today layout)", () => {
  it("shows the Flexible tag on a committed block and Proposed on a first proposal", () => {
    const proposed: DayPlanBlockDto = {
      id: "b2",
      kind: "focus",
      taskId: "t1",
      title: "Block b2",
      position: 1,
      actualPlacement: null,
      pendingChange: { kind: "add", startsAt: "2026-06-30T19:00:00.000Z", durationMinutes: 30 }
    };
    const html = render(plan([placed("b1", "2026-06-30T17:00:00.000Z", 30, 0), proposed]), true);
    expect(html).toContain("Flexible");
    expect(html).toContain(">Proposed<");
    expect(html).not.toContain("Change pending");
  });

  it("shows no reason line when no event backs one", () => {
    const html = render(plan([placed("b1", "2026-06-30T17:00:00.000Z", 30, 0)]), true);
    expect(html).not.toContain("For ");
  });
});
