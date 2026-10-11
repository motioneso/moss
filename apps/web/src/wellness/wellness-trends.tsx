import { Button, SectionHead, Segmented } from "@moss/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  EMOTIONS,
  localDay,
  type CheckinDto,
  type DayAdherenceSummaryDto,
  type LocaleSettingsDto
} from "@moss/shared";
import { queryKeys } from "../api/query-keys";
import { listWellnessCheckins, getMedicationAdherenceSummary } from "../api/client";
import { formatDate, useUserLocale } from "../locale/locale-format";
import { emoColor, type Theme } from "./emotion-taxonomy";
import { WellnessChart, type DayPoint } from "./wellness-chart";
import { localDayOffset } from "./wellness-date-utils";

function TrendingUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}
function HelpCircleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function shortLabel(iso: string, locale: LocaleSettingsDto): string {
  // `iso` is a bare local calendar-day key (no wall-clock); anchor at midday UTC and
  // format in UTC so the user's region localises the month name without shifting the day.
  return formatDate(
    iso + "T12:00:00Z",
    { ...locale, timezone: "UTC" },
    {
      month: "short",
      day: "numeric"
    }
  );
}

interface Props {
  theme?: Theme;
}

export function WellnessTrends({ theme = "light" }: Props) {
  const locale = useUserLocale();
  const [range, setRange] = useState<14 | 30>(30);
  const [helpOpen, setHelpOpen] = useState(false);

  const checkinsQuery = useQuery({
    queryKey: [...queryKeys.wellness.checkins, range],
    queryFn: () => listWellnessCheckins(range * 3) // over-fetch; we filter by date below
  });
  const adherenceQuery = useQuery({
    queryKey: queryKeys.wellness.adherenceSummary(range),
    queryFn: () => getMedicationAdherenceSummary(range)
  });

  const checkins = checkinsQuery.data?.checkins ?? [];

  // Build adherence lookup by date
  const summaryByDate: Record<string, DayAdherenceSummaryDto> = {};
  (adherenceQuery.data?.days ?? []).forEach((d) => {
    summaryByDate[d.date] = d;
  });

  // Build checkin lookup by date (all check-ins per day; list is newest-first)
  const checkinsByDate: Record<string, CheckinDto[]> = {};
  checkins.forEach((c) => {
    const d = localDay(c.checkedInAt ?? c.createdAt ?? "", locale.timezone);
    if (!d) return;
    (checkinsByDate[d] ??= []).push(c);
  });

  const todayStr = localDayOffset(0, locale.timezone);

  const days: DayPoint[] = Array.from({ length: range }, (_, i) => {
    const iso = localDayOffset(range - 1 - i, locale.timezone, todayStr);
    const summary = summaryByDate[iso] ?? null;
    return {
      date: iso,
      label: shortLabel(iso, locale),
      isToday: iso === todayStr,
      checkin: (checkinsByDate[iso] ?? [])[0] ?? null,
      checkins: checkinsByDate[iso] ?? [],
      medFrac:
        summary && summary.scheduledCount > 0 ? summary.takenCount / summary.scheduledCount : 0,
      medTaken: summary?.takenCount ?? 0,
      medDenom: summary?.scheduledCount ?? 0,
      doses: summary?.doses ?? []
    };
  });

  return (
    <section className="wl-sec">
      <SectionHead
        number="03"
        title="Trends"
        meta={
          <Segmented
            ariaLabel="Chart range"
            value={String(range)}
            options={[
              { value: "14", label: "14 days" },
              { value: "30", label: "30 days" }
            ]}
            onChange={(value) => setRange(value === "14" ? 14 : 30)}
          />
        }
      />

      {checkinsQuery.isError || adherenceQuery.isError ? (
        <p role="status">
          Couldn&apos;t refresh trend data.{" "}
          <Button
            variant="link"
            onClick={() => {
              void checkinsQuery.refetch();
              void adherenceQuery.refetch();
            }}
          >
            Try again
          </Button>
        </p>
      ) : null}
      {!checkinsQuery.data || !adherenceQuery.data ? (
        <div className="wl-chartcard" style={{ padding: "16px 20px" }}>
          <span className="wl-subtle-text" role="status">
            {checkinsQuery.isPending || adherenceQuery.isPending
              ? "Loading trend data…"
              : "Trend data unavailable."}
          </span>
        </div>
      ) : (
        <div className="wl-chartcard">
          <div className="wl-chart__hd">
            <div>
              <div className="wl-chart__title">
                <span className="ic">
                  <TrendingUpIcon />
                </span>
                Mood &amp; medication
                <span className="wl-help">
                  <button
                    type="button"
                    className={`wl-help__btn${helpOpen ? " is-on" : ""}`}
                    aria-label="How to read this chart"
                    aria-expanded={helpOpen}
                    onClick={() => setHelpOpen((o) => !o)}
                  >
                    <HelpCircleIcon />
                  </button>
                  {helpOpen ? (
                    <>
                      <div className="wl-help__scrim" onClick={() => setHelpOpen(false)} />
                      <div className="wl-help__pop" role="dialog">
                        <div className="wl-help__row">
                          <span className="wl-help__k">Mood line</span>
                          <span className="wl-help__v">
                            Each check-in becomes a number from <strong>Heavy</strong> (−5) to{" "}
                            <strong>Bright</strong> (+5). The dot&apos;s color is the emotion you
                            logged.
                          </span>
                        </div>
                        <div className="wl-help__row">
                          <span className="wl-help__k">Meds dots</span>
                          <span className="wl-help__v">
                            One dot per day for how much of your regimen you logged. Hover any day
                            for the full list.
                          </span>
                        </div>
                      </div>
                    </>
                  ) : null}
                </span>
              </div>
            </div>
            <div className="wl-chart__legend">
              {EMOTIONS.map((em) => {
                const c = emoColor(em.core, theme);
                return (
                  <span key={em.core} className="wl-leg">
                    <span
                      className="wl-leg__dot"
                      style={{ "--em-tint": c.tint } as React.CSSProperties}
                    />
                    {em.core.charAt(0).toUpperCase() + em.core.slice(1)}
                  </span>
                );
              })}
            </div>
          </div>
          <WellnessChart days={days} theme={theme} />
        </div>
      )}
    </section>
  );
}
