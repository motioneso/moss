import { DayCell, MonthChip, TodayPill } from "@moss/ui";
import {
  DOW_SHORT,
  MONTH_NAMES,
  buildMonthCells,
  dayKey,
  fmtTime,
  isToday,
  type CalendarViewEvent
} from "./calendar-model.js";

interface CalendarMonthProps {
  readonly cursor: Date;
  readonly eventsByDay: Map<string, CalendarViewEvent[]>;
  readonly onPickDay: (date: Date) => void;
  readonly onPick: (e: CalendarViewEvent) => void;
}

export function CalendarMonth({ cursor, eventsByDay, onPickDay, onPick }: CalendarMonthProps) {
  const cells = buildMonthCells(cursor);
  const curMonth = cursor.getMonth();
  const rowCount = cells.length / 7;

  return (
    <div className="cal-month">
      <div className="cal-month__head">
        {DOW_SHORT.map((d) => (
          <div key={d} className="cal-month__dow">
            {d}
          </div>
        ))}
      </div>
      <div className="cal-month__grid" style={{ gridTemplateRows: `repeat(${rowCount}, 1fr)` }}>
        {cells.map((date) => {
          const out = date.getMonth() !== curMonth;
          const today = isToday(date);
          const key = dayKey(date);
          const evs = (eventsByDay.get(key) ?? [])
            .slice()
            .sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || a.startMin - b.startMin);
          const shown = evs.slice(0, 3);
          const extra = evs.length - 3;

          return (
            <DayCell
              key={key + "-" + date.getDate()}
              out={out}
              today={today}
              onPickDate={() => onPickDay(date)}
              dateContent={
                <>
                  <TodayPill variant="month">{date.getDate()}</TodayPill>
                  {date.getDate() === 1 ? (
                    <span className="mo">{(MONTH_NAMES[date.getMonth()] ?? "").slice(0, 3)}</span>
                  ) : null}
                </>
              }
            >
              {shown.map((e) => (
                <MonthChip
                  key={e.id}
                  block={e.kind === "block"}
                  color={e.kind === "block" ? "var(--accent-fg)" : "var(--steel)"}
                  time={!e.allDay ? fmtTime(e.startMin).replace(":00", "") : undefined}
                  title={e.title}
                  onClick={() => onPick(e)}
                />
              ))}
              {extra > 0 ? (
                <button type="button" className="cal-mmore" onClick={() => onPickDay(date)}>
                  {extra} more
                </button>
              ) : null}
            </DayCell>
          );
        })}
      </div>
    </div>
  );
}
