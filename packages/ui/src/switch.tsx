export interface SwitchProps {
  readonly ariaLabel: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onChange?: (checked: boolean) => void;
}

export function Switch(props: SwitchProps) {
  return (
    <label className="jds-switch">
      <input
        type="checkbox"
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        checked={props.checked}
        onChange={(event) => props.onChange?.(event.target.checked)}
      />
      <span className="jds-switch__track">
        <span className="jds-switch__thumb">
          {props.label ? (
            <span className="jds-switch__thumb-label" aria-hidden="true">
              {props.label}
            </span>
          ) : null}
        </span>
      </span>
    </label>
  );
}
