// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { CalendarEventDto, LocaleSettingsDto } from "@moss/shared";

import type { ChangedBriefingBlock } from "../../apps/web/src/today/briefing-callout.js";
import {
  TodayRail,
  preparationBlockMinutes,
  type RailNextEvent
} from "../../apps/web/src/today/today-rail.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

const nextEvent: RailNextEvent = {
  id: "event-1",
  title: "Roadmap review",
  startsAt: "2026-09-28T17:00:00.000Z",
  endsAt: "2026-09-28T17:30:00.000Z",
  location: "Room 4"
};

function calendarEvent(overrides: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    id: "block-1",
    connectorAccountId: "acct-1",
    ownerUserId: "user-1",
    title: "Prep for the roadmap review",
    startsAt: "2026-09-28T16:30:00.000Z",
    endsAt: "2026-09-28T17:00:00.000Z",
    location: null,
    summary: null,
    bodyExcerpt: null,
    externalId: "ext-1",
    isMossBlock: true,
    allDay: false,
    attendeeCount: 0,
    status: null,
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides
  };
}

describe("preparationBlockMinutes", () => {
  it("returns the block's minutes when a preceding Moss block is titled as preparation and touches the meeting's start", () => {
    expect(preparationBlockMinutes(nextEvent, [calendarEvent()])).toBe(30);
  });

  it("returns null when there is no preceding block", () => {
    expect(preparationBlockMinutes(nextEvent, [])).toBeNull();
  });

  it("returns null when the touching Moss block is not titled as preparation", () => {
    expect(preparationBlockMinutes(nextEvent, [calendarEvent({ title: "Focus time" })])).toBeNull();
  });

  it("returns null when the preparation-titled Moss block does not touch the meeting's start", () => {
    expect(
      preparationBlockMinutes(nextEvent, [calendarEvent({ endsAt: "2026-09-28T16:45:00.000Z" })])
    ).toBeNull();
  });
});

function baseRailProps(
  precedingEvents: readonly CalendarEventDto[],
  changed: readonly ChangedBriefingBlock[] = []
) {
  return {
    mode: "day" as const,
    now: new Date("2026-09-28T16:00:00.000Z"),
    locale,
    nextEvent,
    precedingEvents,
    nextStarted: false,
    changedSinceLastNight: changed,
    onNavigate: () => undefined,
    showEveningReview: false,
    showEveningPrep: false,
    latestEveningRun: null,
    eveningRunsPending: false,
    eveningTargetTime: "17:00",
    onEveningFeedback: () => undefined,
    interviewPending: false,
    onPrep: () => undefined,
    onPlan: () => undefined,
    wellnessEnabled: false,
    theme: "light" as const,
    timeZone: locale.timezone,
    disabledModuleIds: []
  };
}

function renderRail(
  precedingEvents: readonly CalendarEventDto[],
  changed: readonly ChangedBriefingBlock[] = []
): string {
  return renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(TodayRail, baseRailProps(precedingEvents, changed))
    )
  );
}

describe("TodayRail morning column sections", () => {
  it("names a moved block under Since last night", () => {
    const html = renderRail(
      [],
      [
        {
          title: "Review",
          oldStartsAt: "2026-09-28T21:00:00.000Z",
          newStartsAt: "2026-09-28T20:00:00.000Z",
          proposed: false
        }
      ]
    );
    expect(html).toContain("Since last night");
    expect(html).toContain("Review is now at");
  });

  it("shows no Since last night section when nothing moved", () => {
    expect(renderRail([])).not.toContain("Since last night");
  });

  it("no longer carries At a glance, Today's agenda or a preparation list", () => {
    const html = renderRail([]);
    expect(html).not.toContain("At a glance");
    expect(html).not.toContain("Today&#x27;s agenda");
    expect(html).not.toContain("Your preparation");
  });
});

describe("TodayRail preparation line", () => {
  it("shows the preparation note when a matching preparation block precedes the meeting", () => {
    const html = renderRail([calendarEvent()]);
    expect(html).toContain("You have a 30-minute preparation block before this meeting.");
  });

  it("shows no preparation note when there is no preceding block", () => {
    const html = renderRail([]);
    expect(html).not.toContain("preparation block");
  });

  it("shows no preparation note when the touching block is not titled as preparation", () => {
    const html = renderRail([calendarEvent({ title: "Focus time" })]);
    expect(html).not.toContain("preparation block");
  });

  it("shows no preparation note when the preparation-titled block does not touch the meeting's start", () => {
    const html = renderRail([calendarEvent({ endsAt: "2026-09-28T16:45:00.000Z" })]);
    expect(html).not.toContain("preparation block");
  });

  it("links See meeting to the real event id", async () => {
    const navigated: string[] = [];
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        createElement(
          MemoryRouter,
          null,
          createElement(TodayRail, {
            ...baseRailProps([]),
            onNavigate: (path: string) => navigated.push(path)
          })
        )
      );
    });
    const button = renderer!.root.findAll(
      (node: ReactTestInstance) =>
        node.type === "button" && node.props.className === "cmd-next__link"
    )[0]!;
    act(() => {
      button.props.onClick();
    });
    expect(navigated).toEqual(["/calendar?event=event-1"]);
    renderer!.unmount();
  });
});
