// external-modules/finance/src/web/register-filters.tsx
//
// Transactions filters. The panel opens from the toolbar's Filters button; while it is closed,
// active filters show as removable chips.
import { Button, Chip, Select, useRef, type ReactNodeLike } from "@moss/module-web-sdk";

export interface RegisterFilters {
  accountId: string;
  categoryId: string;
  postingState: "" | "pending" | "posted";
  direction: "" | "inflow" | "outflow";
  ledgerState: "" | "uncleared" | "cleared" | "reconciled";
  attention: "" | "uncategorized" | "duplicates";
}

export const EMPTY_FILTERS: RegisterFilters = {
  accountId: "",
  categoryId: "",
  postingState: "",
  direction: "",
  ledgerState: "",
  attention: ""
};

export const REGISTER_FILTERS_ID = "finance-register-filters";

export function filterInput(filters: RegisterFilters): Record<string, unknown> {
  return {
    ...(filters.accountId ? { accountId: filters.accountId } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.postingState ? { postingState: filters.postingState } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
    ...(filters.ledgerState ? { ledgerState: filters.ledgerState } : {}),
    ...(filters.attention === "uncategorized" ? { uncategorizedOnly: true } : {}),
    ...(filters.attention === "duplicates" ? { duplicatesOnly: true } : {})
  };
}

export const activeFilterCount = (filters: RegisterFilters): number =>
  Object.values(filters).filter(Boolean).length;

interface FilterOptions {
  accounts: { accountId: string; name: string }[];
  categories: { id: string; name: string }[];
}

interface FilterField {
  key: keyof RegisterFilters;
  label: string;
  /** Names the filter in its select and in the chip's remove button. */
  noun: string;
  all: string;
  options: (lists: FilterOptions) => { value: string; label: string }[];
}

const FIELDS: FilterField[] = [
  {
    key: "accountId",
    label: "Account",
    noun: "account",
    all: "All accounts",
    options: (lists) => lists.accounts.map((a) => ({ value: a.accountId, label: a.name }))
  },
  {
    key: "categoryId",
    label: "Category",
    noun: "category",
    all: "All categories",
    options: (lists) => lists.categories.map((c) => ({ value: c.id, label: c.name }))
  },
  {
    key: "postingState",
    label: "Status",
    noun: "posting status",
    all: "All statuses",
    options: () => [
      { value: "pending", label: "Pending" },
      { value: "posted", label: "Posted" }
    ]
  },
  {
    key: "direction",
    label: "Direction",
    noun: "money direction",
    all: "All directions",
    options: () => [
      { value: "inflow", label: "Money in" },
      { value: "outflow", label: "Money out" }
    ]
  },
  {
    key: "ledgerState",
    label: "Manual ledger status",
    noun: "manual ledger status",
    all: "All ledger statuses",
    options: () => [
      { value: "uncleared", label: "Uncleared" },
      { value: "cleared", label: "Cleared" },
      { value: "reconciled", label: "Reconciled" }
    ]
  },
  {
    key: "attention",
    label: "Check",
    noun: "transaction check",
    all: "All transactions",
    options: () => [
      { value: "uncategorized", label: "Uncategorized" },
      { value: "duplicates", label: "Possible duplicates" }
    ]
  }
];

export function RegisterFilterPanel(
  props: FilterOptions & {
    value: RegisterFilters;
    onChange: (value: RegisterFilters) => void;
    /** Moves focus to the Filters button when Clear filters removes the focused control. */
    returnFocus?: () => void;
  }
): ReactNodeLike {
  return (
    <div id={REGISTER_FILTERS_ID} className="fnm-register-filters" aria-label="Transaction filters">
      {FIELDS.map((field) => (
        <label key={field.key} className="fnm-block fnm-block--tight">
          {field.label}
          <Select
            value={props.value[field.key]}
            aria-label={`Filter by ${field.noun}`}
            onChange={(event: { target: { value: string } }) =>
              props.onChange({ ...props.value, [field.key]: event.target.value })
            }
          >
            <option value="">{field.all}</option>
            {field.options(props).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      ))}
      {activeFilterCount(props.value) > 0 ? (
        <div>
          <Button
            variant="link"
            onClick={() => {
              props.returnFocus?.();
              props.onChange(EMPTY_FILTERS);
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Active filters while the panel is closed. Renders nothing when no filter is set. */
export function RegisterFilterChips(
  props: FilterOptions & {
    value: RegisterFilters;
    onChange: (value: RegisterFilters) => void;
    ownOnly: boolean;
    onIncludeShared: () => void;
    /** Moves focus to the Filters button when no chip is left to take it. */
    returnFocus?: () => void;
  }
): ReactNodeLike {
  const row = useRef<HTMLDivElement | null>(null);
  const active = FIELDS.filter((field) => props.value[field.key] !== "");
  if (active.length === 0 && !props.ownOnly) return null;
  // The removed chip's button unmounts, so focus moves to the next chip (else the previous one)
  // first. Chip buttons are the ones with an aria-label; Clear filters is named by its text.
  const remove = (index: number, apply: () => void) => {
    const buttons = row.current?.querySelectorAll<HTMLButtonElement>("button[aria-label]");
    const neighbour = buttons?.[index + 1] ?? buttons?.[index - 1];
    if (neighbour) neighbour.focus();
    else props.returnFocus?.();
    apply();
  };
  const first = props.ownOnly ? 1 : 0;
  return (
    <div ref={row} className="fnm-chips" aria-label="Active filters">
      {props.ownOnly ? (
        <Chip
          onRemove={() => remove(0, props.onIncludeShared)}
          removeLabel="Include shared records"
        >
          Your entries only
        </Chip>
      ) : null}
      {active.map((field, index) => {
        const value = props.value[field.key];
        const label =
          field.options(props).find((option) => option.value === value)?.label ?? field.label;
        return (
          <Chip
            key={field.key}
            onRemove={() =>
              remove(first + index, () => props.onChange({ ...props.value, [field.key]: "" }))
            }
            removeLabel={`Remove ${field.noun} filter ${label}`}
          >
            {label}
          </Chip>
        );
      })}
      {active.length > 1 ? (
        <Button
          variant="link"
          onClick={() => {
            props.returnFocus?.();
            props.onChange(EMPTY_FILTERS);
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
