export type SegmentedOption<T extends string> =
  | T
  | {
      readonly value: T;
      readonly label: string;
      readonly disabled?: boolean;
      readonly title?: string;
    };

export type SegmentedTone = "default" | "field";

export interface SegmentedProps<T extends string> {
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
  readonly ariaLabel?: string;
  /** "field" sits on the forest masthead band. */
  readonly tone?: SegmentedTone;
}

export function Segmented<T extends string>(props: SegmentedProps<T>) {
  return (
    <div
      className={props.tone === "field" ? "jds-segmented jds-segmented--field" : "jds-segmented"}
      role="group"
      aria-label={props.ariaLabel}
    >
      {props.options.map((option) => {
        const value = (typeof option === "string" ? option : option.value) as T;
        const label = typeof option === "string" ? option : option.label;
        const disabled = typeof option === "string" ? undefined : option.disabled;
        const title = typeof option === "string" ? undefined : option.title;
        return (
          <button
            key={value}
            type="button"
            className="jds-segmented__opt"
            aria-pressed={props.value === value}
            disabled={disabled}
            title={title}
            onClick={() => props.onChange(value)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
