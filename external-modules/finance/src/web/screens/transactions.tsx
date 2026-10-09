// external-modules/finance/src/web/screens/transactions.tsx
//
// #3176: the Park Press Transactions screen. One read, finance.transactions.query,
// returns the month's rows, the categories, the accounts and the Needs a look count.
// Every write is a single finance.review-apply job: one row (optionally making a merchant
// rule) or Confirm all (the visible Needs a look rows, no rules).
//
// Desktop and phone layouts both render; module CSS shows one and hides the other.
import {
  Badge,
  Button,
  RowIndex,
  RowIndexItem,
  SectionHead,
  Segmented,
  Select,
  Switch,
  useEffect,
  useState,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { runQueue, type RunOutcome } from "../api";
import { currentMonth, dayLabel, formatCents, monthLabel, shiftMonth } from "../format";
import { announce, EmptyState, outcomeGate } from "../states";
import { invalidateQueries, useToolQuery } from "../store";

interface TxCategory {
  id: string;
  name: string;
  archived?: boolean;
}

interface TxAccount {
  accountId: string;
  name: string;
  mask?: string | null;
}

interface Tx {
  id: string;
  accountId: string;
  date: string;
  amountCents: number;
  isoCurrency: string;
  name: string;
  categoryId: string | null;
  reviewState?: "confirmed" | "needs_look";
  shared?: boolean;
}

interface TxResult extends Record<string, unknown> {
  month: string;
  transactions?: Tx[];
  categories?: TxCategory[];
  accounts?: TxAccount[];
  needsLookCount?: number;
}

type Filter = "all" | "look";

const REFETCH_DELAY_MS = 2000;
const SEARCH_DELAY_MS = 300;

const isLook = (tx: Tx): boolean => tx.shared !== true && tx.reviewState === "needs_look";

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

function Amount(props: { tx: Tx }): ReactNodeLike {
  const { tx } = props;
  // Money in is stored negative.
  if (tx.amountCents < 0) return <strong>+{formatCents(-tx.amountCents, tx.isoCurrency)}</strong>;
  return <span>{formatCents(tx.amountCents, tx.isoCurrency)}</span>;
}

// The category picker, Confirm button and merchant switch for one Needs a look row.
function LookControls(props: {
  tx: Tx;
  categories: TxCategory[];
  onConfirm: (tx: Tx, categoryId: string, makeRule: boolean) => void;
}): ReactNodeLike {
  const { tx } = props;
  const [categoryId, setCategoryId] = useState(tx.categoryId ?? "");
  const [makeRule, setMakeRule] = useState(false);
  return (
    <div className="fnm-block fnm-block--tight">
      <div className="fnm-inline">
        <Select
          aria-label={`Category for ${tx.name}`}
          value={categoryId}
          onChange={(event: { target: { value: string } }) => setCategoryId(event.target.value)}
        >
          <option value="" disabled>
            Choose a category
          </option>
          {props.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={categoryId === ""}
          onClick={() => props.onConfirm(tx, categoryId, makeRule)}
        >
          Confirm
        </Button>
      </div>
      <Switch
        ariaLabel={`Always use this category for ${tx.name}`}
        label="Always for this merchant"
        checked={makeRule}
        onChange={setMakeRule}
      />
    </div>
  );
}

interface DayGroup {
  date: string;
  rows: Tx[];
}

function groupByDay(rows: Tx[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const tx of rows) {
    const last = groups.at(-1);
    if (last && last.date === tx.date) last.rows.push(tx);
    else groups.push({ date: tx.date, rows: [tx] });
  }
  return groups;
}

interface RowContext {
  categories: TxCategory[];
  categoryName: (tx: Tx) => string;
  accountName: (tx: Tx) => string;
  confirmed: ReadonlySet<string>;
  onConfirm: (tx: Tx, categoryId: string, makeRule: boolean) => void;
}

function DayTable(props: { day: DayGroup; head: boolean; ctx: RowContext }): ReactNodeLike {
  const { day, ctx } = props;
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={dayLabel(day.date)} rule />
      <table className="jds-table fnm-fixed">
        <colgroup>
          <col className="fnm-col-payee" />
          <col className="fnm-col-category" />
          <col />
          <col className="fnm-col-amount" />
        </colgroup>
        {props.head ? (
          <thead>
            <tr>
              <th>Payee</th>
              <th>Category</th>
              <th>Account</th>
              <th className="jds-table__num">Amount</th>
            </tr>
          </thead>
        ) : null}
        <tbody>
          {day.rows.map((tx) => {
            const look = isLook(tx) && !ctx.confirmed.has(tx.id);
            return (
              <tr key={tx.id}>
                <td>
                  <div className="fnm-block fnm-block--tight">
                    <span>{tx.name}</span>
                    {look ? (
                      <div>
                        <Badge tone="amber">Predicted</Badge>
                      </div>
                    ) : null}
                  </div>
                </td>
                <td>
                  {look ? (
                    <LookControls tx={tx} categories={ctx.categories} onConfirm={ctx.onConfirm} />
                  ) : (
                    ctx.categoryName(tx)
                  )}
                </td>
                <td>{ctx.accountName(tx)}</td>
                <td className="jds-table__num">
                  <Amount tx={tx} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function DayRows(props: { day: DayGroup; ctx: RowContext }): ReactNodeLike {
  const { day, ctx } = props;
  return (
    <section className="fnm-block fnm-block--tight">
      <SectionHead title={dayLabel(day.date)} rule />
      <RowIndex density="compact">
        {day.rows.map((tx) => {
          const look = isLook(tx) && !ctx.confirmed.has(tx.id);
          return (
            <RowIndexItem
              key={tx.id}
              title={tx.name}
              excerpt={
                look ? (
                  <div className="fnm-block fnm-block--tight">
                    <div className="fnm-spread">
                      <Badge tone="amber">Predicted</Badge>
                      <Amount tx={tx} />
                    </div>
                    <LookControls tx={tx} categories={ctx.categories} onConfirm={ctx.onConfirm} />
                  </div>
                ) : (
                  `${ctx.categoryName(tx)} · ${ctx.accountName(tx)}`
                )
              }
              meta={look ? null : <Amount tx={tx} />}
            />
          );
        })}
      </RowIndex>
    </section>
  );
}

function TransactionsBody(props: {
  result: TxResult;
  filter: Filter;
  searching: boolean;
  confirmed: ReadonlySet<string>;
  onConfirm: (tx: Tx, categoryId: string, makeRule: boolean) => void;
}): ReactNodeLike {
  const { result, filter, confirmed } = props;
  const accounts = result.accounts ?? [];
  const categories = result.categories ?? [];
  const live = categories.filter((category) => !category.archived);
  const all = result.transactions ?? [];
  // Rows already confirmed here drop out of the Needs a look filter at once.
  const rows = filter === "look" ? all.filter((tx) => !confirmed.has(tx.id)) : all;
  const ctx: RowContext = {
    categories: live,
    categoryName: (tx) =>
      categories.find((category) => category.id === tx.categoryId)?.name ?? "Uncategorized",
    accountName: (tx) => accounts.find((account) => account.accountId === tx.accountId)?.name ?? "",
    confirmed,
    onConfirm: props.onConfirm
  };
  if (rows.length === 0) {
    if (filter === "look") {
      return <EmptyState title="Nothing needs a look" body="Moss is sure about everything here." />;
    }
    if (props.searching) {
      return <EmptyState title="No matches" body="No transaction in this month matches." />;
    }
    return <EmptyState title="Nothing yet" body="Transactions appear after the first sync." />;
  }
  const days = groupByDay(rows);
  return (
    <div className="fnm-block">
      <div className="fnm-desktop-only fnm-block">
        {days.map((day, index) => (
          <DayTable key={day.date} day={day} head={index === 0} ctx={ctx} />
        ))}
      </div>
      <div className="fnm-phone-only fnm-block">
        {days.map((day) => (
          <DayRows key={day.date} day={day} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

export function TransactionsScreen(): ReactNodeLike {
  const [month, setMonth] = useState(currentMonth);
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  // Rows confirmed here, hidden from Needs a look until the refetch catches up.
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const timer = setTimeout(() => setSearch(draft.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  const query = useToolQuery<TxResult>("finance.transactions.query", {
    month,
    limit: 200,
    ...(search ? { search } : {}),
    ...(filter === "look" ? { needsLookOnly: true } : {})
  });
  const result =
    query.status === "settled" && query.outcome.kind === "ok" ? query.outcome.result : null;

  const send = (rows: Tx[], categoryIds: string[], createRule: boolean, message: string): void => {
    setConfirmed((previous) => new Set([...previous, ...rows.map((row) => row.id)]));
    void runQueue("finance.review-apply", "finance.review-apply", {
      transactionIds: rows.map((row) => row.id),
      accountIds: rows.map((row) => row.accountId),
      months: rows.map(() => month),
      categoryIds,
      ...(createRule ? { createRule: true } : {})
    }).then((outcome) => afterRun(outcome, message));
  };

  const confirmOne = (tx: Tx, categoryId: string, makeRule: boolean): void =>
    send([tx], [categoryId], makeRule, "Confirmed.");

  // Exactly the Needs a look rows on screen: the filter, the search and the month decide them.
  const visibleLook = (result?.transactions ?? []).filter(
    (tx) => isLook(tx) && tx.categoryId !== null && !confirmed.has(tx.id)
  );
  const confirmAll = (): void =>
    send(
      visibleLook,
      visibleLook.map((tx) => tx.categoryId as string),
      false,
      `Confirmed ${visibleLook.length}.`
    );

  // The server counts rows the viewer still sees as Needs a look; take off those confirmed here.
  const stillCounted = (result?.transactions ?? []).filter(
    (tx) => isLook(tx) && confirmed.has(tx.id)
  ).length;
  const lookCount = Math.max(0, (result?.needsLookCount ?? 0) - stillCounted);

  return (
    <section aria-label="Transactions" className="fnm-block">
      <div className="fnm-spread">
        <div className="fnm-inline">
          <Segmented
            ariaLabel="Filter transactions"
            value={filter}
            onChange={(value: Filter) => setFilter(value)}
            options={[
              { value: "all", label: "All" },
              { value: "look", label: `Needs a look (${lookCount})` }
            ]}
          />
          {visibleLook.length > 0 ? (
            <Button variant="secondary" onClick={confirmAll}>
              Confirm all {visibleLook.length}
            </Button>
          ) : null}
        </div>
        <div className="fnm-inline">
          <Button
            variant="field"
            size="sm"
            aria-label={monthLabel(shiftMonth(month, -1))}
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ←
          </Button>
          <span>{monthLabel(month)}</span>
          <Button
            variant="field"
            size="sm"
            aria-label={monthLabel(shiftMonth(month, 1))}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            →
          </Button>
          <input
            className="jds-input fnm-search"
            placeholder="Search payees"
            aria-label="Search payees"
            value={draft}
            onChange={(event: { target: { value: string } }) => setDraft(event.target.value)}
          />
        </div>
      </div>
      {outcomeGate(
        query,
        (data) => (
          <TransactionsBody
            result={data}
            filter={filter}
            searching={search !== ""}
            confirmed={confirmed}
            onConfirm={confirmOne}
          />
        ),
        { loadingLabel: "Loading transactions" }
      )}
    </section>
  );
}
