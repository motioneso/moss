import { Check } from "lucide-react";
import type { ReactNode } from "react";
export interface CheckboxProps {
  readonly ariaLabel: string;
  readonly label?: ReactNode;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}
/** A native, keyboard-operable selection control using the authored check treatment. */
export function Checkbox(props: CheckboxProps) {
  return (
    <label className="jds-check jds-checkbox">
      <input
        type="checkbox"
        aria-label={props.ariaLabel}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="jds-check__box" aria-hidden="true">
        <Check />
      </span>
      {props.label ? <span>{props.label}</span> : null}
    </label>
  );
}
