export interface RadioCardOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
}
export interface RadioCardGroupProps<T extends string> {
  readonly name: string;
  readonly ariaLabel: string;
  readonly value: T | null;
  readonly options: readonly RadioCardOption<T>[];
  readonly onChange: (value: T) => void;
}
export function RadioCardGroup<T extends string>({
  name,
  ariaLabel,
  value,
  options,
  onChange
}: RadioCardGroupProps<T>) {
  return (
    <div className="jds-radio-cards" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <label className="jds-radio-card" key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
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
