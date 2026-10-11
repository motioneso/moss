import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent
} from "react";

import { Settings } from "lucide-react";

import type { AestheticThemeTokens } from "@moss/shared";
import { assistantName } from "../api/use-assistant-name.js";

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
  readonly themeId?: string;
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
        className="theme-pv jds-theme-scope"
        data-color-mode="light"
        data-theme={props.themeId ?? "custom-preview"}
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

export const THEME_READABILITY_PAIRS = [
  { id: "body-page", label: "Body text on the page", foreground: "--text", background: "--paper" },
  {
    id: "muted-card",
    label: "Muted text on cards",
    foreground: "--text-muted",
    background: "--surface"
  },
  {
    id: "faint-page",
    label: "Faint text on the page",
    foreground: "--text-faint",
    background: "--paper"
  },
  {
    id: "faint-card",
    label: "Faint text on cards",
    foreground: "--text-faint",
    background: "--surface"
  },
  {
    id: "faint-inset",
    label: "Faint text on soft cards",
    foreground: "--text-faint",
    background: "--surface-2"
  },
  {
    id: "faint-track",
    label: "Faint text on tracks",
    foreground: "--text-faint",
    background: "--surface-3"
  },
  {
    id: "accent-page",
    label: "Accent links on the page",
    foreground: "--accent-fg",
    background: "--paper"
  },
  {
    id: "primary-label",
    label: "Primary button labels",
    foreground: "--text-on-accent",
    background: "--btn-primary-bg"
  },
  {
    id: "hero-label",
    label: "Small text on the Today band",
    foreground: "--hero-fg",
    background: "--hero-bg"
  }
] as const;

export interface ReadabilityCheck {
  readonly id: string;
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number | null;
  readonly floor: number;
}

/** Read used colors, not aesthetic input values or unresolved custom-property strings. */
export function readRenderedThemeChecks(
  root: HTMLElement,
  readStyle: (
    element: Element
  ) => Pick<CSSStyleDeclaration, "color" | "backgroundColor"> = getComputedStyle
): ReadabilityCheck[] {
  return THEME_READABILITY_PAIRS.map((pair) => {
    const sample = root.querySelector(`[data-theme-contrast-sample="${pair.id}"]`);
    const style = sample ? readStyle(sample) : null;
    const foreground = style?.color ?? "";
    const background = style?.backgroundColor ?? "";
    return {
      id: pair.id,
      label: pair.label,
      foreground,
      background,
      ratio: readabilityContrastRatio(foreground, background),
      floor: 4.5
    };
  });
}

/** Custom themes always use the light semantic base, including drafts with dark paper. */
export function ThemeReadability(props: {
  readonly themeId: string;
  readonly style: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [checks, setChecks] = useState<ReadabilityCheck[]>([]);
  useEffect(() => {
    if (ref.current) setChecks(readRenderedThemeChecks(ref.current));
  }, [props.style, props.themeId]);
  return (
    <>
      <div
        ref={ref}
        className="theme-readability-samples jds-theme-scope"
        data-color-mode="light"
        data-theme={props.themeId ?? "custom-preview"}
        style={props.style}
        aria-hidden="true"
      >
        {THEME_READABILITY_PAIRS.map((pair) => (
          <span
            key={pair.id}
            data-theme-contrast-sample={pair.id}
            style={{ color: `var(${pair.foreground})`, backgroundColor: `var(${pair.background})` }}
          />
        ))}
      </div>
      <ReadabilityList checks={checks} />
    </>
  );
}

export function ReadabilityList(props: { readonly checks: readonly ReadabilityCheck[] }) {
  const unmeasured = props.checks.some((check) => check.ratio === null);
  const low = props.checks.some((check) => check.ratio !== null && check.ratio < check.floor);
  return (
    <div>
      <h4 className="theme-side__title">Can people read it?</h4>
      <p className="theme-side__hint">
        These checks sample normal-size text on the listed solid backgrounds. They do not cover
        every screen, hover, focus, overlay or disabled state. Warnings do not block saving or
        change your colors.
      </p>
      {props.checks.length === 0 ? <p role="status">Checking preview colors…</p> : null}
      {low || unmeasured ? (
        <p className="theme-side__hint" role="status">
          {low ? "Some sampled text is below the readability target. " : ""}
          {unmeasured ? "Transparent or unsupported colors could not be measured reliably. " : ""}
          You can still save this palette.
        </p>
      ) : null}
      <ul className="theme-checks">
        {props.checks.map((check) => {
          const ok = check.ratio !== null && check.ratio >= check.floor;
          return (
            <li
              key={check.id}
              data-theme-check={check.id}
              data-foreground={check.foreground}
              data-background={check.background}
            >
              <span>{check.label}</span>
              <span className={ok ? "theme-checks__ok" : "theme-checks__low"}>
                {check.ratio === null
                  ? "Not measured"
                  : `${ok ? "Meets" : "Below"} ${check.floor} to 1 target: ${check.ratio.toFixed(2)} to 1`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Opaque sRGB only; unknown/translucent colors must not receive a fabricated pass. */
export function readabilityContrastRatio(a: string, b: string): number | null {
  const parse = (value: string): number[] | null => {
    const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
    if (hex)
      return [0, 2, 4].map((offset) => parseInt(hex[1]!.slice(offset, offset + 2), 16) / 255);
    const rgb = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(
      value
    );
    const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i.exec(
      value
    );
    const match = rgb ?? srgb;
    if (!match || (match[4] !== undefined && Number(match[4]) !== 1)) return null;
    const channels = match.slice(1, 4).map((channel) => Number(channel) / (rgb ? 255 : 1));
    return channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)
      ? channels
      : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  const luminance = (channels: number[]) => {
    const linear = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    );
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const l1 = luminance(left);
  const l2 = luminance(right);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
