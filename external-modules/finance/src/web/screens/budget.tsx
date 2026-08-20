// external-modules/finance/src/web/screens/budget.tsx
// FIN-03 (#1148) Task 4: the envelope budget screen. One read
// (finance.budget.status returns the month's derived state + the taxonomy);
// the only write is assign → the finance.budget-apply queue with metadata-only
// params {month, categoryId, amountCents} (D6 carve-out: small command
// params). Queue runs are fire-and-forget 202s, so an assign pairs an
// optimistic local override (assigned + available + TBB shift in-render) with
// the feed's delayed invalidate-and-refetch idiom; the refetched state carries
// the worker's ledger write and the override becomes a harmless same-value.
import { Badge, Button, Card, useState, type ReactNodeLike } from "@moss/module-web-sdk";
import { runQueue, type RunOutcome } from "../api";
import {
  centsToAmountInput,
  currentMonth,
  formatCents,
  monthLabel,
  parseAmountToCents,
  shiftMonth
} from "../format";
import { announce, EmptyState, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";

interface BudgetCategory {
  id: string;
  group: string;
  name: string;
  archived?: boolean;
}

interface BudgetCategoryState {
  assignedCents: number;
  activityCents: number;
  availableCents: number;
}

interface BudgetMonthState {
  computedAt: string;
  tbbCents: number;
  categories: Record<string, BudgetCategoryState>;
}

interface BudgetStatusResult extends Record<string, unknown> {
  month: string;
  state?: BudgetMonthState;
  categories?: BudgetCategory[];
}

const REFETCH_DELAY_MS = 2000;

// Budget amounts render in the module's single working currency. The derived
// state carries integer cents with no currency (accounts each carry their own
// isoCurrency, but assignment ledgers merge them) — a deliberate v1
// single-currency assumption; mixed-currency handling is FIN-05 reports
// territory (#1150).
const BUDGET_CURRENCY = "USD";

// Taxonomy groups that get budget rows, in display order. `income` is
// intentionally absent (income is not budgeted — it IS the TBB headline) and
// so is `transfers` (the derivation excludes transfers from activity).
const BUDGET_GROUPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "fixed", label: "Fixed" },
  { id: "everyday", label: "Everyday" },
  { id: "personal", label: "Personal" },
  { id: "savings-goals", label: "Savings & goals" }
];

const ZERO_STATE: BudgetCategoryState = { assignedCents: 0, activityCents: 0, availableCents: 0 };

function afterRun(outcome: RunOutcome, queuedMessage: string): void {
  if (outcome.kind === "queued" || outcome.kind === "already-queued") {
    announce(queuedMessage);
    setTimeout(() => invalidateQueries(), REFETCH_DELAY_MS);
  } else if (outcome.kind === "disabled") {
    announce("Finance is turned off on the server.");
  } else {
    announce(`Request failed: ${outcome.message}`);
  }
}

function Amount(props: { cents: number; key?: string }): ReactNodeLike {
  // Negative available = overspent envelope: reuse the existing amber badge
  // (the module's authored danger token — no new CSS colors).
  if (props.cents < 0) {
    return (
      <Badge tone="amber">
        <span className="fnm-amount">{formatCents(props.cents, BUDGET_CURRENCY)}</span>
      </Badge>
    );
  }
  return <span className="fnm-amount">{formatCents(props.cents, BUDGET_CURRENCY)}</span>;
}

function AssignCell(props: {
  month: string;
  category: BudgetCategory;
  assignedCents: number;
  onAssign: (category: BudgetCategory, amountCents: number) => void;
  key?: string;
}): ReactNodeLike {
  // Draft lives per-row; the parent remounts rows via key={month:categoryId}
  // when the month changes, so the seed value never goes stale.
  const [draft, setDraft] = useState(() => centsToAmountInput(props.assignedCents));
  const commit = (): void => {
    const cents = parseAmountToCents(draft);
    if (cents === null) {
      // Unparseable input: snap back rather than enqueue a bad job.
      setDraft(centsToAmountInput(props.assignedCents));
      announce("Enter a dollar amount up to $1,000,000.");
      return;
    }
    if (cents === props.assignedCents) {
      setDraft(centsToAmountInput(cents));
      return;
    }
    setDraft(centsToAmountInput(cents));
    props.onAssign(props.category, cents);
  };
  return (
    <form
      onSubmit={(event: { preventDefault: () => void }) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        className="jds-input jds-input--sm fnm-amount"
        inputMode="decimal"
        aria-label={`Assigned to ${props.category.name}`}
        value={draft}
        onChange={(event: { target: { value: string } }) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </form>
  );
}

function BudgetBody(props: {
  result: BudgetStatusResult;
  month: string;
  overrides: Record<string, number>;
  onAssign: (category: BudgetCategory, amountCents: number) => void;
}): ReactNodeLike {
  const state = props.result.state;
  const taxonomy = (props.result.categories ?? []).filter((category) => !category.archived);
  if (!state) {
    return (
      <EmptyState
        title="No budget yet"
        body="Budget data appears after the worker computes this month. Try again in a moment."
      />
    );
  }

  // Apply optimistic overrides in-render: an override replaces assigned and
  // shifts available and TBB by the same delta, exactly what the worker's
  // set-semantics ledger write will produce.
  let tbbCents = state.tbbCents;
  const rowState = (categoryId: string): BudgetCategoryState => {
    const base = state.categories[categoryId] ?? ZERO_STATE;
    const override = props.overrides[`${props.month}:${categoryId}`];
    if (override === undefined) return base;
    const delta = override - base.assignedCents;
    return {
      assignedCents: override,
      activityCents: base.activityCents,
      availableCents: base.availableCents + delta
    };
  };
  for (const category of taxonomy) {
    const override = props.overrides[`${props.month}:${category.id}`];
    if (override !== undefined) {
      tbbCents -= override - (state.categories[category.id] ?? ZERO_STATE).assignedCents;
    }
  }

  const hasActivity = Object.keys(state.categories).length > 0;
  return (
    <div className="fnm-stack">
      <div className="fnm-row" aria-label="To be budgeted">
        <span className="jds-eyebrow">To be budgeted</span>
        <Amount cents={tbbCents} />
      </div>
      {!hasActivity && tbbCents === 0 ? (
        <EmptyState
          title={`Nothing to budget in ${monthLabel(props.month)}`}
          body="Sync transactions and categorize income first — money lands here as To be budgeted, then you assign it to envelopes."
        />
      ) : null}
      {BUDGET_GROUPS.map((group) => {
        const rows = taxonomy.filter((category) => category.group === group.id);
        if (rows.length === 0) return null;
        return (
          <section key={group.id} aria-label={group.label}>
            <h3 className="jds-eyebrow">{group.label}</h3>
            <Card flush>
              <table className="fnm-table">
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col" className="fnm-amount">
                      Assigned
                    </th>
                    <th scope="col" className="fnm-amount">
                      Activity
                    </th>
                    <th scope="col" className="fnm-amount">
                      Available
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((category) => {
                    const row = rowState(category.id);
                    return (
                      <tr key={category.id}>
                        <th scope="row">{category.name}</th>
                        <td>
                          <AssignCell
                            key={`${props.month}:${category.id}`}
                            month={props.month}
                            category={category}
                            assignedCents={row.assignedCents}
                            onAssign={props.onAssign}
                          />
                        </td>
                        <td>
                          <Amount cents={row.activityCents} />
                        </td>
                        <td>
                          <Amount cents={row.availableCents} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          </section>
        );
      })}
    </div>
  );
}

export function BudgetScreen(): ReactNodeLike {
  const [month, setMonth] = useState(currentMonth);
  // Optimistic assigns keyed "month:categoryId" — applied over the derived
  // state until the refetch carries the worker's ledger write (a stale
  // override is harmless: set semantics make it the same value).
  const [overrides, setOverrides] = useState<Record<string, number>>({});

  const status = useToolQuery<BudgetStatusResult>("finance.budget.status", { month });

  const assign = (category: BudgetCategory, amountCents: number): void => {
    setOverrides((previous) => ({ ...previous, [`${month}:${category.id}`]: amountCents }));
    void runQueue("finance.budget-apply", "finance.budget-apply", {
      month,
      categoryId: category.id,
      amountCents
    }).then((outcome) =>
      afterRun(
        outcome,
        `Assigned ${formatCents(amountCents, BUDGET_CURRENCY)} to ${category.name}.`
      )
    );
  };

  return (
    <section className="fnm-stack" aria-label="Budget">
      <div className="fnm-row">
        <div className="fnm-chips" role="group" aria-label="Month">
          <Button
            variant="quiet"
            size="sm"
            aria-label="Previous month"
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ←
          </Button>
          <span className="jds-eyebrow">{monthLabel(month)}</span>
          <Button
            variant="quiet"
            size="sm"
            aria-label="Next month"
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            →
          </Button>
        </div>
      </div>
      {outcomeGate(
        status,
        (result) => (
          <BudgetBody result={result} month={month} overrides={overrides} onAssign={assign} />
        ),
        { loadingLabel: "Loading budget" }
      )}
    </section>
  );
}
