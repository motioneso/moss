import { useMemo, useState, useEffect } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, EmptyState, IconButton, LegendSwatch, Segmented } from "@moss/ui";
import { listCalendarEvents } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAssistantName } from "../api/use-assistant-name.js";
import "../styles/kit-calendar.css";
import {
  buildWeekDays,
  dtoToViewEvent,
  groupEventsByDay,
  isToday,
  loadPersistedCursor,
  loadPersistedView,
  loadPersistedWorkWeek,
  navigateCursor,
  rangeLabel,
  DOW_SHORT,
  type CalendarView,
  type CalendarViewEvent
} from "./calendar-model.js";
import { CalendarTimeGrid, type DayData } from "./calendar-time-grid.js";
import { CalendarMonth } from "./calendar-month.js";
import { CalendarPeek } from "./calendar-peek.js";

const HOUR_H = 58;

export function CalendarPage() {
  const assistantName = useAssistantName();
  const [view, setView] = useState<CalendarView>(loadPersistedView);
  const [cursor, setCursor] = useState<Date>(loadPersistedCursor);
  const [workWeek, setWorkWeek] = useState<boolean>(loadPersistedWorkWeek);
  const [peek, setPeek] = useState<CalendarViewEvent | null>(null);

  useEffect(() => {
    localStorage.setItem("moss.cal.view", view);
  }, [view]);
  useEffect(() => {
    localStorage.setItem("moss.cal.cursor", cursor.toISOString());
  }, [cursor]);
  useEffect(() => {
    localStorage.setItem("moss.cal.workweek", workWeek ? "1" : "0");
  }, [workWeek]);

  const calendarQuery = useQuery({
    queryKey: queryKeys.calendar.list,
    queryFn: () => listCalendarEvents()
  });

  const allViewEvents = useMemo(
    () =>
      (calendarQuery.data?.events ?? [])
        .map(dtoToViewEvent)
        .filter((e): e is CalendarViewEvent => e !== null),
    [calendarQuery.data]
  );

  const eventsByDay = useMemo(() => groupEventsByDay(allViewEvents), [allViewEvents]);

  const [searchParams] = useSearchParams();
  useEffect(() => {
    const requestedId = searchParams.get("event");
    if (!requestedId) return;
    const requested = allViewEvents.find((e) => e.id === requestedId);
    if (requested) setPeek(requested);
  }, [searchParams, allViewEvents]);

  const weekDays = useMemo(
    () => (view === "week" ? buildWeekDays(cursor, workWeek) : []),
    [view, cursor, workWeek]
  );

  const dayObjs: DayData[] = useMemo(() => {
    const activeDays = view === "day" ? [cursor] : view === "week" ? weekDays : [];
    return activeDays.map((d) => ({
      date: d,
      events: eventsByDay.get(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`) ?? []
    }));
  }, [view, cursor, weekDays, eventsByDay]);

  const label = rangeLabel(cursor, view, view === "week" ? weekDays : [cursor]);

  const heldToday = useMemo(() => {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    return (eventsByDay.get(key) ?? []).filter((e) => e.kind === "block").length;
  }, [eventsByDay]);

  function go(dir: -1 | 1) {
    setCursor((c) => navigateCursor(c, view, dir));
  }
  function pickDay(date: Date) {
    setCursor(date);
    setView("day");
  }

  return (
    <div className="cal-wrap" style={{ "--cal-h": HOUR_H + "px" } as React.CSSProperties}>
      <div className="cal-toolbar">
        <div className="cal-toolbar__left">
          <Button variant="secondary" size="sm" onClick={() => setCursor(new Date())}>
            Today
          </Button>
          <div className="cal-nav">
            <IconButton size="sm" aria-label="Previous" onClick={() => go(-1)}>
              <ChevronLeft size={18} />
            </IconButton>
            <IconButton size="sm" aria-label="Next" onClick={() => go(1)}>
              <ChevronRight size={18} />
            </IconButton>
          </div>
          <h2 className="cal-range">
            {view === "day" ? (
              <>
                <span className="cal-range__dow">{DOW_SHORT[cursor.getDay()]}</span>
                {label.replace(/^\S+,?\s*/, "")}
              </>
            ) : (
              label
            )}
          </h2>
        </div>
        <div className="cal-toolbar__right">
          {view === "week" ? (
            <Segmented
              ariaLabel="Week type"
              value={workWeek ? "work" : "full"}
              onChange={(v) => setWorkWeek(v === "work")}
              options={[
                { value: "work", label: "Work week" },
                { value: "full", label: "Full week" }
              ]}
            />
          ) : null}
          <Segmented
            ariaLabel="View"
            value={view}
            onChange={setView}
            options={(["day", "week", "month"] as const).map((v) => ({
              value: v,
              label: v.charAt(0).toUpperCase() + v.slice(1)
            }))}
          />
        </div>
      </div>
      {view !== "month" ? (
        <div className="cal-legend">
          <span className="cal-legend__item">
            <LegendSwatch tone="hard" />
            Accepted
          </span>
          <span className="cal-legend__item">
            <LegendSwatch tone="hold" />
            {assistantName} holding
          </span>
          {view === "day" && isToday(cursor) && heldToday > 0 ? (
            <span className="cal-legend__note">
              {assistantName} is holding {heldToday} block{heldToday === 1 ? "" : "s"} around what
              matters today.
            </span>
          ) : null}
        </div>
      ) : null}
      {view !== "day" ? (
        <p className="cal-scroll-hint jds-caption" id="calendar-scroll-hint">
          Scroll sideways to see more days, or choose Day for a closer look.
        </p>
      ) : null}
      <div className="cal-notice">
        {calendarQuery.isPending ? <p role="status">Loading calendar…</p> : null}
        {calendarQuery.isError ? (
          <div role="alert">
            {calendarQuery.data ? (
              <p className="jds-hint jds-hint--error">
                Could not refresh your calendar. Previously loaded events are still shown.
              </p>
            ) : (
              <EmptyState
                title="Could not load your calendar"
                description="Try again to load your events."
              />
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={calendarQuery.isFetching}
              onClick={() => void calendarQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
      {calendarQuery.data ? (
        <div
          className="cal-body"
          role="region"
          aria-label={`Calendar ${view}`}
          tabIndex={view === "day" ? undefined : 0}
          aria-describedby={view === "day" ? undefined : "calendar-scroll-hint"}
        >
          {view === "month" ? (
            <CalendarMonth
              cursor={cursor}
              eventsByDay={eventsByDay}
              onPickDay={pickDay}
              onPick={setPeek}
            />
          ) : (
            <CalendarTimeGrid days={dayObjs} hourH={HOUR_H} onPick={setPeek} />
          )}
        </div>
      ) : null}
      <CalendarPeek event={peek} onClose={() => setPeek(null)} />
    </div>
  );
}
