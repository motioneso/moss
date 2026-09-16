import {
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";

import type { LocaleSettingsDto, SportsBriefingEvidenceGameV1 } from "@moss/shared";

import { Button } from "@moss/ui";

import { formatDate } from "../locale/locale-format.js";

import { BriefingDialog } from "./briefing-dialog.js";
import { BRIEFING_TAB_LABEL, SCHEDULE_TOGGLE_LABEL } from "./today-labels.js";

export interface BriefingReportShellProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly opener: HTMLElement | null;
  readonly onClose: () => void;
  readonly reviewTabLabel: string;
  readonly onSelectReviewTab: (event: { currentTarget: HTMLElement }) => void;
  readonly selectedTab?: "briefing" | "review";
  readonly onSelectBriefingTab?: (event: { currentTarget: HTMLElement }) => void;
  readonly jumpLinks: ReactNode;
  readonly report: ReactNode;
  readonly railDateInput: string | Date;
  readonly locale: LocaleSettingsDto;
  readonly railHeading: string;
  readonly rail: ReactNode;
  readonly footerActions: ReactNode;
  readonly footerBack: ReactNode;
}

/** Branded morning-report chrome around caller-owned data: green header, real
    tablist, schedule rail with a phone disclosure, slotted footer. Either tab
    can own the panel; without the review props the briefing tab does, exactly
    as before. Nothing here fetches. */
export function BriefingReportShell(props: BriefingReportShellProps) {
  const briefingTabId = useId();
  const reviewTabId = useId();
  const reportPanelId = useId();
  const railRegionId = useId();
  const railDate = formatDate(props.railDateInput, props.locale, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
  const briefingTabRef = useRef<HTMLButtonElement | null>(null);
  const reviewTabRef = useRef<HTMLButtonElement | null>(null);
  // First-render media, never re-decided: desktop schedule beside the report, phone above it in DOM order.
  const [wide] = useState(
    () =>
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(min-width: 1081px)").matches
  );
  const [scheduleOpen, setScheduleOpen] = useState(wide);
  const reviewSelected = (props.selectedTab ?? "briefing") === "review";

  function onTablistKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const toBriefing = document.activeElement !== briefingTabRef.current;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      (toBriefing ? briefingTabRef : reviewTabRef).current?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? briefingTabRef : reviewTabRef).current?.focus();
    }
  }

  const schedule = (
    <div className="brief-reader__railwrap">
      <button
        type="button"
        className="brief-reader__schedule-toggle"
        aria-expanded={scheduleOpen}
        aria-controls={railRegionId}
        onClick={() => setScheduleOpen((open) => !open)}
      >
        {SCHEDULE_TOGGLE_LABEL}
      </button>
      <div className="brief-reader__rail" id={railRegionId} hidden={!scheduleOpen}>
        <p className="brief-reader__rail-date">{railDate}</p>
        <h3 className="brief-reader__rail-heading">{props.railHeading}</h3>
        {props.rail}
      </div>
    </div>
  );
  return (
    <BriefingDialog
      title={props.title}
      eyebrow={props.eyebrow}
      variant="report"
      opener={props.opener}
      onClose={props.onClose}
      nav={
        <div className="brief-reader__tabs">
          <div
            role="tablist"
            aria-label="Morning briefing views"
            onKeyDown={onTablistKeyDown}
            className="brief-reader__tablist"
          >
            <button
              type="button"
              role="tab"
              id={briefingTabId}
              aria-selected={!reviewSelected}
              aria-controls={reportPanelId}
              tabIndex={reviewSelected ? -1 : 0}
              ref={briefingTabRef}
              onClick={(event) => props.onSelectBriefingTab?.(event)}
              className={
                reviewSelected
                  ? "brief-reader__tab"
                  : "brief-reader__tab brief-reader__tab--selected"
              }
            >
              {BRIEFING_TAB_LABEL}
            </button>
            <button
              type="button"
              role="tab"
              id={reviewTabId}
              aria-selected={reviewSelected}
              aria-controls={reportPanelId}
              tabIndex={reviewSelected ? 0 : -1}
              ref={reviewTabRef}
              onClick={(event) => props.onSelectReviewTab(event)}
              className={
                reviewSelected
                  ? "brief-reader__tab brief-reader__tab--selected"
                  : "brief-reader__tab"
              }
            >
              {props.reviewTabLabel}
            </button>
          </div>
          {props.jumpLinks}
        </div>
      }
      footer={
        <>
          <div className="brief-reader__footer-actions">{props.footerActions}</div>
          <div className="brief-reader__footer-back">{props.footerBack}</div>
        </>
      }
    >
      <div className="brief-reader__grid">
        {!wide && schedule}
        <div
          role="tabpanel"
          id={reportPanelId}
          aria-labelledby={reviewSelected ? reviewTabId : briefingTabId}
          className="brief-reader__report"
        >
          {props.report}
        </div>
        {wide && schedule}
      </div>
    </BriefingDialog>
  );
}

export function EditorialBlock(props: {
  readonly id: string;
  readonly title: string;
  readonly games?: readonly SportsBriefingEvidenceGameV1[] | null;
  readonly stories: readonly {
    readonly title: string;
    readonly url: string;
    readonly imageUrl: string | null;
    readonly meta: string;
  }[];
  readonly onMoreOnToday: () => void;
}) {
  return (
    <section className="brief-reader__editorial" id={props.id} aria-label={props.title}>
      <div className="jds-brief__title">{props.title}</div>
      {props.games?.map((game) => (
        <div className="brief-reader__game" key={game.id}>
          <div className="loose-row__title">{game.headline}</div>
          <div className="loose-row__meta">
            {game.awayShort} {game.awayScore ?? ""} · {game.homeShort} {game.homeScore ?? ""} ·{" "}
            {game.statusDetail}
          </div>
        </div>
      ))}
      {props.stories.map((story) => (
        <article className="brief-reader__story" key={story.url}>
          {story.imageUrl ? (
            <img src={story.imageUrl} alt="" className="brief-reader__photo" loading="lazy" />
          ) : null}
          <a href={story.url} target="_blank" rel="noopener noreferrer">
            {story.title}
          </a>
          <div className="loose-row__meta">{story.meta}</div>
        </article>
      ))}
      <Button variant="quiet" size="sm" onClick={props.onMoreOnToday}>
        More on Today
      </Button>
    </section>
  );
}

export function readGaps(
  sourceMetadata: Record<string, unknown>
): readonly { source: string; reason: string }[] {
  const gaps = sourceMetadata.gaps;
  if (!Array.isArray(gaps)) return [];
  return gaps.flatMap((gap): readonly { source: string; reason: string }[] => {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) return [];
    const record = gap as Record<string, unknown>;
    if (typeof record.source !== "string" || typeof record.reason !== "string") return [];
    return [{ source: record.source, reason: record.reason }];
  });
}

export function readEditorial<T>(
  sourceMetadata: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T
): T | null {
  const editorial = sourceMetadata.editorial;
  if (!editorial || typeof editorial !== "object" || Array.isArray(editorial)) return null;
  const block = (editorial as Record<string, unknown>)[key];
  return guard(block) ? block : null;
}
