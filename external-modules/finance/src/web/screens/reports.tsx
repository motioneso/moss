// external-modules/finance/src/web/screens/reports.tsx
// FIN-05 (#1150) Task 6: the read-only Reports screen. Two read-risk tool
// queries (finance.reports.spending / finance.reports.net-worth) — this
// screen NEVER writes. No chart library: category/payee shares are CSS-width
// bars and the net-worth trend is one inline SVG polyline in currentColor,
// so raw colors stay in tokens.css and theme switching costs nothing.
import {
  Button,
  Masthead,
  SectionHead,
  Select,
  useEffect,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { ReportDetails, type ReportSelection } from "../report-details";
import { fetchUserDirectory } from "../api";
import { formatCents, monthLabel } from "../format";
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

/** Scale the ascending point series into a 100×32 viewBox polyline (x 0..100,
 *  y inverted 30..2 with 2px padding; a flat series centers at y=16). */
function trendPoints(points: NetWorthPoint[]): string {
  const totals = points.map((point) => point.totalCents);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  return points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = max === min ? 16 : 30 - ((point.totalCents - min) / (max - min)) * 28;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function BarList(props: {
  rows: BarRow[];
  currency: string;
  onPick: (row: BarRow) => void;
}): ReactNodeLike {
  // Widths are relative to the largest magnitude row; the `, 1` floor keeps
  // an all-zero month from dividing by zero.
  const max = Math.max(...props.rows.map((row) => Math.abs(row.cents)), 1);
  return (
    <div>
      {props.rows.map((row) => (
        <div key={row.key} className="fnm-report-bar-row">
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
  );
}

function NetWorthSection(props: { result: NetWorthResult }): ReactNodeLike {
  const { points, headlineCents, currency } = props.result;
  return (
    <section className="fnm-block fnm-block--tight" aria-label="Net worth">
      <SectionHead number="01" title="Net worth" meta={currency ?? undefined} rule />
      {headlineCents === null || !currency ? (
        <EmptyState
          title="No recorded balance history"
          body="Connected accounts build this chart from saved balance snapshots. Manual ledger history is not yet included."
        />
      ) : (
        <div className="fnm-stack">
          <strong className="fnm-amount">{formatCents(headlineCents, currency)}</strong>
          <p className="jds-caption">
            Recorded account balances; earlier balances carry forward. Accounts without snapshots
            are omitted, including manual ledger accounts.
          </p>
          {/* A polyline needs ≥2 points; a single snapshot day renders the
                headline alone. */}
          {points.length >= 2 ? (
            <svg
              viewBox="0 0 100 32"
              preserveAspectRatio="none"
              className="fnm-report-trend"
              role="img"
              aria-label="Net worth trend"
            >
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                points={trendPoints(points)}
              />
            </svg>
          ) : null}
        </div>
      )}
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
          <SectionHead
            number="02"
            title="Spending by category"
            meta={monthLabel(latest.month)}
            rule
          />
          {categoryRows.length > 0 ? (
            <BarList
              rows={categoryRows}
              currency={currency}
              onPick={(row) => select("category", row.key, row.label, row.cents)}
            />
          ) : (
            <EmptyState title="Nothing this month" body="No spending recorded this month yet." />
          )}
        </section>
        <section className="fnm-block fnm-block--tight" aria-label="Spending by payee">
          <SectionHead number="03" title="Spending by payee" meta={monthLabel(latest.month)} rule />
          {payeeRows.length > 0 ? (
            <div className="fnm-stack">
              <BarList
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
            <EmptyState title="Nothing this month" body="No spending recorded this month yet." />
          )}
        </section>
      </div>
      <section className="fnm-block fnm-block--tight" aria-label="Cash flow">
        <SectionHead number="04" title="Cash flow" meta={currency} rule />
        <p className="jds-caption">
          Includes pending transactions. Refunds reduce outflow; transfers are excluded.
        </p>
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
                      select("income", undefined, "Income", entry.cashFlow.incomeCents, entry.month)
                    }
                  >
                    {formatCents(entry.cashFlow.incomeCents, currency)}
                  </Button>
                </td>
                <td className="fnm-amount">
                  <Button
                    variant="link"
                    size="sm"
                    aria-label={`View outflow for ${monthLabel(entry.month)}`}
                    onClick={() =>
                      select(
                        "outflow",
                        undefined,
                        "Outflow",
                        entry.cashFlow.outflowCents,
                        entry.month
                      )
                    }
                  >
                    {formatCents(entry.cashFlow.outflowCents, currency)}
                  </Button>
                </td>
                <td className="fnm-amount">{formatCents(entry.cashFlow.netCents, currency)}</td>
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
                      select("income", undefined, "Income", entry.cashFlow.incomeCents, entry.month)
                    }
                  >
                    {formatCents(entry.cashFlow.incomeCents, currency)}
                  </Button>
                </dd>
                <dt>Outflow</dt>
                <dd className="fnm-amount">
                  <Button
                    variant="link"
                    size="sm"
                    aria-label={`View outflow for ${monthLabel(entry.month)}`}
                    onClick={() =>
                      select(
                        "outflow",
                        undefined,
                        "Outflow",
                        entry.cashFlow.outflowCents,
                        entry.month
                      )
                    }
                  >
                    {formatCents(entry.cashFlow.outflowCents, currency)}
                  </Button>
                </dd>
                <dt>Net</dt>
                <dd className="fnm-amount">{formatCents(entry.cashFlow.netCents, currency)}</dd>
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
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
      <Masthead
        tone="field"
        eyebrow="Reports"
        title="Follow your money"
        lede="See spending, cash flow and recorded net worth. Open a category, payee or cash-flow amount to inspect its transactions."
      />
      <div className="fnm-row">
        <label className="fnm-catpick">
          <span className="jds-caption">Window</span>
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
        </label>
        <label className="fnm-catpick">
          <span className="jds-caption">Currency</span>
          <Select
            aria-label="Report currency"
            value={currency || (currencies.length === 1 ? currencies[0] : "")}
            onChange={(event: { target: { value: string } }) => setCurrency(event.target.value)}
          >
            <option value="" disabled>
              {currencies.length ? "Choose currency" : "No balances yet"}
            </option>
            {[...new Set([...currencies, ...(currency ? [currency] : [])])].map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div>
        <Button
          variant="secondary"
          onClick={() => {
            invalidateToolQueries("finance.reports.spending");
            invalidateToolQueries("finance.reports.net-worth");
          }}
        >
          Refresh reports
        </Button>
      </div>
      <p className="jds-caption">
        Each currency is shown separately. No exchange-rate conversion is applied.
      </p>
      {chooseCurrency ? (
        <EmptyState
          title="Choose a currency"
          body="Your accounts use more than one currency. Choose one above to see its balances and spending."
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
