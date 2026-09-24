import {
  moodIndex,
  moodBand,
  type CheckinDto,
  type AdherenceDoseSummaryItemDto
} from "@moss/shared";
import { emoColor, MOOD_BAND_LABELS, type Theme } from "./emotion-taxonomy";
import { useState, useRef, useEffect, useLayoutEffect } from "react";

const VW = 760; // SVG viewBox width

export interface DayPoint {
  date: string;
  label: string;
  isToday: boolean;
  checkin: CheckinDto | null; // most-recent (color + feeling label)
  checkins: readonly CheckinDto[]; // all check-ins this day (for average)
  medFrac: number; // 0–1 adherence fraction
  medTaken: number;
  medDenom: number;
  doses?: readonly AdherenceDoseSummaryItemDto[];
}

interface Props {
  days: DayPoint[];
  theme?: Theme;
}

function HoverCols({
  n,
  left,
  right,
  vh,
  onHover,
  onClick
}: {
  n: number;
  left: number;
  right: number;
  vh: number;
  onHover: (i: number | null) => void;
  onClick: (i: number) => void;
}) {
  const plotW = VW - left - right;
  return (
    <g>
      {Array.from({ length: n }).map((_, i) => {
        const cx = left + ((i + 0.5) / n) * plotW;
        const w = plotW / n;
        return (
          <rect
            key={i}
            x={cx - w / 2}
            y={0}
            width={w}
            height={vh}
            fill="transparent"
            style={{ cursor: "pointer" }}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onClick(i)}
          />
        );
      })}
    </g>
  );
}

function avgMood(cks: readonly CheckinDto[]): number | null {
  if (cks.length === 0) return null;
  return (
    Math.round(
      (cks.reduce((s, ck) => s + moodIndex(ck.feelingCore, ck.intensity ?? 3), 0) / cks.length) * 10
    ) / 10
  );
}

export function WellnessChart({ days, theme = "light" }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const active = pinned != null ? pinned : hover;
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [days.length]);

  useEffect(() => {
    if (pinned === null) return;
    const handler = (ev: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(ev.target as Node)) {
        setPinned(null);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [pinned]);

  const left = 44;
  const right = 12;
  const moodTop = 16;
  const moodH = 148;
  const moodBot = moodTop + moodH;
  const divider = moodBot + 16;
  const markTop = divider + 9;
  const markMaxH = 22;
  const markBot = markTop + markMaxH;
  const markMid = markTop + markMaxH / 2;
  const H = markBot + 18;
  const plotW = VW - left - right;
  const n = days.length;

  const colW = plotW / n;

  const x = (i: number) => left + ((i + 0.5) / n) * plotW;
  const moodY = (v: number) => moodTop + (1 - (v + 5) / 10) * moodH;
  const labelStep = n <= 16 ? 2 : 5;
  const guides = [5, 2.5, 0, -2.5, -5];

  const pts = days
    .map((d, i) => {
      const v = avgMood(d.checkins);
      return v != null ? { i, xPos: x(i), v, d } : null;
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const linePath = pts.map((p, k) => `${k ? "L" : "M"}${p.xPos} ${moodY(p.v)}`).join(" ");

  const renderMark = (d: DayPoint, i: number) => {
    const cx = x(i);
    const { medFrac, isToday } = d;
    const dim = active != null && active !== i;
    const op = isToday ? 0.5 : 1;
    const pine = "var(--accent-fg)";
    let mark: React.ReactNode;

    if (medFrac <= 0) {
      mark = null;
    } else if (medFrac >= 0.999) {
      mark = <circle cx={cx} cy={markMid} r={3.7} fill={pine} opacity={op} />;
    } else {
      mark = (
        <circle cx={cx} cy={markMid} r={3.3} fill={pine} opacity={(0.34 + 0.4 * medFrac) * op} />
      );
    }
    return (
      <g key={`m${i}`} opacity={dim ? 0.34 : 1} style={{ transition: "opacity .12s" }}>
        {mark}
      </g>
    );
  };

  return (
    <div className="wl-chart__plot" ref={containerRef}>
      <svg
        viewBox={`0 0 ${VW} ${H}`}
        role="img"
        aria-label="Mood trend with daily medication adherence"
      >
        {guides.map((g) => (
          <line
            key={g}
            x1={left}
            y1={moodY(g)}
            x2={VW - right}
            y2={moodY(g)}
            stroke="var(--border)"
            strokeWidth="1"
            strokeDasharray={g === 0 ? "0" : "2 4"}
            opacity={g === 0 ? 1 : 0.7}
          />
        ))}
        <text x={left - 8} y={moodY(5) + 3} textAnchor="end" className="wl-axislbl">
          Bright
        </text>
        <text x={left - 8} y={moodY(0) + 3} textAnchor="end" className="wl-axislbl">
          Even
        </text>
        <text x={left - 8} y={moodY(-5) + 3} textAnchor="end" className="wl-axislbl">
          Heavy
        </text>

        {active != null ? (
          <rect
            x={x(active) - colW / 2}
            y={moodTop - 6}
            width={colW}
            height={H - moodTop}
            rx="5"
            fill="var(--surface-2)"
          />
        ) : null}

        <path
          d={linePath}
          fill="none"
          stroke="var(--text-faint)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {pts.map((p) => {
          const c = emoColor(p.d.checkin!.feelingCore, theme);
          const on = active === p.i;
          return (
            <circle
              key={p.i}
              cx={p.xPos}
              cy={moodY(p.v)}
              r={on ? 6 : 4.4}
              fill={c.tint}
              stroke="var(--surface)"
              strokeWidth="1.5"
              opacity={active == null || on ? 1 : 0.45}
              style={{ transition: "opacity .12s" }}
            />
          );
        })}

        <line
          x1={left}
          y1={divider}
          x2={VW - right}
          y2={divider}
          stroke="var(--border)"
          strokeWidth="1"
        />
        <text x={left - 8} y={markMid + 3} textAnchor="end" className="wl-axislbl wl-axislbl--med">
          Meds
        </text>

        {days.map((d, i) => renderMark(d, i))}

        {days.map((d, i) =>
          i % labelStep === 0 || d.isToday ? (
            <text key={`x${i}`} x={x(i)} y={H - 3} textAnchor="middle" className="wl-axislbl">
              {d.isToday ? "Today" : d.label}
            </text>
          ) : null
        )}

        <HoverCols
          n={n}
          left={left}
          right={right}
          vh={H}
          onHover={setHover}
          onClick={(i) => setPinned((p) => (p === i ? null : i))}
        />
      </svg>

      {active != null && days[active] != null
        ? (() => {
            const d = days[active]!;
            const hasCk = !!d.checkin;
            const v = avgMood(d.checkins);
            const c = hasCk ? emoColor(d.checkin!.feelingCore, theme) : null;
            const band = v != null ? moodBand(v) : null;
            const tipY = v != null ? moodY(v) : moodTop + 10;
            const isPinned = pinned === active;
            return (
              <div
                className={`wl-chart__tip is-on${isPinned ? " is-pinned" : ""}`}
                style={{
                  left: `${(x(active) / VW) * 100}%`,
                  top: `${(tipY / H) * 100}%`
                }}
              >
                <div className="d">{d.isToday ? `Today · ${d.label}` : d.label}</div>
                {hasCk && v != null && c && band ? (
                  <>
                    <div className="big" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span
                        className="sw"
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: 9,
                          background: c.tint
                        }}
                      />
                      {d.checkin!.feelingCore.charAt(0).toUpperCase() +
                        d.checkin!.feelingCore.slice(1)}
                      {d.checkin!.feelingSecondary ? ` · ${d.checkin!.feelingSecondary}` : ""}
                    </div>
                    <div className="wl-tiprow" style={{ justifyContent: "space-between" }}>
                      <span>Mood index</span>
                      <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                        {v > 0 ? "+" : ""}
                        {v} · {MOOD_BAND_LABELS[band] ?? band}
                      </strong>
                    </div>
                  </>
                ) : (
                  <div className="big">{d.isToday ? "No check-in yet" : "No check-in"}</div>
                )}
                <div className="wl-tipdiv" />
                <div className="wl-tiprow" style={{ justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.75 }}>Medication</span>
                  <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                    {d.medTaken}/{d.medDenom}
                    {d.isToday ? " so far" : " taken"}
                  </strong>
                </div>
                {d.doses && d.doses.filter((dos) => !dos.prn).length > 0
                  ? d.doses
                      .filter((dos) => !dos.prn)
                      .map((dos, j) => (
                        <div
                          key={j}
                          className="wl-tiprow"
                          style={{ opacity: dos.status === "taken" ? 1 : 0.5 }}
                        >
                          <span>{dos.name}</span>
                          <span style={{ textTransform: "capitalize" }}>{dos.status}</span>
                        </div>
                      ))
                  : null}
                {isPinned ? (
                  <div className="wl-tiprow wl-tiprow--more">Click the day again to dismiss</div>
                ) : null}
              </div>
            );
          })()
        : null}
    </div>
  );
}
