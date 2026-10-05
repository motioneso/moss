import { type ReactNode } from "react";
export interface TabsItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number | string;
  readonly content: ReactNode;
}
export interface TabsProps<T extends string> {
  readonly id: string;
  readonly ariaLabel: string;
  readonly value: T;
  readonly items: readonly TabsItem<T>[];
  readonly onChange: (value: T) => void;
}
/** Panels stay mounted so switching sections preserves unsaved forms and focus state. */
export function Tabs<T extends string>({ id, ariaLabel, value, items, onChange }: TabsProps<T>) {
  return (
    <div className="jds-tabs__root">
      <div className="jds-tabs__list" role="tablist" aria-label={ariaLabel}>
        {items.map((item, index) => (
          <button
            key={item.value}
            type="button"
            className="jds-tabs__tab"
            id={`${id}-tab-${item.value}`}
            role="tab"
            aria-selected={value === item.value}
            aria-controls={`${id}-panel-${item.value}`}
            tabIndex={value === item.value ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % items.length
                  : event.key === "ArrowLeft"
                    ? (index + items.length - 1) % items.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              const option = items[next];
              if (!option) return;
              onChange(option.value);
              const buttons =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]'
                );
              buttons?.[next]?.focus();
            }}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className="jds-tabs__count">{item.count}</span>
            ) : null}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <div
          key={item.value}
          className="jds-tabs__panel"
          id={`${id}-panel-${item.value}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${item.value}`}
          hidden={value !== item.value}
        >
          {item.content}
        </div>
      ))}
    </div>
  );
}
