export interface RadioCardOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}
export interface RadioCardGroupProps<T extends string> {
  readonly name: string;
  readonly ariaLabel: string;
  readonly value: T | null;
  readonly options: readonly RadioCardOption<T>[];
  readonly disabled?: boolean;
  readonly onChange: (value: T) => void;
}
export function RadioCardGroup<T extends string>({
  name,
  ariaLabel,
  value,
  options,
  disabled,
  onChange
}: RadioCardGroupProps<T>) {
  return (
    <div
      className="jds-radio-cards"
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
    >
      {options.map((option) => (
        <label className="jds-radio-card" key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="jds-radio-card__label">{option.label}</span>
          {option.description ? (
            <span className="jds-radio-card__description">{option.description}</span>
          ) : null}
        </label>
      ))}
    </div>
  );
}
