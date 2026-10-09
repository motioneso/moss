// external-modules/finance/src/web/screens/budget.tsx
//
// #3173: the Park Press Budget screen (read-only). One read, finance.budget.status,
// returns the month's derived state, the categories, the account balances and the
// reconciled "ready to assign" figure. Typing amounts in place lands in #3174.
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
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { currentMonth, formatCents, monthLabel, shiftMonth } from "../format";
import { navigate } from "../router";
import { outcomeGate } from "../states";
import { useToolQuery } from "../store";

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

function buildGroups(result: BudgetStatusResult): Group[] {
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
        return {
          id: category.id,
          name: category.name,
          assigned: row.assignedCents,
          spent: row.activityCents,
          available: row.availableCents,
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

function GroupTable(props: { group: Group; head: boolean }): ReactNodeLike {
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
              <td className="jds-table__num">{money(line.assigned)}</td>
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

function GroupRows(props: { group: Group }): ReactNodeLike {
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
                <span>
                  {money(line.spent)} spent of {money(line.assigned)}
                </span>
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

function BudgetBody(props: { result: BudgetStatusResult }): ReactNodeLike {
  const { result } = props;
  // No bank, or a bank with no budget yet: Getting started owns both.
  const sendToStart = result.hasBank === false || result.hasBudget === false;
  useEffect(() => {
    if (sendToStart) navigate("/start");
  }, [sendToStart]);
  if (sendToStart) return null;

  const groups = buildGroups(result);
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
              <GroupTable group={group} head={index === 0} />
            </div>
            <div className="fnm-phone-only">
              <GroupRows group={group} />
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
  const status = useToolQuery<BudgetStatusResult>("finance.budget.status", { month });
  const ready =
    status.status === "settled" && status.outcome.kind === "ok"
      ? (status.outcome.result.readyToAssignCents ?? null)
      : null;
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
          (result) => (
            <BudgetBody result={result} />
          ),
          {
            loadingLabel: "Loading budget"
          }
        )}
      </div>
    </section>
  );
}
