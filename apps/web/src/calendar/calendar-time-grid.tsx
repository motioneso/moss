import { useEffect, useRef } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { AllDayChip, EventChip, NowLine, TodayPill, type EventChipVariant } from "@moss/ui";

import {
  DOW_SHORT,
  fmtHour,
  fmtTime,
  isToday,
  nowMin,
  packDay,
  type CalendarViewEvent
} from "./calendar-model.js";

export interface DayData {
  readonly date: Date;
  readonly events: CalendarViewEvent[];
}

interface EventBlockProps {
  readonly e: CalendarViewEvent;
  readonly hourH: number;
  readonly dense: boolean;
  readonly onPick: (e: CalendarViewEvent) => void;
}

function EventBlock({ e, hourH, dense, onPick }: EventBlockProps) {
  const ppm = hourH / 60;
  const top = e.startMin * ppm;
  const height = Math.max((e.endMin - e.startMin) * ppm, 22);
  const cols = e._cols || 1;
  const col = e._col || 0;
  const w = 100 / cols;
  const left = col * w;
  const isBlock = e.kind === "block";
  const showTime = height >= 34;
  const showWhere = height >= 58 && !dense && e.where;
  const isTentative = e.status === "needsAction" || e.status === "tentative";
  const variant: EventChipVariant = isBlock ? "block" : isTentative ? "tentative" : "hard";

  return (
    <EventChip
      variant={variant}
      color={isBlock ? "var(--accent-fg)" : "var(--steel)"}
      title={e.title}
      holdIcon={isBlock ? <GitCommitHorizontal size={11} /> : undefined}
      time={showTime ? fmtTime(e.startMin) : undefined}
      where={showWhere ? e.where : undefined}
      onClick={() => onPick(e)}
      style={{
        top,
        height,
        left: `calc(${left}% + 2px)`,
        width: `calc(${w}% - 4px)`
      }}
    />
  );
}

interface TimeGridProps {
  readonly days: DayData[];
  readonly hourH: number;
  readonly onPick: (e: CalendarViewEvent) => void;
}

export function CalendarTimeGrid({ days, hourH, onPick }: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nowPx = nowMin() * (hourH / 60);
    el.scrollTop = Math.max(0, nowPx - el.clientHeight / 2);
  }, [hourH]);

  const tmpl = `60px repeat(${days.length}, minmax(0, 1fr))`;
  const anyAllDay = days.some((d) => d.events.some((e) => e.allDay));
  const todayNowMin = nowMin();

  return (
    <div className="cal-tg" style={{ "--cal-h": hourH + "px" } as React.CSSProperties}>
      <div className="cal-tg__head" style={{ gridTemplateColumns: tmpl }}>
        <div className="cal-tg__corner" />
        {days.map((d) => (
          <div
            key={d.date.toISOString()}
            className={"cal-tg__dayhd" + (isToday(d.date) ? " is-today" : "")}
          >
            <span className="cal-tg__dow">{DOW_SHORT[d.date.getDay()]}</span>
            <TodayPill variant="grid">{d.date.getDate()}</TodayPill>
          </div>
        ))}
      </div>

      {anyAllDay ? (
        <div className="cal-tg__allday" style={{ gridTemplateColumns: tmpl }}>
          <div className="cal-tg__allday-lbl">all-day</div>
          {days.map((d) => (
            <div key={d.date.toISOString()} className="cal-tg__allday-cell">
              {d.events
                .filter((e) => e.allDay)
                .map((e) => (
                  <AllDayChip
                    key={e.id}
                    color={e.kind === "block" ? "var(--accent-fg)" : "var(--steel)"}
                    title={e.title}
                    onClick={() => onPick(e)}
                  />
                ))}
            </div>
          ))}
        </div>
      ) : null}

      <div className="cal-tg__scroll" ref={scrollRef}>
        <div className="cal-tg__body" style={{ gridTemplateColumns: tmpl, height: 24 * hourH }}>
          <div className="cal-tg__gutter">
            {Array.from({ length: 24 }, (_, h) =>
              h === 0 ? null : (
                <span key={h} className="cal-tg__hr" style={{ top: h * hourH }}>
                  {fmtHour(h)}
                </span>
              )
            )}
          </div>
          {days.map((d) => {
            const packed = packDay([...d.events]);
            const todayCol = isToday(d.date);
            return (
              <div
                key={d.date.toISOString()}
                className={"cal-tg__col" + (todayCol ? " is-today" : "")}
              >
                {packed.map((e) => (
                  <EventBlock
                    key={e.id}
                    e={e}
                    hourH={hourH}
                    dense={days.length > 3}
                    onPick={onPick}
                  />
                ))}
                {todayCol ? <NowLine top={todayNowMin * (hourH / 60)} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
