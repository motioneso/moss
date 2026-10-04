import { useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";

import { Settings } from "lucide-react";

import type { AestheticThemeTokens } from "@moss/shared";
import { assistantName } from "../api/use-assistant-name";

export type EditorTokenKey = keyof AestheticThemeTokens;

/* Each clickable part of the preview and the field that paints it. */
export const PREVIEW_PARTS = {
  nav: { key: "nav", label: "Nav bar" },
  header: { key: "header", label: "Page header" },
  page: { key: "paper", label: "Page" },
  band: { key: "accent", label: "Accent" },
  rule: { key: "highlight", label: "Highlight" },
  title: { key: "ink", label: "Text" },
  time: { key: "accent", label: "Accent" },
  meta: { key: "ink2", label: "Soft text" },
  card: { key: "surface", label: "Card" },
  button: { key: "accent", label: "Accent" }
} as const satisfies Record<string, { key: EditorTokenKey; label: string }>;

export type PreviewPart = keyof typeof PREVIEW_PARTS;

const CLICK_HINT = "Click any part to change its color.";

/* A small Today screen in the draft colors. Mouse only: every part it can
   open has a color box in the editor, which is the keyboard path. */
export function ThemePreview(props: {
  readonly style: CSSProperties;
  readonly openPart: PreviewPart | null;
  readonly onPick: (part: PreviewPart, anchor: HTMLElement) => void;
}) {
  const [hot, setHot] = useState<PreviewPart | null>(null);

  const partAt = (event: MouseEvent): [PreviewPart, HTMLElement] | null => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-part]");
    const part = el?.dataset.part as PreviewPart | undefined;
    return el && part && part in PREVIEW_PARTS ? [part, el] : null;
  };
  const part = (id: PreviewPart, className: string) => ({
    "data-part": id,
    className: [className, hot === id && "is-hot", props.openPart === id && "is-open"]
      .filter(Boolean)
      .join(" ")
  });

  return (
    <div>
      <h4 className="theme-side__title">Preview</h4>
      <p className="theme-side__hint" aria-live="polite">
        {hot ? `Click to change ${PREVIEW_PARTS[hot].label}` : CLICK_HINT}
      </p>
      <div
        className="theme-pv"
        style={props.style}
        aria-hidden="true"
        onClick={(event) => {
          const hit = partAt(event);
          if (hit) props.onPick(hit[0], hit[1]);
        }}
        onPointerOver={(event: PointerEvent) => {
          if (event.pointerType === "mouse") setHot(partAt(event)?.[0] ?? null);
        }}
        onPointerLeave={() => setHot(null)}
      >
        <div {...part("nav", "theme-pv__nav")}>
          <span className="theme-pv__brand">{assistantName()}</span>
          <span className="theme-pv__link is-active">Today</span>
          <span className="theme-pv__link">The Workshop</span>
          <span className="theme-pv__link">Tasks</span>
          <span className="theme-pv__link">Calendar</span>
          <span className="theme-pv__link">News</span>
        </div>
        <div className="theme-pv__col">
          <div {...part("header", "theme-pv__header")}>
            <span className="theme-pv__header-title">Today</span>
            <span className="theme-pv__header-date">Sun, Oct 4</span>
            <span className="theme-pv__header-cog">
              <Settings size={11} />
            </span>
          </div>
          <div {...part("page", "theme-pv__main")}>
            <div>
              <div {...part("band", "theme-pv__band")}>
                <div className="theme-pv__eyebrow">Good morning</div>
                <p className="theme-pv__headline">
                  A clear run
                  <br />
                  to lunch
                </p>
                <p className="theme-pv__summary">Two meetings, one errand, nothing overdue.</p>
              </div>
              <div {...part("rule", "theme-pv__rule")} />
            </div>
            <div className="theme-pv__head">
              <span className="theme-pv__num">01</span>
              <span {...part("title", "theme-pv__title")}>Your day, laid out</span>
            </div>
            <div>
              <PreviewRow time="9:00" title="Morning review" meta="30 minutes" part={part} />
              <PreviewRow time="2:30 pm" title="Call the vet" meta="Task, due today" part={part} />
            </div>
            <div {...part("card", "theme-pv__card")}>
              <span>
                Medications <span className="theme-pv__meta">0 of 1 logged</span>
              </span>
              <span {...part("button", "theme-pv__button")}>Check in</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewRow(props: {
  readonly time: string;
  readonly title: string;
  readonly meta: string;
  readonly part: (id: PreviewPart, className: string) => object;
}) {
  return (
    <div className="theme-pv__row">
      <span {...props.part("time", "theme-pv__time")}>{props.time}</span>
      <span>
        {props.title}
        <br />
        <span {...props.part("meta", "theme-pv__meta")}>{props.meta}</span>
      </span>
    </div>
  );
}

interface ReadabilityCheck {
  readonly label: string;
  readonly ratio: number;
  readonly floor: number;
}

/* Each pairing in words: "Reads well, 6.2 to 1" or "Faint, 2.1 to 1. Aim for 3 to 1". */
export function ReadabilityList(props: { readonly checks: readonly ReadabilityCheck[] }) {
  return (
    <div>
      <h4 className="theme-side__title">Can people read it?</h4>
      <ul className="theme-checks">
        {props.checks.map((check) => {
          const ok = check.ratio >= check.floor;
          return (
            <li key={check.label}>
              <span>{check.label}</span>
              <span className={ok ? "theme-checks__ok" : "theme-checks__low"}>
                {ok
                  ? `Reads well, ${check.ratio.toFixed(1)} to 1`
                  : `Faint, ${check.ratio.toFixed(1)} to 1. Aim for ${check.floor} to 1`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
