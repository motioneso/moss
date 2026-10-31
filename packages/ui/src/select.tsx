import { ChevronDown } from "lucide-react";
import { type SelectHTMLAttributes } from "react";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Reads as text in a table cell until hover or focus shows the field. */
  readonly quiet?: boolean;
}

export function Select(props: SelectProps) {
  const { children, multiple, quiet, ...rest } = props;
  return (
    <span className={quiet ? "jds-selectwrap jds-selectwrap--quiet" : "jds-selectwrap"}>
      <select
        className={quiet ? "jds-select jds-select--quiet" : "jds-select"}
        multiple={multiple}
        {...rest}
      >
        {children}
      </select>
      {multiple ? null : (
        <span className="jds-selectwrap__chev">
          <ChevronDown size={16} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
