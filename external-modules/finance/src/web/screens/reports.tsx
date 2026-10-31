// external-modules/finance/src/web/screens/reports.tsx
// FIN-05 (#1150) Task 6: the read-only Reports screen. Two read-risk tool
// queries (finance.reports.spending / finance.reports.net-worth) — this
// screen NEVER writes. Category and payee shares are CSS-width bars; cash flow
// and the net-worth trend use the shared @moss/ui charts.
import {
  Button,
  ColumnChart,
  DisclosureToggle,
  Note,
  SectionHead,
  Select,
  TrendChart,
  useEffect,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { NetWorthHistory } from "../net-worth-history";
import type { NetWorthCoverage } from "../../domain/net-worth-ledger";
import { ReportDetails, type ReportSelection } from "../report-details";
import { fetchUserDirectory } from "../api";
import {
  dayYearLabel,
  formatCents,
  formatCentsCompact,
  monthLabel,
  shortMonthLabel
} from "../format";
import { EmptyState, outcomeGate } from "../states";
import { invalidateToolQueries, useToolQuery } from "../store";
import type { DirectoryUser } from "../household";
// Deep imports on purpose: the domain barrel re-exports keys.ts (node:crypto),
// which the browser-platform web bundle cannot resolve. reports/net-worth are
// pure math modules and safe to bundle.
import {
  mergeSpendingMonths,
  UNCATEGORIZED_BUCKET,
  type MonthSpending
} from "../../domain/reports.js";
import type { NetWorthPoint } from "../../domain/net-worth.js";

const WINDOW_OPTIONS = [3, 6, 12, 24];
const PAYEE_CAP = 12;

interface ReportCategory {
  id: string;
  group: string;
  name: string;
  archived?: boolean;
}

// Wire shapes of the two Task 4 handlers, verbatim. `shared` stays per-owner
// on the wire so this screen can apply the FIN-04 owner check before merging.
interface CurrencyResult extends Record<string, unknown> {
  currencies: string[];
  currency: string | null;
  currencySelectionRequired: boolean;
}

interface SpendingResult extends CurrencyResult {
  window: string[];
  own: MonthSpending[];
  shared: Array<{ ownerUserId: string; months: MonthSpending[] }>;
  categories: ReportCategory[];
}

interface NetWorthResult extends CurrencyResult {
  window: string[];
  points: NetWorthPoint[];
  headlineCents: number | null;
  asOf?: string | null;
  coverage?: NetWorthCoverage[];
  unavailableReason?: "unsafe_money" | "invalid_history";
}

interface BarRow {
  key: string;
  label: string;
  cents: number;
}

/** Sort a byCategory/byPayee record into descending bar rows. */
function toRows(record: Record<string, number>, label: (key: string) => string): BarRow[] {
  return Object.entries(record)
    .map(([key, cents]) => ({ key, label: label(key), cents }))
    .sort((a, b) => b.cents - a.cents);
}

/** Rows past this many fold away on phones behind Show all. */
const PHONE_ROWS = 5;

function BarList(props: {
  id: string;
  rows: BarRow[];
  currency: string;
  onPick: (row: BarRow) => void;
}): ReactNodeLike {
  const [open, setOpen] = useState(false);
  // Widths are relative to the largest magnitude row; the `, 1` floor keeps
  // an all-zero month from dividing by zero.
  const max = Math.max(...props.rows.map((row) => Math.abs(row.cents)), 1);
  return (
    <div>
      <div id={props.id} className={open ? "fnm-report-bars is-open" : "fnm-report-bars"}>
        {props.rows.map((row, index) => (
          <div
            key={row.key}
            className={
              index < PHONE_ROWS
                ? "fnm-report-bar-row"
                : "fnm-report-bar-row fnm-report-bar-row--fold"
            }
          >
            <Button
              variant="link"
              size="sm"
              aria-label={`View ${row.label || "unnamed payee"} transactions`}
              onClick={() => props.onPick(row)}
            >
              {row.label || "Unnamed payee"}
            </Button>
            <div className="jds-progress jds-progress--current fnm-report-bar">
              <div
                className="jds-progress__fill"
                style={{ width: `${Math.round((Math.abs(row.cents) / max) * 100)}%` }}
              />
            </div>
            <span className="fnm-amount">{formatCents(row.cents, props.currency)}</span>
          </div>
        ))}
      </div>
      {props.rows.length > PHONE_ROWS ? (
        <span className="fnm-report-more">
          <DisclosureToggle
            expanded={open}
            controls={props.id}
            className="fnm-disclosure-head"
            onClick={() => setOpen(!open)}
          >
            {open ? `Show top ${PHONE_ROWS}` : `Show all ${props.rows.length}`}
            <span className="fnm-disclosure-marker" aria-hidden="true" />
          </DisclosureToggle>
        </span>
      ) : null}
    </div>
  );
}

function NetWorthSection(props: { result: NetWorthResult }): ReactNodeLike {
  const { points, headlineCents, currency } = props.result;
  if (props.result.unavailableReason)
    return (
      <section className="fnm-block fnm-block--tight" aria-label="Net worth">
        <SectionHead title="Net worth needs review" rule />
        <Note variant="practical">
          {props.result.unavailableReason === "unsafe_money"
            ? "This balance history cannot be totaled without losing precision. Review its amounts, then refresh Reports."
            : "The balance history contains incompatible dates, currencies or amounts. Review opening balances and recorded entries, then refresh Reports."}
        </Note>
      </section>
    );
  return (
    <section className="fnm-block fnm-block--tight" aria-label="Net worth">
      <SectionHead title="Net worth" meta={currency ?? undefined} rule />
      {headlineCents === null || !currency ? (
        <EmptyState
          title="No recorded balance history"
          body="A manual opening balance or a connected balance snapshot is needed in this period. Open sources below to see what is missing."
        />
      ) : (
        <div className="fnm-stack">
          <SectionHead
            title={<span className="fnm-money-wrap">{formatCents(headlineCents, currency)}</span>}
            titleAs="h3"
            meta={
              props.result.asOf ? `As of ${dayYearLabel(props.result.asOf, "short")}` : undefined
            }
          />
          {points.length >= 2 ? (
            <TrendChart
              label="Net worth"
              points={points.map((point) => ({
                at: Date.parse(`${point.date}T00:00:00Z`),
                value: point.totalCents,
                name: dayYearLabel(point.date, "long")
              }))}
              format={(cents) => formatCents(cents, currency)}
              formatTick={(cents) => formatCentsCompact(cents, currency)}
              startLabel={dayYearLabel(points[0]?.date ?? "", "short")}
              endLabel={dayYearLabel(points.at(-1)?.date ?? "", "short")}
            />
          ) : null}
        </div>
      )}
      {currency && props.result.coverage ? (
        <NetWorthHistory
          key={`${currency}:${points[0]?.date}:${points.at(-1)?.date}`}
          coverage={props.result.coverage}
          points={points}
          currency={currency}
        />
      ) : null}
    </section>
  );
}

function SpendingSection(props: {
  result: SpendingResult;
  directory: DirectoryUser[] | null;
  onSelect: (selection: ReportSelection) => void;
}): ReactNodeLike {
  const { window: windowMonths, own, shared, categories, currency } = props.result;
  if (!currency)
    return (
      <EmptyState
        title="No transactions yet"
        body="Spending reports appear after manual entry, import or a connected account brings in transactions."
      />
    );
  const directory = props.directory;
  // FIN-04/#1149 fail-closed posture: a shared contribution merges ONLY when
  // its owner resolves in the user directory. A null directory (fetch failed
  // or not loaded yet) silently degrades to own-only totals — never
  // unattributed household money in the report.
  const resolvable =
    directory === null
      ? []
      : shared.filter((entry) => directory.some((user) => user.id === entry.ownerUserId));
  const merged = mergeSpendingMonths(windowMonths, [
    own,
    ...resolvable.map((entry) => entry.months)
  ]);
  // Window is ascending, so the last merged entry is the current month —
  // the breakdown the bars show (the cash-flow table covers the rest).
  const latest = merged[merged.length - 1];
  if (!latest) {
    return (
      <EmptyState
        title="No transactions yet"
        body="Spending reports appear after manual entry, import or a connected account brings in transactions."
      />
    );
  }
  const select = (
    group: ReportSelection["group"],
    key: string | undefined,
    label: string,
    expectedCents: number,
    month = latest.month
  ) =>
    props.onSelect({
      group,
      ...(key === undefined ? {} : { key }),
      label,
      expectedCents,
      month,
      currency,
      months: windowMonths.length,
      sharedOwnerIds: resolvable.map((entry) => entry.ownerUserId)
    });
  const categoryLabel = (id: string): string =>
    id === UNCATEGORIZED_BUCKET
      ? "Uncategorized"
      : (categories.find((category) => category.id === id)?.name ?? id);
  const categoryRows = toRows(latest.byCategory, categoryLabel);
  const payeeRowsAll = toRows(latest.byPayee, (key) => key);
  const payeeRows = payeeRowsAll.slice(0, PAYEE_CAP);
  return (
    <div className="fnm-stack">
      {resolvable.length > 0 ? (
        <p className="jds-caption">Includes shared household accounts</p>
      ) : null}
      <div className="fnm-report-grid">
        <section className="fnm-block fnm-block--tight" aria-label="Spending by category">
          <SectionHead title="Spending by category" meta={monthLabel(latest.month)} rule />
          {categoryRows.length > 0 ? (
            <BarList
              id="fnm-report-categories"
              rows={categoryRows}
              currency={currency}
              onPick={(row) => select("category", row.key, row.label, row.cents)}
            />
          ) : (
            <EmptyState title="No spending this month" />
          )}
        </section>
        <section className="fnm-block fnm-block--tight" aria-label="Spending by payee">
          <SectionHead title="Spending by payee" meta={monthLabel(latest.month)} rule />
          {payeeRows.length > 0 ? (
            <div className="fnm-stack">
              <BarList
                id="fnm-report-payees"
                rows={payeeRows}
                currency={currency}
                onPick={(row) => select("payee", row.key, row.label || "Unnamed payee", row.cents)}
              />
              {/* Visible caption IS the no-silent-caps disclosure. */}
              {payeeRowsAll.length > PAYEE_CAP ? (
                <p className="jds-caption">Top {PAYEE_CAP} payees</p>
              ) : null}
            </div>
          ) : (
            <EmptyState title="No spending this month" />
          )}
        </section>
      </div>
      <CashFlowSection merged={merged} currency={currency} select={select} />
    </div>
  );
}

type CashFlowSelect = (
  group: ReportSelection["group"],
  key: string | undefined,
  label: string,
  expectedCents: number,
  month: string
) => void;

/** Sum of safe cents, or null when the exact total would lose precision. */
function sumCents(values: readonly number[]): number | null {
  const total = Number(values.reduce((sum, value) => sum + BigInt(value), 0n));
  return Number.isSafeInteger(total) ? total : null;
}

function CashFlowSection(props: {
  merged: ReturnType<typeof mergeSpendingMonths>;
  currency: string;
  select: CashFlowSelect;
}): ReactNodeLike {
  const [showTable, setShowTable] = useState(false);
  const { merged, currency } = props;
  const money = (cents: number) => formatCents(cents, currency);
  const total = (values: number[]) => {
    const cents = sumCents(values);
    return cents === null ? undefined : money(cents);
  };
  const income = merged.map((entry) => entry.cashFlow.incomeCents);
  const outflow = merged.map((entry) => entry.cashFlow.outflowCents);
  const net = merged.map((entry) => entry.cashFlow.netCents);
  return (
    <section className="fnm-block fnm-block--tight" aria-label="Cash flow">
      <SectionHead title="Cash flow" meta={currency} rule />
      <ColumnChart
        label="Cash flow by month"
        categories={merged.map((entry) => shortMonthLabel(entry.month))}
        categoryNames={merged.map((entry) => monthLabel(entry.month))}
        series={[
          { key: "income", label: "Income", values: income, total: total(income) },
          { key: "outflow", label: "Outflow", values: outflow, total: total(outflow) }
        ]}
        marker={{ label: "Net", values: net, total: total(net) }}
        format={money}
        formatTick={(cents) => formatCentsCompact(cents, currency)}
      />
      <DisclosureToggle
        expanded={showTable}
        controls="fnm-cash-flow-months"
        className="fnm-disclosure-head"
        onClick={() => setShowTable(!showTable)}
      >
        Monthly numbers
        <span className="fnm-disclosure-marker" aria-hidden="true" />
      </DisclosureToggle>
      {showTable ? (
        <div id="fnm-cash-flow-months">
          <table className="jds-table fnm-table fnm-desktop-only">
            <thead>
              <tr>
                <th>Month</th>
                <th>Income</th>
                <th>Outflow</th>
                <th>Net</th>
              </tr>
            </thead>
            <tbody>
              {[...merged].reverse().map((entry) => (
                <tr key={entry.month}>
                  <td>{monthLabel(entry.month)}</td>
                  <td className="fnm-amount">
                    <Button
                      variant="link"
                      size="sm"
                      aria-label={`View income for ${monthLabel(entry.month)}`}
                      onClick={() =>
                        props.select(
                          "income",
                          undefined,
                          "Income",
                          entry.cashFlow.incomeCents,
                          entry.month
                        )
                      }
                    >
                      {money(entry.cashFlow.incomeCents)}
                    </Button>
                  </td>
                  <td className="fnm-amount">
                    <Button
                      variant="link"
                      size="sm"
                      aria-label={`View outflow for ${monthLabel(entry.month)}`}
                      onClick={() =>
                        props.select(
                          "outflow",
                          undefined,
                          "Outflow",
                          entry.cashFlow.outflowCents,
                          entry.month
                        )
                      }
                    >
                      {money(entry.cashFlow.outflowCents)}
                    </Button>
                  </td>
                  <td className="fnm-amount">{money(entry.cashFlow.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="fnm-phone-only fnm-block">
            {[...merged].reverse().map((entry) => (
              <section
                key={entry.month}
                className="fnm-report-month"
                aria-label={monthLabel(entry.month)}
              >
                <strong>{monthLabel(entry.month)}</strong>
                <dl>
                  <dt>Income</dt>
                  <dd className="fnm-amount">
                    <Button
                      variant="link"
                      size="sm"
                      aria-label={`View income for ${monthLabel(entry.month)}`}
                      onClick={() =>
                        props.select(
                          "income",
                          undefined,
                          "Income",
                          entry.cashFlow.incomeCents,
                          entry.month
                        )
                      }
                    >
                      {money(entry.cashFlow.incomeCents)}
                    </Button>
                  </dd>
                  <dt>Outflow</dt>
                  <dd className="fnm-amount">
                    <Button
                      variant="link"
                      size="sm"
                      aria-label={`View outflow for ${monthLabel(entry.month)}`}
                      onClick={() =>
                        props.select(
                          "outflow",
                          undefined,
                          "Outflow",
                          entry.cashFlow.outflowCents,
                          entry.month
                        )
                      }
                    >
                      {money(entry.cashFlow.outflowCents)}
                    </Button>
                  </dd>
                  <dt>Net</dt>
                  <dd className="fnm-amount">{money(entry.cashFlow.netCents)}</dd>
                </dl>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function ReportsScreen(): ReactNodeLike {
  const [months, setMonths] = useState(6);
  const [selection, setSelection] = useState<ReportSelection | null>(null);
  const [currency, setCurrency] = useState("");
  // Owner directory for the household merge; null = not loaded / failed, in
  // which case the merge drops every shared contribution (fail closed).
  const [directory, setDirectory] = useState<DirectoryUser[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchUserDirectory().then((users) => {
      if (!cancelled) setDirectory(users);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const input = { months, ...(currency ? { currency } : {}) };
  const spending = useToolQuery<SpendingResult>("finance.reports.spending", input);
  const netWorth = useToolQuery<NetWorthResult>("finance.reports.net-worth", input);
  const [currencies, setCurrencies] = useState<string[]>([]);
  useEffect(() => {
    if (spending.status !== "settled" || netWorth.status !== "settled") return;
    const values = [spending.outcome, netWorth.outcome].flatMap((outcome) =>
      outcome.kind === "ok" ? (outcome.result.currencies ?? []) : []
    );
    setCurrencies([...new Set(values)].sort());
  }, [spending, netWorth]);
  const chooseCurrency = currencies.length > 1 && currency === "";
  return (
    <section className="fnm-block" aria-label="Finance reports">
      <div className="fnm-spread">
        <div className="fnm-chips">
          <Select
            aria-label="Report period"
            value={months}
            onChange={(event: { target: { value: string } }) =>
              setMonths(Number(event.target.value))
            }
          >
            {WINDOW_OPTIONS.map((option) => (
              <option key={option} value={option}>
                Last {option} months
              </option>
            ))}
          </Select>
          {currencies.length > 1 || (currency && !currencies.includes(currency)) ? (
            <Select
              aria-label="Report currency"
              value={currency}
              onChange={(event: { target: { value: string } }) => setCurrency(event.target.value)}
            >
              <option value="" disabled>
                Choose currency
              </option>
              {[...new Set([...currencies, ...(currency ? [currency] : [])])].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            invalidateToolQueries("finance.reports.spending");
            invalidateToolQueries("finance.reports.net-worth");
          }}
        >
          Refresh
        </Button>
      </div>
      {chooseCurrency ? (
        <EmptyState
          title="Choose a currency"
          body="Each currency reports on its own, with no conversion."
        />
      ) : (
        <>
          {outcomeGate(
            netWorth,
            (result) => (
              <NetWorthSection result={result} />
            ),
            {
              loadingLabel: "Loading net worth"
            }
          )}
          {outcomeGate(
            spending,
            (result) => (
              <SpendingSection
                result={result}
                directory={directory}
                onSelect={(scope) => {
                  invalidateToolQueries("finance.reports.transactions");
                  setSelection(scope);
                }}
              />
            ),
            {
              loadingLabel: "Loading spending reports"
            }
          )}
        </>
      )}
      {selection ? (
        <ReportDetails selection={selection} onClose={() => setSelection(null)} />
      ) : null}
    </section>
  );
}
