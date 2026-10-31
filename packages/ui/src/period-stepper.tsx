import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode } from "react";

import { IconButton } from "./icon-button.js";

export interface PeriodStepperProps {
  /* The period on show, such as "October 2026". */
  readonly label: ReactNode;
  /* Accessible names for the arrows, such as the period each one opens. */
  readonly previousLabel: string;
  readonly nextLabel: string;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

/* Steps back and forward through months or weeks. Inside a field masthead the arrows take the
   masthead's ink. */
export function PeriodStepper(props: PeriodStepperProps) {
  const classes = ["jds-stepper", props.className ?? null].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <IconButton
        size="sm"
        aria-label={props.previousLabel}
        disabled={props.disabled}
        onClick={props.onPrevious}
      >
        <ChevronLeft aria-hidden="true" />
      </IconButton>
      <span className="jds-stepper__label" aria-live="polite">
        {props.label}
      </span>
      <IconButton
        size="sm"
        aria-label={props.nextLabel}
        disabled={props.disabled}
        onClick={props.onNext}
      >
        <ChevronRight aria-hidden="true" />
      </IconButton>
    </div>
  );
}
