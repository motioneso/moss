import {
  Button,
  DisclosureToggle,
  Select,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";

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

export function RegisterFilterBar(props: {
  value: RegisterFilters;
  onChange: (value: RegisterFilters) => void;
  accounts: { accountId: string; name: string }[];
  categories: { id: string; name: string }[];
}): ReactNodeLike {
  const [expanded, setExpanded] = useState(false);
  const active = Object.values(props.value).filter(Boolean).length;
  const update = (key: keyof RegisterFilters, value: string): void =>
    props.onChange({ ...props.value, [key]: value });
  return (
    <div className="fnm-block fnm-block--tight">
      <div className="fnm-phone-only">
        <DisclosureToggle
          expanded={expanded}
          controls="finance-register-filters"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide filters" : "Show filters"}
          {active ? ` · ${active} active` : ""}
        </DisclosureToggle>
      </div>
      <div
        id="finance-register-filters"
        className="fnm-register-filters"
        data-expanded={expanded}
        aria-label="Transaction filters"
      >
        <label className="fnm-block fnm-block--tight">
          Account
          <Select
            value={props.value.accountId}
            aria-label="Filter by account"
            onChange={(event: { target: { value: string } }) =>
              update("accountId", event.target.value)
            }
          >
            <option value="">All accounts</option>
            {props.accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="fnm-block fnm-block--tight">
          Category
          <Select
            value={props.value.categoryId}
            aria-label="Filter by category"
            onChange={(event: { target: { value: string } }) =>
              update("categoryId", event.target.value)
            }
          >
            <option value="">All categories</option>
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="fnm-block fnm-block--tight">
          Status
          <Select
            value={props.value.postingState}
            aria-label="Filter by posting status"
            onChange={(event: { target: { value: string } }) =>
              update("postingState", event.target.value)
            }
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="posted">Posted</option>
          </Select>
        </label>
        <label className="fnm-block fnm-block--tight">
          Direction
          <Select
            value={props.value.direction}
            aria-label="Filter by money direction"
            onChange={(event: { target: { value: string } }) =>
              update("direction", event.target.value)
            }
          >
            <option value="">All directions</option>
            <option value="inflow">Money in</option>
            <option value="outflow">Money out</option>
          </Select>
        </label>
        <label className="fnm-block fnm-block--tight">
          Manual ledger status
          <Select
            value={props.value.ledgerState}
            aria-label="Filter by manual ledger status"
            onChange={(event: { target: { value: string } }) =>
              update("ledgerState", event.target.value)
            }
          >
            <option value="">All ledger statuses</option>
            <option value="uncleared">Uncleared</option>
            <option value="cleared">Cleared</option>
            <option value="reconciled">Reconciled</option>
          </Select>
        </label>
        <label className="fnm-block fnm-block--tight">
          Check
          <Select
            value={props.value.attention}
            aria-label="Filter by transaction check"
            onChange={(event: { target: { value: string } }) =>
              update("attention", event.target.value)
            }
          >
            <option value="">All transactions</option>
            <option value="uncategorized">Uncategorized</option>
            <option value="duplicates">Possible duplicates</option>
          </Select>
        </label>
        {Object.values(props.value).some(Boolean) ? (
          <Button variant="link" onClick={() => props.onChange(EMPTY_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
