// external-modules/finance/src/web/screens/budget.tsx
//
// #3173: the Park Press Budget screen. One read, finance.budget.status, returns the
// month's derived state, the categories, the account balances and the reconciled
// "ready to assign" figure.
//
// #3174: the Assigned cell is a text box. Enter or leaving the box saves through the
// finance.budget-apply queue (the same handler as the chat tool, no approval step).
// The typed amount shows at once; if the refetched total never matches, the box goes
// back to the old amount with an inline error.
//
// Desktop and phone layouts both render; module CSS shows one and hides the other.
import {
  Badge,
  Button,
  DisclosureToggle,
  Eyebrow,
  Indicator,
  Masthead,
  RowIndex,
  RowIndexItem,
  SectionHead,
  StatTile,
  useEffect,
  useRef,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { runQueue } from "../api";
import {
  applyPending,
  checkDelayMs,
  settlePending,
  trackChecks,
  type PendingAssignments
} from "../assign";
import {
  centsToAmountInput,
  currentMonth,
  formatCents,
  monthLabel,
  parseAmountToCents,
  shiftMonth
} from "../format";
import { navigate } from "../router";
import { announce, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";

interface BudgetCategory {
  id: string;
  name: string;
  archived?: boolean;
  tableGroup: string;
}

interface CategoryState {
  assignedCents: number;
  activityCents: number;
  availableCents: number;
}

interface BudgetAccount {
  accountId: string;
  name: string;
  balanceCents: number;
  asOf: string;
  stale: boolean;
}

interface BudgetStatusResult extends Record<string, unknown> {
  month: string;
  state?: { categories: Record<string, CategoryState> };
  categories?: BudgetCategory[];
  accounts?: BudgetAccount[];
  hasBank?: boolean;
  hasBudget?: boolean;
  readyToAssignCents?: number;
  needsLookCount?: number;
}

// Amounts render in the module's single working currency; ledgers merge accounts.
const CURRENCY = "USD";
const money = (cents: number): string => formatCents(cents, CURRENCY);

// Display order. Income and Transfers are not envelopes.
const GROUPS = ["Bills", "Everyday", "Fun", "Savings"] as const;
const NOT_ENVELOPES: ReadonlySet<string> = new Set(["income", "transfers"]);
const ZERO: CategoryState = { assignedCents: 0, activityCents: 0, availableCents: 0 };

interface Line {
  id: string;
  name: string;
  assigned: number;
  spent: number;
  available: number;
  carried: number;
}

interface Group {
  name: string;
  lines: Line[];
}

function buildGroups(result: BudgetStatusResult, pending: PendingAssignments): Group[] {
  const states = result.state?.categories ?? {};
  const categories = (result.categories ?? []).filter(
    (category) => !category.archived && !NOT_ENVELOPES.has(category.id)
  );
  return GROUPS.map((name) => ({
    name,
    lines: categories
      .filter((category) => category.tableGroup === name)
      .map((category): Line => {
        const row = states[category.id] ?? ZERO;
        const shown = applyPending(
          { id: category.id, assigned: row.assignedCents, available: row.availableCents },
          pending
        );
        return {
          id: category.id,
          name: category.name,
          assigned: shown.assigned,
          spent: row.activityCents,
          available: shown.available,
          // available = carried + assigned - spent
          carried: Math.max(0, row.availableCents - row.assignedCents + row.activityCents)
        };
      })
  })).filter((group) => group.lines.length > 0);
}

function Meter(props: { line: Line }): ReactNodeLike {
  const { assigned, spent, available } = props.line;
  const used = assigned <= 0 ? (spent > 0 ? 1 : 0) : Math.min(1, spent / assigned);
  return (
    <div
      className={`jds-progress${available < 0 ? " jds-progress--amber" : ""}`}
      aria-hidden="true"
    >
      <div className="jds-progress__fill" style={{ width: `${Math.round(used * 100)}%` }} />
    </div>
  );
}

function AvailableCell(props: { cents: number; labelled?: boolean }): ReactNodeLike {
  if (props.cents < 0) return <Badge tone="red">{money(-props.cents)} over</Badge>;
  return (
    <strong>
      {money(props.cents)}
      {props.labelled ? " left" : ""}
    </strong>
  );
}

function CarriedBadge(props: { cents: number }): ReactNodeLike {
  if (props.cents <= 0) return null;
  return (
    <div>
      <Badge>{money(props.cents)} carried over</Badge>
    </div>
  );
}

interface AssignProps {
  errors: Record<string, string>;
  onAssign: (line: Line, cents: number) => void;
  onBadAmount: (line: Line) => void;
}

/** The typing box for a category's assigned amount. Saves on Enter or blur. */
function AssignCell(props: { line: Line } & AssignProps): ReactNodeLike {
  const { line, errors } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const finish = (): void => {
    if (draft === null) return;
    const cents = parseAmountToCents(draft);
    setDraft(null);
    if (cents === null) props.onBadAmount(line);
    else if (cents !== line.assigned) props.onAssign(line, cents);
  };
  const error = errors[line.id];
  return (
    <div className="fnm-assign">
      <input
        className="jds-input jds-input--sm fnm-assign__input"
        aria-label={`Assigned to ${line.name}`}
        aria-invalid={error ? "true" : undefined}
        inputMode="decimal"
        value={draft ?? money(line.assigned)}
        onFocus={(event: { currentTarget: { select: () => void } }) => {
          setDraft(centsToAmountInput(line.assigned));
          event.currentTarget.select();
        }}
        onChange={(event: { currentTarget: { value: string } }) =>
          setDraft(event.currentTarget.value)
        }
        onBlur={finish}
        onKeyDown={(event: { key: string; currentTarget: { blur: () => void } }) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(null);
        }}
      />
      {error ? <Indicator status="error" label={error} /> : null}
    </div>
  );
}

function GroupTable(props: { group: Group; head: boolean } & AssignProps): ReactNodeLike {
  const { group } = props;
  const assigned = group.lines.reduce((sum, line) => sum + line.assigned, 0);
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={group.name} meta={`${money(assigned)} assigned`} rule />
      <table className="jds-table fnm-fixed">
        <colgroup>
          <col className="fnm-col-name" />
          <col />
          <col />
          <col />
        </colgroup>
        {props.head ? (
          <thead>
            <tr>
              <th>Category</th>
              <th className="jds-table__num">Assigned</th>
              <th className="jds-table__num">Spent</th>
              <th className="jds-table__num">Available</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {group.lines.map((line) => (
            <tr key={line.id} data-overspent={line.available < 0 ? "true" : undefined}>
              <td>
                <div className="fnm-block fnm-block--tight">
                  <span>{line.name}</span>
                  <CarriedBadge cents={line.carried} />
                </div>
              </td>
              <td className="jds-table__num">
                <AssignCell
                  line={line}
                  errors={props.errors}
                  onAssign={props.onAssign}
                  onBadAmount={props.onBadAmount}
                />
              </td>
              <td className="jds-table__num">
                <div className="fnm-cell-stack">
                  <span>{money(line.spent)}</span>
                  <div className="fnm-cell-meter">
                    <Meter line={line} />
                  </div>
                </div>
              </td>
              <td className="jds-table__num">
                <AvailableCell cents={line.available} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function GroupRows(props: { group: Group } & AssignProps): ReactNodeLike {
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={props.group.name} rule />
      <RowIndex density="compact">
        {props.group.lines.map((line) => (
          <RowIndexItem
            key={line.id}
            title={line.name}
            excerpt={
              <div className="fnm-block fnm-block--tight">
                <CarriedBadge cents={line.carried} />
                <span>{money(line.spent)} spent of</span>
                <AssignCell
                  line={line}
                  errors={props.errors}
                  onAssign={props.onAssign}
                  onBadAmount={props.onBadAmount}
                />
                <Meter line={line} />
              </div>
            }
            meta={<AvailableCell cents={line.available} labelled />}
          />
        ))}
      </RowIndex>
    </section>
  );
}

function asOfLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Sign-in expired";
  return `As of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function BalanceList(props: { accounts: BudgetAccount[] }): ReactNodeLike {
  return (
    <RowIndex variant="facts">
      {props.accounts.map((account) => (
        <RowIndexItem
          key={account.accountId}
          title={account.name}
          meta={
            account.stale ? (
              <div className="fnm-block fnm-block--tight fnm-end">
                <span>{money(account.balanceCents)}</span>
                <Indicator status="error" label={asOfLabel(account.asOf)} />
              </div>
            ) : (
              money(account.balanceCents)
            )
          }
        />
      ))}
    </RowIndex>
  );
}

function RailBlock(props: {
  eyebrow: string;
  title: string;
  children: ReactNodeLike;
}): ReactNodeLike {
  return (
    <section className="fnm-block fnm-block--tight">
      <div className="fnm-block fnm-block--tiny">
        <Eyebrow tone="gold">{props.eyebrow}</Eyebrow>
        <SectionHead title={props.title} rule />
      </div>
      {props.children}
    </section>
  );
}

function NeedsYou(props: { needsLook: number; overspent: number }): ReactNodeLike {
  const total = props.needsLook + props.overspent;
  if (total === 0) return null;
  const showOverspent = (): void => {
    document
      .querySelector("[data-overspent='true']")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return (
    <RailBlock eyebrow="Needs you" title={total === 1 ? "1 thing" : `${total} things`}>
      <div className="fnm-stat-pair">
        <StatTile
          label="Needs a look"
          value={String(props.needsLook)}
          onClick={() => navigate("/transactions")}
        />
        <StatTile label="Overspent" value={String(props.overspent)} warn onClick={showOverspent} />
      </div>
    </RailBlock>
  );
}

function CollapsedBalances(props: { accounts: BudgetAccount[] }): ReactNodeLike {
  const [open, setOpen] = useState(false);
  const total = props.accounts.reduce((sum, account) => sum + account.balanceCents, 0);
  const stale = props.accounts.some((account) => account.stale);
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead
        title={
          <DisclosureToggle expanded={open} controls="fnm-balances" onClick={() => setOpen(!open)}>
            Net worth
          </DisclosureToggle>
        }
        meta={
          <span className="fnm-inline">
            {stale ? <Indicator status="error" label="Sign-in expired" /> : null}
            {money(total)}
          </span>
        }
        rule
      />
      {open ? (
        <div id="fnm-balances">
          <BalanceList accounts={props.accounts} />
        </div>
      ) : null}
    </section>
  );
}

function Hero(props: {
  month: string;
  readyCents: number | null;
  onMonth: (delta: number) => void;
}): ReactNodeLike {
  return (
    <div className="fnm-hero">
      <Masthead
        tone="field"
        eyebrow="Ready to assign"
        title={props.readyCents === null ? "…" : money(props.readyCents)}
        aside={
          <div className="fnm-month-step">
            <Button
              variant="field"
              size="sm"
              aria-label={monthLabel(shiftMonth(props.month, -1))}
              onClick={() => props.onMonth(-1)}
            >
              ←
            </Button>
            <span>{monthLabel(props.month)}</span>
            <Button
              variant="field"
              size="sm"
              aria-label={monthLabel(shiftMonth(props.month, 1))}
              onClick={() => props.onMonth(1)}
            >
              →
            </Button>
          </div>
        }
      />
    </div>
  );
}

function BudgetBody(
  props: { result: BudgetStatusResult; pending: PendingAssignments } & AssignProps
): ReactNodeLike {
  const { result } = props;
  // No bank: Getting started. A bank with no budget rows shows the categories at
  // zero, so the first amounts can be typed here.
  const sendToStart = result.hasBank === false;
  useEffect(() => {
    if (sendToStart) navigate("/start");
  }, [sendToStart]);
  if (sendToStart) return null;

  const groups = buildGroups(result, props.pending);
  const accounts = result.accounts ?? [];
  const overspent = groups.flatMap((group) => group.lines).filter((l) => l.available < 0).length;
  const needsLook = result.needsLookCount ?? 0;
  return (
    <div className="fnm-page">
      <main className="fnm-block">
        <div className="fnm-phone-only">
          <NeedsYou needsLook={needsLook} overspent={overspent} />
        </div>
        {groups.map((group, index) => (
          <div key={group.name}>
            <div className="fnm-desktop-only">
              <GroupTable
                group={group}
                head={index === 0}
                errors={props.errors}
                onAssign={props.onAssign}
                onBadAmount={props.onBadAmount}
              />
            </div>
            <div className="fnm-phone-only">
              <GroupRows
                group={group}
                errors={props.errors}
                onAssign={props.onAssign}
                onBadAmount={props.onBadAmount}
              />
            </div>
          </div>
        ))}
        <div className="fnm-phone-only">
          <CollapsedBalances accounts={accounts} />
        </div>
      </main>
      <aside className="fnm-rail fnm-desktop-only">
        <NeedsYou needsLook={needsLook} overspent={overspent} />
        <RailBlock eyebrow="Accounts" title="Balances">
          <BalanceList accounts={accounts} />
        </RailBlock>
      </aside>
    </div>
  );
}

export function BudgetScreen(): ReactNodeLike {
  const [month, setMonth] = useState(currentMonth);
  const [pending, setPending] = useState<PendingAssignments>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const status = useToolQuery<BudgetStatusResult>("finance.budget.status", { month });
  const armed = useRef(false);
  const checks = useRef<Record<string, number>>({});
  const result =
    status.status === "settled" && status.outcome.kind === "ok" ? status.outcome.result : null;

  // A pending amount belongs to the month it was typed in.
  useEffect(() => {
    setPending({});
    setErrors({});
    armed.current = false;
    checks.current = {};
  }, [month]);

  const scheduleCheck = (attempt = 1): void => {
    setTimeout(() => {
      armed.current = true;
      invalidateQueries();
    }, checkDelayMs(attempt));
  };

  const fail = (line: Line, message: string): void => {
    setPending((previous) => {
      const next = { ...previous };
      delete next[line.id];
      return next;
    });
    setErrors((previous) => ({ ...previous, [line.id]: message }));
    announce(message);
  };

  const onAssign = (line: Line, cents: number): void => {
    setErrors((previous) => {
      const next = { ...previous };
      delete next[line.id];
      return next;
    });
    setPending((previous) => ({ ...previous, [line.id]: cents }));
    checks.current = { ...checks.current, [line.id]: 0 };
    // Metadata-only params: ids and cents, nothing else.
    void runQueue("finance.budget-apply", "finance.budget-apply", {
      month,
      categoryId: line.id,
      amountCents: cents
    }).then((outcome) => {
      if (outcome.kind === "queued" || outcome.kind === "already-queued") scheduleCheck();
      else fail(line, "Couldn't save. Put back to the old amount.");
    });
  };

  const onBadAmount = (line: Line): void => {
    setErrors((previous) => ({ ...previous, [line.id]: "Enter an amount like 250 or 250.50." }));
  };

  // After each armed refetch: drop confirmed amounts, retry a few times, then give up.
  useEffect(() => {
    if (!armed.current || result === null) return;
    armed.current = false;
    const serverAssigned: Record<string, number> = {};
    for (const [id, row] of Object.entries(result.state?.categories ?? {})) {
      serverAssigned[id] = row.assignedCents;
    }
    const { confirmed, mismatched } = settlePending(pending, serverAssigned);
    if (confirmed.length > 0) {
      setPending((previous) => {
        const next = { ...previous };
        for (const id of confirmed) delete next[id];
        return next;
      });
    }
    const step = trackChecks(checks.current, { confirmed, mismatched });
    checks.current = step.counts;
    if (step.retryAttempt > 0) scheduleCheck(step.retryAttempt);
    if (step.giveUp.length > 0) {
      const names = new Map((result.categories ?? []).map((c) => [c.id, c.name]));
      for (const id of step.giveUp) {
        fail(
          { id, name: names.get(id) ?? id, assigned: 0, spent: 0, available: 0, carried: 0 },
          "Couldn't confirm the save. Put back to the old amount."
        );
      }
    }
  }, [status]);

  const baseReady = result?.readyToAssignCents ?? null;
  const pendingShift = Object.entries(pending).reduce(
    (sum, [id, typed]) => sum + (typed - (result?.state?.categories[id]?.assignedCents ?? 0)),
    0
  );
  const ready = baseReady === null ? null : baseReady - pendingShift;
  return (
    <section aria-label="Budget">
      <Hero
        month={month}
        readyCents={ready}
        onMonth={(delta) => setMonth(shiftMonth(month, delta))}
      />
      <div className="fnm-pad">
        {outcomeGate(
          status,
          (body) => (
            <BudgetBody
              result={body}
              pending={pending}
              errors={errors}
              onAssign={onAssign}
              onBadAmount={onBadAmount}
            />
          ),
          {
            loadingLabel: "Loading budget"
          }
        )}
      </div>
    </section>
  );
}
