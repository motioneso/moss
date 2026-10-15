// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarEventDto, LocaleSettingsDto } from "@moss/shared";
import {
  dateRangeLabel,
  dayKey,
  dtoToViewEvent,
  fmtHour,
  fmtTime,
  groupEventsByDay,
  isToday,
  navigateCursor,
  nowMin,
  rangeLabel,
  plainDate,
  todayIn,
  type CalendarViewEvent
} from "../../apps/web/src/calendar/calendar-model.js";
import { CalendarMonth } from "../../apps/web/src/calendar/calendar-month.js";
import { CalendarPage } from "../../apps/web/src/calendar/calendar-page.js";
import { CalendarPeek } from "../../apps/web/src/calendar/calendar-peek.js";
import { CalendarTimeGrid } from "../../apps/web/src/calendar/calendar-time-grid.js";

// #3392: the machine runs in UTC and the person lives in Los Angeles with 24-hour time.
// "Now" is Jun 21 03:30 UTC, which is still Jun 20 20:30 for the person.
process.env.TZ = "UTC";
const TZ = "America/Los_Angeles";
const LA_24: LocaleSettingsDto = { timezone: TZ, region: "en-US", dateFormat: "24" };
const LA_12: LocaleSettingsDto = { ...LA_24, dateFormat: "12" };
// Unlike the app's built-in default in every field, so a screen that ignores the saved setting fails.
const TOKYO_GB_12: LocaleSettingsDto = {
  timezone: "Asia/Tokyo",
  region: "en-GB",
  dateFormat: "12"
};
const NOW = "2026-06-21T03:30:00.000Z";

const api = vi.hoisted(() => ({
  listCalendarEvents: vi.fn(),
  getLocaleSettings: vi.fn()
}));
vi.mock("../../apps/web/src/api/client.js", () => api);
vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({ useAssistantName: () => "Moss" }));

// Jun 20 20:30-21:45 in Los Angeles; Jun 21 on the machine's clock.
const evening: CalendarEventDto = {
  id: "evening",
  connectorAccountId: "conn-1",
  ownerUserId: "user-1",
  title: "Evening call",
  startsAt: "2026-06-21T03:30:00.000Z",
  endsAt: "2026-06-21T04:45:00.000Z",
  location: null,
  summary: null,
  bodyExcerpt: null,
  externalId: "ext-1",
  isMossBlock: false,
  allDay: false,
  attendeeCount: 0,
  status: "accepted",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z"
};

function eveningView(): CalendarViewEvent {
  const view = dtoToViewEvent(evening, TZ);
  if (!view) throw new Error("bad dto");
  return view;
}

describe("calendar model in the person's timezone", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("positions an event by the person's clock and day", () => {
    const view = eveningView();
    expect(view.startMin).toBe(20 * 60 + 30);
    expect(view.endMin).toBe(21 * 60 + 45);
    expect(dayKey(view.date)).toBe("2026-06-20");
  });

  it("formats event times and hour labels in the person's 12/24-hour choice", () => {
    expect(fmtTime(20 * 60 + 30, LA_24)).toBe("20:30");
    expect(fmtTime(9 * 60, LA_24)).toBe("09:00");
    expect(fmtHour(13, LA_24)).toBe("13:00");
    expect(fmtTime(9 * 60, LA_12)).toBe("9 AM");
    expect(fmtTime(9 * 60 + 30, LA_12)).toBe("9:30 AM");
    expect(fmtHour(13, LA_12)).toBe("1 PM");
  });

  it("decides today and now in the person's timezone", () => {
    expect(dayKey(todayIn(TZ))).toBe("2026-06-20");
    expect(isToday(plainDate(2026, 5, 20), TZ)).toBe(true);
    expect(isToday(plainDate(2026, 5, 21), TZ)).toBe(false);
    expect(nowMin(TZ)).toBe(20 * 60 + 30);
  });

  it("groups events under the person's day", () => {
    const byDay = groupEventsByDay([eveningView()], TZ);
    expect([...byDay.keys()]).toEqual(["2026-06-20"]);
  });

  it("labels the date in the person's timezone", () => {
    expect(dateRangeLabel(eveningView(), LA_24)).toBe("Saturday, June 20");
  });

  it("ends an event at the person's midnight on the day before", () => {
    // Jun 20 20:00 to Jun 21 00:00 in Los Angeles.
    const view = dtoToViewEvent(
      { ...evening, startsAt: "2026-06-21T03:00:00.000Z", endsAt: "2026-06-21T07:00:00.000Z" },
      TZ
    );
    expect(view && dateRangeLabel(view, LA_24)).toBe("Saturday, June 20");
  });

  it("labels the toolbar range in the person's region", () => {
    const day = plainDate(2026, 5, 20);
    const week = [plainDate(2026, 5, 14), day];
    expect(rangeLabel(day, "day", [day], LA_24)).toBe("June 20");
    expect(rangeLabel(day, "week", week, LA_24)).toBe("Jun 14 – Jun 20");
    expect(rangeLabel(day, "month", [day], LA_24)).toBe("June 2026");
    expect(rangeLabel(day, "day", [day], TOKYO_GB_12)).toBe("20 June");
    expect(rangeLabel(day, "week", week, TOKYO_GB_12)).toBe("14 Jun – 20 Jun");
  });

  it("keeps a month step inside the shorter month", () => {
    expect(dayKey(navigateCursor(plainDate(2026, 0, 31), "month", 1))).toBe("2026-02-28");
    expect(dayKey(navigateCursor(plainDate(2026, 2, 31), "month", -1))).toBe("2026-02-28");
  });
});

describe("calendar screens in the person's timezone", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    api.listCalendarEvents.mockReset().mockResolvedValue({ events: [evening] });
    api.getLocaleSettings.mockReset().mockResolvedValue({ locale: LA_24 });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function render(node: React.ReactNode) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>{node}</MemoryRouter>
        </QueryClientProvider>
      )
    );
    await act(async () => {
      await client.refetchQueries();
    });
  }

  function texts(selector: string): string[] {
    return [...container.querySelectorAll(selector)].map((n) => n.textContent ?? "");
  }

  it("shows the peek's times and date in the person's zone and format", async () => {
    await render(<CalendarPeek event={eveningView()} onClose={() => undefined} />);
    expect(texts(".cal-peek__rowmain")[0]).toContain("20:30 – 21:45");
    expect(texts(".cal-peek__rowsub")).toEqual(["Saturday, June 20"]);
  });

  it("labels hours, event times and the now line in the person's zone and format", async () => {
    const day = plainDate(2026, 5, 20);
    const events = groupEventsByDay([eveningView()], TZ).get(dayKey(day)) ?? [];
    await render(<CalendarTimeGrid days={[{ date: day, events }]} hourH={60} onPick={() => {}} />);
    expect(texts(".cal-tg__hr")).toContain("13:00");
    expect(texts(".cal-ev__meta")).toEqual(["20:30"]);
    expect(container.querySelector(".cal-tg__col")?.className).toContain("is-today");
    expect((container.querySelector(".cal-now") as HTMLElement).style.top).toBe(
      `${20 * 60 + 30}px`
    );
  });

  it("puts the month chip on the person's day with their time format", async () => {
    await render(
      <CalendarMonth
        cursor={plainDate(2026, 5, 1)}
        eventsByDay={groupEventsByDay([eveningView()], TZ)}
        onPickDay={() => {}}
        onPick={() => {}}
      />
    );
    const today = container.querySelector(".cal-mcell.is-today");
    expect(today?.querySelector(".cal-mcell__date")?.textContent).toBe("20");
    expect(today?.querySelector(".cal-mchip__t")?.textContent).toBe("20:30");
  });

  it("follows a saved setting unlike the default on every screen", async () => {
    api.getLocaleSettings.mockResolvedValue({ locale: TOKYO_GB_12 });
    // Jun 21 12:30-13:45 in Tokyo, which is also Tokyo's today.
    const view = dtoToViewEvent(evening, TOKYO_GB_12.timezone);
    if (!view) throw new Error("bad dto");
    const day = plainDate(2026, 5, 21);
    const byDay = groupEventsByDay([view], TOKYO_GB_12.timezone);

    await render(<CalendarPeek event={view} onClose={() => undefined} />);
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(texts(".cal-peek__rowmain")[0]).toContain("12:30 pm – 1:45 pm");
    });
    expect(texts(".cal-peek__rowsub")).toEqual(["Sunday 21 June"]);

    await render(
      <CalendarTimeGrid
        days={[{ date: day, events: byDay.get(dayKey(day)) ?? [] }]}
        hourH={60}
        onPick={() => {}}
      />
    );
    expect(texts(".cal-tg__hr")).toContain("1 pm");
    expect(texts(".cal-ev__meta")).toEqual(["12:30 pm"]);
    expect(container.querySelector(".cal-tg__col")?.className).toContain("is-today");
    expect((container.querySelector(".cal-now") as HTMLElement).style.top).toBe(
      `${12 * 60 + 30}px`
    );

    await render(
      <CalendarMonth
        cursor={plainDate(2026, 5, 1)}
        eventsByDay={byDay}
        onPickDay={() => {}}
        onPick={() => {}}
      />
    );
    const today = container.querySelector(".cal-mcell.is-today");
    expect(today?.querySelector(".cal-mcell__date")?.textContent).toBe("21");
    expect(today?.querySelector(".cal-mchip__t")?.textContent).toBe("12:30 pm");
  });

  it("opens on the person's today and shows that day's events", async () => {
    await render(<CalendarPage />);
    expect(container.querySelector(".cal-range")?.textContent).toBe("SatJune 20");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(texts(".cal-ev__titletext")).toEqual(["Evening call"]);
    });
  });

  it("counts held blocks on the person's today", async () => {
    // Both are Jun 20 in Los Angeles; on the machine's clock only the morning one is.
    const evenHold = { ...evening, id: "hold-pm", title: "Focus", isMossBlock: true };
    const mornHold = {
      ...evenHold,
      id: "hold-am",
      startsAt: "2026-06-20T18:00:00.000Z",
      endsAt: "2026-06-20T19:00:00.000Z"
    };
    api.listCalendarEvents.mockResolvedValue({ events: [evenHold, mornHold] });
    await render(<CalendarPage />);
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector(".cal-legend__note")?.textContent).toContain(
        "holding 2 flexible blocks today."
      );
    });
  });
});
