// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CalendarEventDto, LocaleSettingsDto } from "@moss/shared";

import { PracticalNote } from "../../apps/web/src/today/practical-note.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};
const now = new Date("2026-09-29T17:00:00.000Z");

function event(overrides: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    id: "e1",
    connectorAccountId: "c1",
    ownerUserId: "u1",
    title: "Pick up the repair",
    startsAt: "2026-09-29T23:00:00.000Z",
    endsAt: "2026-09-29T23:30:00.000Z",
    location: "Main Street Repairs",
    summary: null,
    bodyExcerpt: null,
    externalId: "x1",
    isMossBlock: false,
    allDay: false,
    attendeeCount: 0,
    status: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...overrides
  };
}

const render = (events: readonly CalendarEventDto[], excludeEventId: string | null = null) =>
  renderToString(createElement(PracticalNote, { events, now, excludeEventId, locale }));

describe("PracticalNote", () => {
  it("names the place and start time of a later event", () => {
    const html = render([event()]);
    expect(html).toContain("Pick up the repair at 4:00 pm is at Main Street Repairs.");
  });

  it("renders nothing when no event has a place", () => {
    expect(render([event({ location: null }), event({ id: "e2", location: "  " })])).toBe("");
  });

  it("renders nothing for no events", () => {
    expect(render([])).toBe("");
  });

  it("skips started, all-day, Moss-made and already-shown events", () => {
    const events = [
      event({ id: "started", startsAt: "2026-09-29T16:00:00.000Z" }),
      event({ id: "allday", allDay: true }),
      event({ id: "moss", isMossBlock: true }),
      event({ id: "shown" })
    ];
    expect(render(events, "shown")).toBe("");
  });

  it("uses the first qualifying event in order", () => {
    const html = render([
      event({ id: "a", title: "Dentist", location: "Elm St" }),
      event({ id: "b", title: "Later" })
    ]);
    expect(html).toContain("Dentist");
    expect(html).not.toContain("Later");
  });
});
