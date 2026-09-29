import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CalendarEventDto, DayPlanBlockInput, TaskDto } from "@moss/shared";

import {
  EveningRail,
  type EveningSnapshotProps
} from "../../apps/web/src/today/evening-planning-frame.js";

const locale = { timezone: "UTC", region: "en-US", dateFormat: "12" } as never;

function event(id: string, start: string, end: string, extra: Partial<CalendarEventDto> = {}) {
  return {
    id,
    title: id,
    startsAt: `2026-09-11T${start}:00.000Z`,
    endsAt: `2026-09-11T${end}:00.000Z`,
    allDay: false,
    isMossBlock: false,
    ...extra
  } as unknown as CalendarEventDto;
}

function draft(taskId: string, start: string, minutes = 45): DayPlanBlockInput {
  return {
    taskId,
    title: taskId,
    pendingChange: {
      kind: "add",
      startsAt: `2026-09-11T${start}:00.000Z`,
      durationMinutes: minutes
    }
  } as unknown as DayPlanBlockInput;
}

function render(overrides: Partial<EveningSnapshotProps>): string {
  return renderToStaticMarkup(
    createElement(EveningRail, {
      railDateInput: "2026-09-11T12:00:00Z",
      locale,
      events: [],
      proposals: [],
      tasks: [] as TaskDto[],
      capacity: "normal",
      policyMode: "suggest",
      ...overrides
    })
  );
}

describe("evening snapshot notes", () => {
  it("names room after the last calendar entry and the shared gap between blocks", () => {
    const html = render({
      events: [event("Dental", "10:00", "10:45")],
      proposals: [draft("a", "13:00"), draft("b", "14:00")]
    });
    expect(html).toContain("Room to get home and have lunch.");
    expect(html).toContain("15 minutes between task blocks.");
  });

  it("shows neither note when the gaps are short or uneven", () => {
    const html = render({
      events: [event("Dental", "10:00", "12:45")],
      proposals: [draft("a", "13:00"), draft("b", "14:00"), draft("c", "15:30")]
    });
    expect(html).not.toContain("Room to get home");
    expect(html).not.toContain("between task blocks");
  });

  it("never calls booked time free when a folded Moss block fills the gap", () => {
    const html = render({
      events: [
        event("Dental", "09:00", "09:45"),
        event("Old block", "09:45", "13:00", { isMossBlock: true })
      ],
      proposals: [draft("a", "13:00")]
    });
    expect(html).toContain("Existing calendar task blocks");
    expect(html).not.toContain("Room to get home");
  });

  it("measures room from the event that ends last when events overlap", () => {
    const html = render({
      events: [event("Long", "09:00", "12:30"), event("Short", "10:00", "10:30")],
      proposals: [draft("a", "13:00")]
    });
    expect(html).not.toContain("Room to get home");
  });

  it("folds existing Moss blocks unless automatic scheduling is on", () => {
    const moss = event("Old block", "09:00", "09:30", { isMossBlock: true });
    const suggest = render({ events: [moss], proposals: [draft("a", "13:00")] });
    expect(suggest).toContain("Existing calendar task blocks");
    expect(suggest).not.toContain("Scheduled by Moss");
    const auto = render({ events: [moss], policyMode: "auto" });
    expect(auto).not.toContain("Existing calendar task blocks");
    expect(auto).toContain("Scheduled by Moss");
  });
});
