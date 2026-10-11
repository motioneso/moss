import { Button, DisclosureToggle, IconButton, SectionHead } from "@moss/ui";
import { useState } from "react";
import { localDay, moodIndex, moodBand, type CheckinDto } from "@moss/shared";
import { emoColor, MOOD_BAND_LABELS, coreLabel, type Theme } from "./emotion-taxonomy";
import { formatDate, formatTime, useUserLocale } from "../locale/locale-format";

function ChevRightIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
function NotebookPenIcon() {
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
      <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" />
      <path d="M2 6h4" />
      <path d="M2 10h4" />
      <path d="M2 14h4" />
      <path d="M2 18h4" />
      <path d="m21.378 3.626-1.004-1.004a2.121 2.121 0 0 0-3 0l-5.37 5.374 2 2 5.37-5.374" />
    </svg>
  );
}
function SmallXIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

interface Props {
  checkins: readonly CheckinDto[];
  theme?: Theme;
  filter?: "notes" | null;
  onClearFilter: () => void;
  onEdit: (id: string) => void;
  /** IANA timezone from user locale settings. Defaults to browser timezone when absent. */
  timezone?: string;
}

export function WellnessHistory({
  checkins,
  theme = "light",
  filter,
  onClearFilter,
  onEdit,
  timezone
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [limit, setLimit] = useState(8);
  const locale = useUserLocale();
  // The weekday/month/day come from the already-localized calendar-date string via a
  // noon-UTC anchor, so format them with timeZone forced to UTC (user region drives the
  // month/weekday *names*) to read those exact components back without an anchor misfire.
  const calendarLocale = { ...locale, timezone: "UTC" };

  const today = localDay(new Date(), timezone);

  let rows = checkins.slice().sort((a, b) => {
    const da = a.checkedInAt ?? a.createdAt ?? "";
    const db = b.checkedInAt ?? b.createdAt ?? "";
    return db < da ? -1 : 1;
  });

  if (filter === "notes") {
    rows = rows.filter((c) => c.note && (c.feelingCore === "sad" || c.feelingCore === "anger"));
  }

  const shown = rows.slice(0, limit);

  return (
    <section className="wl-sec">
      <SectionHead
        number="04"
        title="Check-in history"
        meta={
          <>
            {filter === "notes" ? (
              <span className="wl-filter-pill">
                Noted sad / angry check-ins
                <IconButton aria-label="Clear filter" onClick={onClearFilter}>
                  <SmallXIcon />
                </IconButton>
              </span>
            ) : (
              <span className="wl-sec__note">Tap a row to read &amp; edit</span>
            )}
          </>
        }
      />
      <div className="wl-history">
        {shown.length === 0 ? (
          <div className="wl-history__empty">
            {filter ? "No check-ins match." : "Your check-ins will appear here."}
          </div>
        ) : null}
        {shown.map((ck) => {
          const fullIso = ck.checkedInAt ?? ck.createdAt ?? "";
          const iso = fullIso ? localDay(fullIso, timezone) : "";
          const isToday = iso === today;
          // `iso` is already the local calendar date, so format weekday/month/day with
          // timeZone: "UTC" on a noon-UTC anchor of that date string — this gives the
          // correct calendar components for ANY IANA timezone without an anchor misfire.
          const anchor = new Date(iso + "T12:00:00Z");
          const dow = isToday ? "Today" : formatDate(anchor, calendarLocale, { weekday: "long" });
          const mo = formatDate(anchor, calendarLocale, { month: "short" });
          const day = formatDate(anchor, calendarLocale, { day: "numeric" });
          const timeStr =
            isToday && fullIso.length > 10
              ? formatTime(fullIso, locale, { hour: "numeric", minute: "2-digit" })
              : null;
          const c = emoColor(ck.feelingCore, theme);
          const v = moodIndex(ck.feelingCore, ck.intensity ?? 3);
          const band = moodBand(v);
          const isOpen = openId === ck.id;

          return (
            <div key={ck.id} className={`wl-hrow${isOpen ? " is-open" : ""}`}>
              <DisclosureToggle
                expanded={isOpen}
                controls={`checkin-${ck.id}`}
                className="wl-hrow__head"
                onClick={() => setOpenId(isOpen ? null : ck.id)}
              >
                <span className="wl-hrow__date">
                  <span className="dow">{dow}</span>
                  {isToday && timeStr ? (
                    <span className="md"> {timeStr}</span>
                  ) : (
                    <span className="md">
                      {" "}
                      {mo} {day}
                    </span>
                  )}
                </span>
                <span
                  className="wl-hrow__emo"
                  style={{ "--em-tint": c.tint, "--em-ink": c.ink } as React.CSSProperties}
                >
                  <span className="d" />
                  <span className="nm">{coreLabel(ck.feelingCore)}</span>
                </span>
                <span className="wl-hrow__feel">{ck.feelingSecondary}</span>
                <span className="wl-hrow__meta">
                  {ck.note ? (
                    <span className="wl-hrow__note" title="Has a note">
                      <NotebookPenIcon />
                    </span>
                  ) : null}
                  <span
                    className={`wl-hrow__mood ${v > 0 ? "wl-hrow__mood--pos" : v < 0 ? "wl-hrow__mood--neg" : "wl-hrow__mood--neutral"}`}
                  >
                    {v > 0 ? "+" : ""}
                    {v}
                  </span>
                  <span className="wl-hrow__chev">
                    <ChevRightIcon />
                  </span>
                </span>
              </DisclosureToggle>
              {isOpen ? (
                <div
                  id={`checkin-${ck.id}`}
                  className="wl-hdetail"
                  style={{ "--em-tint": c.tint } as React.CSSProperties}
                >
                  {ck.sensations && (ck.sensations as string[]).length > 0 ? (
                    <div className="wl-hdetail__sens">
                      <span className="wl-hdetail__lbl">Sensations</span>
                      {(ck.sensations as string[]).map((s) => (
                        <span key={s} className="wl-sentag">
                          {s}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {ck.note ? (
                    <div className="wl-hdetail__note">{ck.note}</div>
                  ) : (
                    <div className="wl-hdetail__empty">No note on this one.</div>
                  )}
                  <div className="wl-hdetail__foot">
                    <span className="wl-hdetail__time">
                      Intensity {ck.intensity ?? "—"}/5 &middot; mood {v > 0 ? "+" : ""}
                      {v} &middot; {MOOD_BAND_LABELS[band] ?? band}
                    </span>
                    <span style={{ flex: 1 }} />
                    <Button variant="secondary" size="sm" onClick={() => onEdit(ck.id)}>
                      <PencilIcon />
                      Edit
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {rows.length > limit ? (
        <div className="wl-history__more">
          <Button variant="secondary" size="sm" onClick={() => setLimit((l) => l + 10)}>
            Show {Math.min(10, rows.length - limit)} more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
