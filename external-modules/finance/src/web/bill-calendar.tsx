import { DayCell, MonthChip, MonthGrid, TodayPill, type ReactNodeLike } from "@moss/module-web-sdk";
import type { BillsView, Occurrence } from "./screens/upcoming";
import { occurrenceChip, occurrenceDate, occurrenceKey } from "./bill-occurrence";
import { monthLabel, shortDayLabel, shortMonthLabel } from "./format";

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);

// Weeks start on Sunday, matching the Calendar page.
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(Date.UTC(2023, 0, 1 + i)).toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC"
  })
);

export const weekStart = (date: string) =>
  iso(utc(date) - new Date(utc(date)).getUTCDay() * DAY_MS);

/** "Oct 26 – Nov 1" for the week that starts on the given Sunday. */
export const weekLabel = (start: string) =>
  `${shortDayLabel(start)} – ${shortDayLabel(iso(utc(start) + 6 * DAY_MS))}`;

/** Bills in date order, grouped into the weeks they fall in. */
export function billWeeks(occurrences: readonly Occurrence[]) {
  const weeks = new Map<string, Occurrence[]>();
  const sorted = [...occurrences].sort(
    (a, b) =>
      occurrenceDate(a).localeCompare(occurrenceDate(b)) ||
      a.name.localeCompare(b.name) ||
      occurrenceKey(a).localeCompare(occurrenceKey(b))
  );
  for (const o of sorted) {
    const start = weekStart(occurrenceDate(o));
    weeks.set(start, [...(weeks.get(start) ?? []), o]);
  }
  return [...weeks].map(([start, items]) => ({ start, items }));
}

function monthCells(month: string) {
  const first = utc(`${month}-01`);
  const lead = new Date(first).getUTCDay();
  const days = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)
  ).getUTCDate();
  return Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => {
    const date = iso(first + (i - lead) * DAY_MS);
    return { date, out: date.slice(0, 7) !== month };
  });
}

export function BillCalendar(props: {
  month: string;
  view: BillsView;
  onOpen: (o: Occurrence) => void;
}): ReactNodeLike {
  const byDay = new Map<string, Occurrence[]>();
  for (const { items } of billWeeks(props.view.occurrences))
    for (const o of items)
      byDay.set(occurrenceDate(o), [...(byDay.get(occurrenceDate(o)) ?? []), o]);
  return (
    <div className="fnm-desktop-only">
      <MonthGrid weekdays={WEEKDAYS} label={`${monthLabel(props.month)} bills`}>
        {monthCells(props.month).map(({ date, out }) => (
          <DayCell
            key={date}
            out={out}
            today={date === props.view.today}
            dateContent={
              <>
                <TodayPill variant="month">{Number(date.slice(8))}</TodayPill>
                {date.endsWith("-01") ? (
                  <span className="mo">{shortMonthLabel(date.slice(0, 7))}</span>
                ) : null}
              </>
            }
          >
            {(byDay.get(date) ?? []).map((o) => {
              const chip = occurrenceChip(o, props.view);
              return (
                <MonthChip
                  key={occurrenceKey(o)}
                  color={chip.color}
                  title={o.name}
                  aside={chip.amount}
                  label={chip.label}
                  muted={chip.muted}
                  struck={chip.struck}
                  onClick={() => props.onOpen(o)}
                />
              );
            })}
          </DayCell>
        ))}
      </MonthGrid>
    </div>
  );
}
