import { ChevronDown } from "lucide-react";
import { type SelectHTMLAttributes } from "react";

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { children, multiple, ...rest } = props;
  return (
    <span className="jds-selectwrap">
      <select className="jds-select" multiple={multiple} {...rest}>
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
