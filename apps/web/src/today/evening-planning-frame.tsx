import type { ReactNode } from "react";

import type { LocaleSettingsDto } from "@moss/shared";

import { formatDate } from "../locale/locale-format.js";

import { EVENING_PLAN_STEPS_LABEL, EVENING_RAIL_HEADING } from "./today-labels.js";

export const EVENING_STEP_IDS = ["reflect", "commitments", "shape", "review"] as const;

export type EveningStepId = (typeof EVENING_STEP_IDS)[number];

/** Numbered step strip: an ordered list of plain buttons, exactly one current. */
export function EveningStepStrip(props: {
  readonly names: readonly string[];
  readonly active: number;
  readonly onSelect: (index: number) => void;
}) {
  return (
    <nav className="evening-plan__strip" aria-label={EVENING_PLAN_STEPS_LABEL}>
      <ol>
        {props.names.map((name, index) => (
          <li key={name}>
            <button
              type="button"
              aria-current={index === props.active ? "step" : undefined}
              onClick={() => props.onSelect(index)}
            >
              <span>{`0${index + 1}`}</span> {name}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** One visible step: a region labelled by its heading, or named when the step
    has no heading yet. The region is the focus fallback after the heading. */
export function EveningStepPanel(props: {
  readonly stepId: EveningStepId;
  readonly headingId?: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="evening-plan__panel"
      role="region"
      id={`evening-panel-${props.stepId}`}
      tabIndex={-1}
      aria-labelledby={props.headingId}
      aria-label={props.headingId === undefined ? props.label : undefined}
    >
      {props.children}
    </div>
  );
}

/** Tomorrow rail: heading with the date, then the caller's disclosure. */
export function EveningRail(props: {
  readonly railDateInput: string;
  readonly locale: LocaleSettingsDto;
  readonly summary: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="evening-plan__railwrap">
      <p className="evening-plan__rail-date">
        {formatDate(props.railDateInput, props.locale, {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: "UTC"
        })}
      </p>
      <h3 className="evening-plan__rail-heading">{EVENING_RAIL_HEADING}</h3>
      <details
        className="evening-plan__details"
        ref={(node) => {
          if (!node || node.hasAttribute("data-evening-plan")) return;
          node.toggleAttribute("data-evening-plan", true);
          if (typeof window !== "undefined" && typeof window.matchMedia === "function")
            node.open = window.matchMedia("(min-width: 1081px)").matches;
        }}
      >
        <summary className="evening-plan__details-cap">{props.summary}</summary>
        {props.children}
      </details>
    </div>
  );
}
